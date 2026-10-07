/**
 * The march on the GPU.
 *
 * `walk` in `patch.ts` is two and a half million node-steps, each reading the prediction twice at
 * eight corners — twenty-three million texture reads — and it is the one second a card waits before
 * it shows anything.  Every one of those node-steps is independent of every other within a step, and
 * the smoothing between steps reads a whole grid and writes another, so the whole thing is a compute
 * shader with nothing clever about it: a thousand two hundred dispatches of three thousand threads.
 *
 * What is NOT here is as much the point.  The grid the march starts from (`baseSurface`) stays on the
 * other thread: it is twelve thousand field reads against the march's two and a half million, and it
 * solves for the starting height by Gauss-Seidel, which is sequential by construction — doing it in
 * parallel would be a different answer, not a faster one.  The table and the annotations
 * (`buildPatch`) stay there too; they read nothing and are already a fifth of the cost.
 *
 * The answer is held against the other thread's node by node, which is the only way to know that the
 * port is a port: `scratchpad/pup/march.cjs`, and `?march=cpu` to turn this off.
 */
import type { Vec3 } from "../field";
import type { PatchGrid } from "../patch";
import { STEP_OF_WRAP } from "../patch";
import { MARCH_WGSL } from "./march.wgsl";

/** The prediction over the box the march may reach, as the GPU wants it. */
export interface NormalBox {
  /*
   * Four bytes a voxel, (z, y, x) with x fastest: `nx`, `ny`, nothing, and 255 where the network had
   * something to say — which is what `grad_mag` is read for and the whole of what it is read for.
   */
  data: Uint8Array;
  // Counted (z, y, x), as the scan is stored.
  dims: [number, number, number];
  origin: [number, number, number];
  // Full-resolution voxels to one voxel of this box.
  factor: number;
}

const THREADS = 64;
// What one entry of the per-sample uniform is padded to; WebGPU will not offset into a uniform more
// finely than this.
const SAY_STRIDE = 256;
const SAY_BYTES = 64;

let asked: Promise<GPUDevice | undefined> | undefined;

/**
 * The one device, asked for once.
 *
 * `undefined` for every reason there is — no WebGPU, no adapter, a device that would not come, a
 * device that has since been lost — and every one of them means the same thing to the caller: march
 * on the other thread instead.
 */
export function marchDevice(): Promise<GPUDevice | undefined> {
  if (asked !== undefined) return asked;
  asked = (async () => {
    const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
    if (gpu === undefined) return undefined;
    try {
      const adapter = await gpu.requestAdapter();
      if (adapter === null) return undefined;
      const device = await adapter.requestDevice();
      // A lost device is not an error anybody can act on, so the next ask starts again from nothing.
      device.lost.then(() => {
        if (asked !== undefined) asked = undefined;
      });
      return device;
    } catch {
      return undefined;
    }
  })();
  return asked;
}

interface Ready {
  device: GPUDevice;
  layout: GPUBindGroupLayout;
  onward: GPUComputePipeline;
  hold: GPUComputePipeline;
  store: GPUComputePipeline;
}

let built: Ready | undefined;

function pipelines(device: GPUDevice): Ready {
  if (built !== undefined && built.device === device) return built;
  const layout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform", hasDynamicOffset: true, minBindingSize: SAY_BYTES } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: "uint", viewDimension: "3d" } },
      ...[2, 3, 4, 5, 6, 7].map((binding) => ({
        binding,
        visibility: GPUShaderStage.COMPUTE,
        buffer: { type: "storage" as const },
      })),
    ],
  });
  const module = device.createShaderModule({ code: MARCH_WGSL });
  const of = (entryPoint: string) =>
    device.createComputePipeline({
      layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
      compute: { module, entryPoint },
    });
  built = { device, layout, onward: of("onward"), hold: of("hold"), store: of("store") };
  return built;
}

/**
 * The march, for a grid already laid on the sheet.
 *
 * Takes and returns exactly what `walk` does, so that the two can be swapped and compared: `X` the
 * starting place of every node (z, y, x, `NaN` where there is none), and back the place of every node
 * on every sample either way, with a 1 where it reached.
 */
export async function marchOnGpu(
  box: NormalBox,
  X: Float64Array,
  n0: Vec3,
  grid: PatchGrid,
  reach: number,
  per: number,
  spacing: number,
): Promise<{ P: Float32Array; A: Float32Array } | undefined> {
  const device = await marchDevice();
  if (device === undefined) return undefined;
  const limit = device.limits.maxTextureDimension3D;
  if (box.dims.some((d) => d > limit || d < 2)) return undefined;

  const { nu, nv } = grid;
  const count = nu * nv;
  const layers = 2 * reach + 1;
  // The same two numbers the other thread works out, from the same constant: how far one sample is,
  // and how many steps of the midpoint rule it is taken in.  Worked out again rather than passed in
  // so that `elsewhere` is handed exactly what `walk` is handed, and `STEP_OF_WRAP` is imported
  // rather than repeated so that the two cannot come to disagree about it.
  const each = spacing / per;
  const steps = Math.max(1, Math.round(each / (spacing * STEP_OF_WRAP)));
  const ds = each / steps;

  let scoped = true;
  const made: { destroy(): void }[] = [];
  const keep = <T extends { destroy(): void }>(one: T) => {
    made.push(one);
    return one;
  };
  /*
   * Anything invalid is caught and said out loud.
   *
   * WebGPU does not throw for it: a buffer written with the wrong size, a texture laid out wrongly, a
   * binding that does not fit — each is reported to an error scope and the operation quietly does
   * nothing, which here would mean a piece with no papyrus in it and no sign of why.
   */
  device.pushErrorScope("validation");
  try {
    const { layout, onward, hold, store } = pipelines(device);

    const field = keep(device.createTexture({
      size: { width: box.dims[2], height: box.dims[1], depthOrArrayLayers: box.dims[0] },
      dimension: "3d",
      format: "rgba8uint",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    }));
    device.queue.writeTexture(
      { texture: field },
      box.data,
      { bytesPerRow: box.dims[2] * 4, rowsPerImage: box.dims[1] },
      { width: box.dims[2], height: box.dims[1], depthOrArrayLayers: box.dims[0] },
    );

    const storage = (bytes: number, usage = 0) =>
      keep(device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | usage }));
    const a = storage(count * 16);
    const b = storage(count * 16);
    const came = storage(count * 16);
    const alive = storage(count * 4);
    const outP = storage(layers * count * 3 * 4, GPUBufferUsage.COPY_SRC);
    const outA = storage(layers * count * 4, GPUBufferUsage.COPY_SRC);

    /*
     * One entry per sample of each direction, written once and chosen between with a dynamic offset.
     * Only `dir` and `k` differ along it; the rest is the same every time and is repeated rather than
     * split into a second binding, because a uniform read is free and a second binding is not.
     */
    const say = keep(device.createBuffer({
      size: 2 * reach * SAY_STRIDE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    }));
    const said = new ArrayBuffer(2 * reach * SAY_STRIDE);
    for (const [which, dir] of [[0, 1], [1, -1]] as const) {
      for (let k = 1; k <= reach; k++) {
        const at = (which * reach + (k - 1)) * SAY_STRIDE;
        const f = new Float32Array(said, at, 8);
        const i = new Int32Array(said, at, 8);
        f[0] = dir;
        f[1] = ds;
        i[2] = k;
        i[3] = nu;
        i[4] = nv;
        i[5] = count;
        i[6] = reach;
        f[7] = box.factor;
        new Float32Array(said, at + 32, 3).set(box.origin);
        new Int32Array(said, at + 48, 3).set(box.dims);
      }
    }
    device.queue.writeBuffer(say, 0, said);

    const bind = (cur: GPUBuffer, nxt: GPUBuffer) =>
      device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: { buffer: say, offset: 0, size: SAY_BYTES } },
          { binding: 1, resource: field.createView() },
          { binding: 2, resource: { buffer: cur } },
          { binding: 3, resource: { buffer: nxt } },
          { binding: 4, resource: { buffer: came } },
          { binding: 5, resource: { buffer: alive } },
          { binding: 6, resource: { buffer: outP } },
          { binding: 7, resource: { buffer: outA } },
        ],
      });
    // Two, because the smoothing pass has to read a grid nothing is writing to: the march works in
    // place on whichever is current, the smoothing reads it and writes the other, and they swap.
    const groups = [bind(a, b), bind(b, a)];

    const start = new Float32Array(count * 4);
    const came0 = new Float32Array(count * 4);
    const alive0 = new Uint32Array(count);
    for (let node = 0; node < count; node++) {
      const there = !Number.isNaN(X[node * 3]);
      alive0[node] = there ? 1 : 0;
      if (there) start.set([X[node * 3], X[node * 3 + 1], X[node * 3 + 2]], node * 4);
      came0.set(n0, node * 4);
    }

    const over = Math.ceil(count / THREADS);
    /*
     * One submission for each direction, and the grid put back between them.
     *
     * Not one submission for both: a write to a buffer is a queue operation, so every one of them
     * happens before any of the work that was encoded, however the two are interleaved here.  Both
     * directions in one submission would therefore start the second where the first ended, which
     * marches one way twice and calls it a piece.
     */
    for (const which of [0, 1]) {
      device.queue.writeBuffer(a, 0, start);
      device.queue.writeBuffer(came, 0, came0);
      device.queue.writeBuffer(alive, 0, alive0);
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      let now = 0;
      for (let k = 1; k <= reach; k++) {
        const at = (which * reach + (k - 1)) * SAY_STRIDE;
        for (let step = 0; step < steps; step++) {
          pass.setPipeline(onward);
          pass.setBindGroup(0, groups[now], [at]);
          pass.dispatchWorkgroups(over);
          pass.setPipeline(hold);
          pass.setBindGroup(0, groups[now], [at]);
          pass.dispatchWorkgroups(over);
          now = 1 - now;
        }
        pass.setPipeline(store);
        pass.setBindGroup(0, groups[now], [at]);
        pass.dispatchWorkgroups(over);
      }
      pass.end();
      device.queue.submit([encoder.finish()]);
    }

    const backP = keep(device.createBuffer({
      size: layers * count * 3 * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    }));
    const backA = keep(device.createBuffer({
      size: layers * count * 4,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    }));
    const home = device.createCommandEncoder();
    home.copyBufferToBuffer(outP, 0, backP, 0, backP.size);
    home.copyBufferToBuffer(outA, 0, backA, 0, backA.size);
    device.queue.submit([home.finish()]);

    await Promise.all([backP.mapAsync(GPUMapMode.READ), backA.mapAsync(GPUMapMode.READ)]);
    const P = new Float32Array(backP.getMappedRange()).slice();
    const A = new Float32Array(backA.getMappedRange()).slice();
    backP.unmap();
    backA.unmap();

    /*
     * Whether it marched at all.
     *
     * A shader that answers nothing is the one failure nothing downstream can see: the piece comes
     * out empty, the card draws nothing, and no error is raised anywhere.  So it is checked here,
     * where there is still something to fall back to.
     */
    const wrong = await device.popErrorScope();
    scoped = false;
    if (wrong !== null) {
      console.warn(`The march on the GPU was not valid, so it was walked here instead: ${wrong.message}`);
      return undefined;
    }

    let reached = 0;
    for (let at = 0; at < A.length; at++) if (A[at] > 0.5) reached++;
    if (reached < A.length / 100) {
      console.warn(
        `The march on the GPU reached ${reached} of ${A.length} nodes, so it was walked here instead.` +
          ` box ${box.dims.join("x")} at ${box.origin.join(",")} /${box.factor}, grid ${nu}x${nv},` +
          ` ${reach} samples each way, ${steps} steps of ${ds.toFixed(3)} voxels`,
      );
      return undefined;
    }

    // The middle layer is the grid itself, which the march never steps to and so never stores.
    const middle = reach * count;
    for (let node = 0; node < count; node++) {
      const there = !Number.isNaN(X[node * 3]);
      const o = (middle + node) * 3;
      if (there) {
        P[o] = X[node * 3];
        P[o + 1] = X[node * 3 + 1];
        P[o + 2] = X[node * 3 + 2];
      }
      A[middle + node] = there ? 1 : 0;
    }
    /*
     * And nowhere is said as NaN, which is what the rest of the fit reads it as.
     *
     * Done here rather than in the shader because WGSL will not produce a NaN by any route, and done
     * for every node rather than only the ones the shader skipped because that way the invariant — a
     * position is NaN exactly where its weight is 0 — holds whatever the shader did.
     */
    for (let node = 0; node < layers * count; node++) {
      if (A[node] > 0.5) continue;
      P[node * 3] = NaN;
      P[node * 3 + 1] = NaN;
      P[node * 3 + 2] = NaN;
    }
    return { P, A };
  } catch (error) {
    console.warn("The march could not be run on the GPU:", error);
    return undefined;
  } finally {
    if (scoped) void device.popErrorScope().catch(() => {});
    for (const one of made) one.destroy();
  }
}

/**
 * @file Stage 0 of the WebGPU/TSL rewrite: the four things the design rests on, asked of the real
 * libraries rather than of their documentation.
 *
 * Every answer here changes the plan if it comes back no, so each one is checked by looking at
 * pixels that came all the way through the production path — rendered on the GPU, blitted into a
 * 2-D canvas, read back — rather than by the call not throwing.
 *
 * Throwaway.  Delete once the answers are written down.
 */
import * as THREE from "three/webgpu";
import {
  Fn,
  float,
  instancedArray,
  instanceIndex,
  ivec3,
  texture3D,
  texture3DLoad,
  textureStore,
  uv,
  vec3,
  vec4,
} from "three/tsl";

type Said = { name: string; ok: boolean; detail: string };
const said: Said[] = [];
const say = (name: string, ok: boolean, detail: string) => {
  said.push({ name, ok, detail });
  draw();
};

const out = document.getElementById("out")!;
const shots = document.getElementById("shots")!;
function draw() {
  out.innerHTML =
    "<table>" +
    said
      .map(
        (s) =>
          `<tr><td class="${s.ok ? "ok" : "no"}">${s.ok ? "yes" : "NO "}</td>` +
          `<td>${s.name}</td><td>${s.detail}</td></tr>`,
      )
      .join("") +
    "</table>";
}

// The side of the little volume every check reads, and of the pictures they are checked in.
const N = 8;
const SIDE = 64;

/** A card-sized 2-D canvas, as a real card has. */
function card(label: string) {
  const wrap = document.createElement("div");
  wrap.style.display = "inline-block";
  wrap.style.textAlign = "center";
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = SIDE;
  canvas.style.width = canvas.style.height = `${SIDE * 2}px`;
  const tag = document.createElement("div");
  tag.textContent = label;
  tag.style.fontSize = "10px";
  wrap.append(canvas, tag);
  shots.append(wrap);
  return canvas;
}

async function run() {
  if (!("gpu" in navigator)) {
    say("WebGPU is there", false, "navigator.gpu is undefined");
    return;
  }

  const surface = document.createElement("canvas");
  surface.width = surface.height = SIDE;
  const renderer = new THREE.WebGPURenderer({ canvas: surface, antialias: false });
  renderer.setSize(SIDE, SIDE, false);
  await renderer.init();
  const backend = (renderer as unknown as { backend: Record<string, unknown> }).backend;
  const device = backend?.device as GPUDevice | undefined;
  say(
    "WebGPU is there, and the raw device is reachable",
    device !== undefined,
    device === undefined
      ? "renderer.backend.device is undefined — the escape hatch is shut"
      : `backend ${backend?.constructor?.name ?? "?"}, device ok`,
  );

  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const material = new THREE.MeshBasicNodeMaterial();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  scene.add(quad);

  /** Renders whatever `colorNode` says, blits it into a card, and hands back its pixels. */
  let wrong: string | undefined;
  const shot = async (label: string) => {
    const canvas = card(label);
    wrong = undefined;
    device?.pushErrorScope("validation");
    renderer.render(scene, camera);
    const context = canvas.getContext("2d")!;
    // The same task as the render, which is the whole question in check 5.
    context.clearRect(0, 0, SIDE, SIDE);
    context.drawImage(surface, 0, 0);
    const px = context.getImageData(0, 0, SIDE, SIDE).data;
    /*
     * And whether any of that was valid.  A render pass WebGPU refused leaves the canvas showing the
     * frame before it, which reads as a pass — this spike was fooled by exactly that once.
     */
    const said = await device?.popErrorScope();
    if (said !== null && said !== undefined) wrong = said.message.split("\n")[0].slice(0, 160);
    return px;
  };
  const at = (px: Uint8ClampedArray, x: number, y: number) => {
    const o = (y * SIDE + x) * 4;
    return [px[o], px[o + 1], px[o + 2], px[o + 3]];
  };
  const lit = (px: Uint8ClampedArray) => {
    let n = 0;
    for (let o = 3; o < px.length; o += 4) if (px[o] > 0) n++;
    return n;
  };

  // ---- 1. A 3-D texture of the scan's own kind, sampled with hardware trilinear ---------------
  //
  // A ramp along x and nothing along y or z, so a horizontal gradient is the right answer and a
  // staircase says the filtering did not happen.
  const ramp = new Uint8Array(N * N * N);
  for (let z = 0; z < N; z++)
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) ramp[(z * N + y) * N + x] = Math.round((x / (N - 1)) * 255);
  const scan = new THREE.Data3DTexture(ramp, N, N, N);
  scan.format = THREE.RedFormat;
  scan.type = THREE.UnsignedByteType;
  scan.minFilter = THREE.LinearFilter;
  scan.magFilter = THREE.LinearFilter;
  scan.wrapS = scan.wrapT = scan.wrapR = THREE.ClampToEdgeWrapping;
  scan.unpackAlignment = 1;
  scan.needsUpdate = true;

  try {
    material.colorNode = Fn(() => {
      const v = texture3D(scan, vec3(uv().x, float(0.5), float(0.5))).r;
      return vec4(v, v, v, float(1));
    })();
    material.needsUpdate = true;
    const px = await shot("1 · R8 trilinear");
    const a = at(px, 4, 32)[0], b = at(px, 32, 32)[0], c = at(px, 59, 32)[0];
    // A ramp, and the middle not equal to either end (a staircase of 8 steps would give flats).
    const rising = a < b && b < c;
    const smooth = Math.abs(at(px, 30, 32)[0] - at(px, 34, 32)[0]) > 2;
    say(
      "1 · Data3DTexture (R8) sampled with hardware trilinear in a TSL Fn",
      rising && smooth,
      `across the card: ${a} → ${b} → ${c}${rising && smooth ? "" : " (wanted a smooth rise)"}`,
    );
  } catch (error) {
    say("1 · Data3DTexture (R8) sampled with hardware trilinear in a TSL Fn", false, String(error));
  }

  // ---- 2a. textureLoad on an ordinary texture: does a sampler-less read work at all? ---------
  try {
    material.colorNode = Fn(() => {
      const x = uv().x.mul(N).floor().toInt();
      const v = texture3DLoad(scan, ivec3(x, 0, 0), 0).r;
      return vec4(v, v, v, float(1));
    })();
    material.needsUpdate = true;
    const px = await shot("2a · R8 load");
    const steps = new Set<number>();
    for (let x = 1; x < SIDE - 1; x++) steps.add(at(px, x, 32)[0]);
    say(
      "2a · textureLoad on an R8 3-D texture gives a staircase, not a ramp",
      wrong === undefined && steps.size >= 6 && steps.size <= 10,
      wrong ?? `${steps.size} distinct values across the card (wanted ${N})`,
    );
  } catch (error) {
    say("2a · textureLoad on an R8 3-D texture gives a staircase, not a ramp", false, String(error));
  }

  // ---- 2b. An integer 3-D texture -----------------------------------------------------------
  //
  // The field wants sixteen bits a channel.  `rgba16unorm` is not a core WebGPU format at all (it
  // needs `texture-formats-tier1`), and `rgba16float` has eleven bits of mantissa — 1.6 voxels of
  // error on a three-thousand-voxel box, which is unusable.  So the question is whether the integer
  // formats, which are core, can be read at all.
  const packed = new Uint8Array(N * N * N * 4);
  for (let i = 0; i < N * N * N; i++) {
    packed[i * 4] = (i % N) * 32;
    packed[i * 4 + 3] = 255;
  }
  const field = new THREE.Data3DTexture(packed, N, N, N);
  field.format = THREE.RGBAIntegerFormat;
  field.type = THREE.UnsignedByteType;
  field.minFilter = THREE.NearestFilter;
  field.magFilter = THREE.NearestFilter;
  field.unpackAlignment = 1;
  field.needsUpdate = true;

  try {
    material.colorNode = Fn(() => {
      const x = uv().x.mul(N).floor().toInt();
      const got = texture3DLoad(field, ivec3(x, 0, 0), 0);
      const v = float(got.r).div(255);
      return vec4(v, v, v, float(1));
    })();
    material.needsUpdate = true;
    const px = await shot("2b · rgba8uint load");
    const steps = new Set<number>();
    for (let x = 1; x < SIDE - 1; x++) steps.add(at(px, x, 32)[0]);
    say(
      "2b · an integer (rgba8uint) 3-D texture read by textureLoad",
      wrong === undefined && steps.size >= 6 && steps.size <= 10,
      wrong ?? `${steps.size} distinct values across the card (wanted ${N})`,
    );
  } catch (error) {
    say("2b · an integer (rgba8uint) 3-D texture read by textureLoad", false, String(error));
  }

  // ---- 2c. What the device actually offers ---------------------------------------------------
  {
    const adapter = await (navigator as Navigator & { gpu: GPU }).gpu.requestAdapter();
    const has = (name: string) => adapter?.features.has(name) === true;
    say(
      "2c · the formats the field could use",
      has("texture-formats-tier1") || has("float32-filterable"),
      `texture-formats-tier1 (rgba16unorm): ${has("texture-formats-tier1")} · ` +
        `float32-filterable (rgba32float, 2x the memory): ${has("float32-filterable")}`,
    );
  }

  // ---- 3. Writing one page into a 3-D texture that is already live --------------------------
  //
  // The atlas stands or falls on this: a chunk arriving must write its own 64³ brick without the
  // whole atlas being re-uploaded.
  try {
    const held = (backend as unknown as { get(t: unknown): { texture?: GPUTexture } }).get(scan);
    const gpuTexture = held?.texture;
    if (device === undefined || gpuTexture === undefined) {
      say(
        "3 · one page written into a live 3-D texture",
        false,
        `backend.get(texture).texture is ${gpuTexture === undefined ? "undefined" : "there"}, device ${device === undefined ? "undefined" : "there"}`,
      );
    } else {
      // A 2×8×8 slab of white at x = 0..1, which should show as a white band down the left.
      const page = new Uint8Array(2 * N * N).fill(255);
      device.queue.writeTexture(
        { texture: gpuTexture, origin: { x: 0, y: 0, z: 0 } },
        page,
        { bytesPerRow: 2, rowsPerImage: N },
        { width: 2, height: N, depthOrArrayLayers: N },
      );
      material.colorNode = Fn(() => {
        const v = texture3D(scan, vec3(uv().x, float(0.5), float(0.5))).r;
        return vec4(v, v, v, float(1));
      })();
      material.needsUpdate = true;
      const px = await shot("3 · page written");
      const left = at(px, 2, 32)[0];
      say(
        "3 · one page written into a live 3-D texture (raw queue.writeTexture)",
        left > 240,
        `the left edge reads ${left} (was ${0}, wanted 255)`,
      );
    }
  } catch (error) {
    say("3 · one page written into a live 3-D texture (raw queue.writeTexture)", false, String(error));
  }

  // ---- 4. Compute writes a storage buffer; the fragment shader reads it the same frame -------
  const COUNT = 32;
  try {
    const kept = instancedArray(COUNT, "vec4");
    const fill = Fn(() => {
      const t = float(instanceIndex).div(COUNT - 1);
      kept.element(instanceIndex).assign(vec4(t, t, t, float(1)));
    })().compute(COUNT);
    await renderer.computeAsync(fill);
    material.colorNode = Fn(() => kept.element(uv().x.mul(COUNT - 1).round().toInt()))();
    material.needsUpdate = true;
    const px = await shot("4 · compute → fragment");
    const a = at(px, 1, 32)[0], b = at(px, 32, 32)[0], c = at(px, 62, 32)[0];
    say(
      "4 · compute writes a storage buffer, the fragment shader reads it",
      a < b && b < c && c > 200,
      `across the card: ${a} → ${b} → ${c}`,
    );
  } catch (error) {
    say("4 · compute writes a storage buffer, the fragment shader reads it", false, String(error));
  }

  // ---- 5. Several cards drawn and blitted inside one task ------------------------------------
  //
  // WebGPU presents a canvas at the end of the current task, so the whole board's scheme — one
  // surface, drawn once per card and copied out each time — rests on the copy seeing what was just
  // drawn rather than what is about to be presented.
  try {
    const three: Uint8ClampedArray[] = [];
    for (let k = 0; k < 3; k++) {
      const shade = (k + 1) / 3;
      material.colorNode = Fn(() => vec4(float(shade), float(shade * 0.5), float(0), float(1)))();
      material.needsUpdate = true;
      three.push(await shot(`5 · card ${k + 1}`));
    }
    const reds = three.map((px) => at(px, 32, 32)[0]);
    const filled = three.every((px) => lit(px) === SIDE * SIDE);
    const apart = new Set(reds).size === 3;
    say(
      "5 · three cards drawn and blitted inside one task",
      filled && apart,
      `middles ${reds.join(", ")} · all three full: ${filled}`,
    );
  } catch (error) {
    say("5 · three cards drawn and blitted inside one task", false, String(error));
  }

  // ---- 6. rgba32float, filtered by the hardware -----------------------------------------------
  //
  // The way out of the integer problem: the field in a format three.js does map, with the eight-tap
  // read replaced by the texture unit.  Costs twice the memory of sixteen bits and needs an optional
  // feature, but there is no second data flow — without the feature the same texture is read by
  // `textureLoad` instead, which is one line of shader.
  const floats = new Float32Array(N * N * N * 4);
  for (let i = 0; i < N * N * N; i++) {
    floats[i * 4] = (i % N) / (N - 1);
    floats[i * 4 + 3] = 1;
  }
  const big = new THREE.Data3DTexture(floats as unknown as Uint8Array, N, N, N);
  big.format = THREE.RGBAFormat;
  big.type = THREE.FloatType;
  big.minFilter = THREE.LinearFilter;
  big.magFilter = THREE.LinearFilter;
  big.wrapS = big.wrapT = big.wrapR = THREE.ClampToEdgeWrapping;
  big.needsUpdate = true;
  try {
    material.colorNode = Fn(() => {
      const got = texture3D(big, vec3(uv().x, float(0.5), float(0.5)));
      return vec4(got.r, got.r, got.r, float(1));
    })();
    material.needsUpdate = true;
    const px = await shot("6 · rgba32f trilinear");
    const a = at(px, 4, 32)[0], b = at(px, 32, 32)[0], c = at(px, 59, 32)[0];
    const smooth = Math.abs(at(px, 30, 32)[0] - at(px, 34, 32)[0]) > 2;
    say(
      "6 · rgba32float 3-D texture filtered by the hardware",
      wrong === undefined && a < b && b < c && smooth,
      wrong ?? `across the card: ${a} → ${b} → ${c}`,
    );
  } catch (error) {
    say("6 · rgba32float 3-D texture filtered by the hardware", false, String(error));
  }

  // ---- 7. Sixteen-bit unorm, which this machine has as an optional feature ---------------------
  try {
    const shorts = new Uint16Array(N * N * N * 4);
    for (let i = 0; i < N * N * N; i++) {
      shorts[i * 4] = Math.round(((i % N) / (N - 1)) * 65535);
      shorts[i * 4 + 3] = 65535;
    }
    const half = new THREE.Data3DTexture(shorts as unknown as Uint8Array, N, N, N);
    half.format = THREE.RGBAFormat;
    half.type = THREE.UnsignedShortType;
    half.minFilter = THREE.LinearFilter;
    half.magFilter = THREE.LinearFilter;
    half.needsUpdate = true;
    material.colorNode = Fn(() => {
      const got = texture3D(half, vec3(uv().x, float(0.5), float(0.5)));
      return vec4(got.r, got.r, got.r, float(1));
    })();
    material.needsUpdate = true;
    const px = await shot("7 · rgba16unorm");
    const a = at(px, 4, 32)[0], b = at(px, 32, 32)[0], c = at(px, 59, 32)[0];
    say(
      "7 · rgba16unorm 3-D texture (half the memory of rgba32f)",
      wrong === undefined && a < b && b < c,
      wrong ?? `across the card: ${a} → ${b} → ${c}`,
    );
  } catch (error) {
    say("7 · rgba16unorm 3-D texture (half the memory of rgba32f)", false, String(error));
  }

  // ---- 8. Compute writing straight into a 3-D texture ------------------------------------------
  //
  // If this works the table kernel writes the field in place and nothing is copied at all.
  try {
    const written = new THREE.Storage3DTexture(N, N, N);
    const paint = Fn(() => {
      const z = instanceIndex.div(N * N).toInt();
      const y = instanceIndex.div(N).mod(N).toInt();
      const x = instanceIndex.mod(N).toInt();
      const t = float(x).div(N - 1);
      textureStore(written, ivec3(x, y, z), vec4(t, t, t, float(1)));
    })().compute(N * N * N);
    await renderer.computeAsync(paint);
    material.colorNode = Fn(() => {
      const got = texture3D(written, vec3(uv().x, float(0.5), float(0.5)));
      return vec4(got.r, got.r, got.r, float(1));
    })();
    material.needsUpdate = true;
    const px = await shot("8 · compute → 3-D texture");
    const a = at(px, 4, 32)[0], c = at(px, 59, 32)[0];
    say(
      "8 · a compute shader writing straight into a 3-D texture",
      wrong === undefined && a < c && c > 200,
      wrong ?? `across the card: ${a} → ${c}`,
    );
  } catch (error) {
    say("8 · a compute shader writing straight into a 3-D texture", false, String(error));
  }

  // ---- 9. The combination the field actually needs --------------------------------------------
  //
  // A float storage texture written by compute and then read with the texture unit's own filtering.
  // Checks 6 and 8 each hold on their own; this is the one that matters, because it is the whole
  // path: the fit writes the field in place, and a card reads it as one trilinear fetch.
  try {
    const live = new THREE.Storage3DTexture(N, N, N);
    live.format = THREE.RGBAFormat;
    live.type = THREE.FloatType;
    live.minFilter = THREE.LinearFilter;
    live.magFilter = THREE.LinearFilter;
    const paint = Fn(() => {
      const z = instanceIndex.div(N * N).toInt();
      const y = instanceIndex.div(N).mod(N).toInt();
      const x = instanceIndex.mod(N).toInt();
      const t = float(x).div(N - 1);
      textureStore(live, ivec3(x, y, z), vec4(t, t, t, float(1)));
    })().compute(N * N * N);
    await renderer.computeAsync(paint);
    material.colorNode = Fn(() => {
      const got = texture3D(live, vec3(uv().x, float(0.5), float(0.5)));
      return vec4(got.r, got.r, got.r, float(1));
    })();
    material.needsUpdate = true;
    const px = await shot("9 · rgba32f storage, filtered");
    const a = at(px, 4, 32)[0], b = at(px, 32, 32)[0], c = at(px, 59, 32)[0];
    const smooth = Math.abs(at(px, 30, 32)[0] - at(px, 34, 32)[0]) > 2;
    say(
      "9 · an rgba32float storage texture written by compute, read with hardware filtering",
      wrong === undefined && a < b && b < c && smooth,
      wrong ?? `across the card: ${a} → ${b} → ${c}${smooth ? "" : " (not filtered — a staircase)"}`,
    );
  } catch (error) {
    say("9 · an rgba32float storage texture written by compute, read with hardware filtering", false, String(error));
  }

  (window as unknown as { __spike: Said[] }).__spike = said;
  (window as unknown as { __spikeDone: boolean }).__spikeDone = true;
}

run().catch((error) => {
  say("the spike itself", false, String(error));
  (window as unknown as { __spike: Said[] }).__spike = said;
  (window as unknown as { __spikeDone: boolean }).__spikeDone = true;
});

/**
 * @file Cells by the hundred: two pools of positions, cells of eight indices into each, one draw
 * call a view.
 *
 * A single cell (`cell.ts`) is a table of two by two by two, drawn the way a march is.  That is the
 * right thing for one cell and the wrong thing for a board of them: every cell a texture, a
 * material, a pager of its own.  Here the board is held the way an OBJ file holds a mesh, and drawn
 * in one pass, every view.
 *
 * The OBJ analogy is exact, and it is the design.  An OBJ file lists positions (`v`) and texture
 * coordinates (`vt`), and a face names, for each of its corners, one of each.  The mesh is drawn at
 * the interpolated positions and the texture is read at the interpolated coordinates.  Here there
 * are SAMPLE positions — where a corner is in the scroll, in voxels, which is where the scan is
 * READ — and LAID positions — where it is in the space the cells are laid out flat in, which is
 * where it is DRAWN.  The scan is the texture, three-dimensional; a sample position is its texture
 * coordinate, three-dimensional too.  A cell names eight of each, numbered `u + 2v + 4w` as
 * `cell.ts` numbers its corners.
 *
 * Keeping the two index lists apart, as OBJ does, is what makes the board tear and glue like paper:
 *
 *   - Two cells naming the same laid position are glued where they are drawn.  Naming the same
 *     sample position too, they are one piece of papyrus; naming different ones, they are two
 *     fragments a hand has joined — laid side by side, each reading its own place in the scroll.
 *   - Tearing is the inverse: a corner's laid index is given a copy of its own, and the two sides
 *     may be pulled apart, their pictures going with them.  Tearing a SAMPLE index alone leaves the
 *     layout whole and lets one cell be pointed at another place in the scroll — a march that went
 *     to the wrong winding is fixed by hand without disturbing the sheet around it.
 *
 * All of that is a few indices rewritten (`setCell`); no picture is copied, because no cell owns one.
 *
 * Two kinds of dragging follow, and both are wanted.  Moving a laid position moves where a cell is
 * drawn with its picture stuck to it — clay — and costs nothing but sixteen bytes, because no new
 * data is read.  Moving a sample position moves where a cell reads — re-annotating — and the pages
 * under the new place have to come, which may take a moment, as it did for a cell alone.  Both
 * kinds of position are in voxels of the full-resolution scan, so that a length in one space can be
 * held against the same length in the other: a flattening that stretches nothing has every edge
 * the same length in both.
 *
 * Two meshes draw the same buffers.  `mesh` is the cells as boxes, faces showing the scan, drawn at
 * their sample positions — or, with `morph` toward 1, on the way to their laid ones, which is the
 * flattening as an animation.  `flat` is the plane `z = W` of the laid-out space cut through every
 * cell: each cell's share of it is the layer `w` of that cell where its laid-out box crosses the
 * plane, coloured by the scan at the same layer of its sample box.  Turning `W` is sliding through
 * the sheets — visiting each cell's own layer — which is what the slice cards do for a plane of
 * the scan.
 */
import * as THREE from "three/webgpu";
import {
  Discard,
  Fn,
  If,
  float,
  instanceIndex,
  instancedArray,
  mix,
  positionGeometry,
  uint,
  uniform,
  varying,
  vec3,
  vec4,
} from "three/tsl";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import type { Point } from "#src/gpu/cell.js";
import type { Device } from "#src/gpu/device.js";
import { packPage, pagesUnder } from "#src/gpu/pages.js";
import type { Order } from "#src/gpu/pages.js";
import type { scanOf } from "#src/gpu/sample.js";
import type { Scan } from "#src/gpu/scan.js";
import type { Scale } from "#src/gpu/slice.js";
import { Wanting } from "#src/gpu/wanting.js";
import type { Wanted } from "#src/gpu/wanting.js";
import type { RenderLayer } from "#src/render/layer.js";
import type { WatchableValueInterface } from "#src/state/trackable_value.js";
import { WatchableValue } from "#src/state/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";

// What a TSL node looks like to TypeScript; see `sample.ts`.
type Num = any;

/** How much room to make.  The buffers on the GPU are sized once. */
export interface CellsOptions {
  // Cells, and positions of each kind.
  cells?: number;
  samples?: number;
  laids?: number;
}

/** The space a view looks at the cells in: where they read, or where they are laid out. */
export type Space = "sample" | "laid";

// How finely a box or a square is divided for its surface to follow the trilinear map.
const SEGMENTS = 6;
// How many scales are asked for under a cell: its finest, and the two coarser it shows meanwhile.
const SCALES_WANTED = 3;
/*
 * The most pages the cells may order at once.  The atlas holds a thousand, and the slice cards on
 * the board want theirs; past this every cell is drawn one scale coarser, which is four to eight
 * times fewer pages, until the order fits.  A cell too small on screen to show the finer scale loses
 * nothing by it; a large one loses a little sharpness rather than the whole board losing its pages.
 */
const PAGES_MOST = 600;
// How far outside a cell's own layer range a fragment of the plane may be and still be drawn.
const EDGE = 1e-4;
// Where a cell's eight laid indices start within its sixteen.
const LAID = 8;

/** One kind of position: a buffer of them, and which are in use. */
class Pool {
  readonly data: Float32Array;
  high = 0;
  readonly free: number[] = [];

  constructor(
    readonly capacity: number,
    readonly what: string,
  ) {
    this.data = new Float32Array(capacity * 4);
  }

  get count() {
    return this.high - this.free.length;
  }

  add({ x, y, z }: Point): number {
    const i = this.free.pop() ?? this.high++;
    if (i >= this.capacity) {
      this.high--;
      throw new Error(`No room for another ${this.what} position: ${this.capacity} is all that was made (CellsOptions).`);
    }
    this.data.set([x, y, z, 1], i * 4);
    return i;
  }

  remove(i: number) {
    this.check(i);
    this.data.fill(0, i * 4, i * 4 + 4);
    if (i === this.high - 1) this.high--;
    else this.free.push(i);
  }

  set(i: number, { x, y, z }: Point) {
    this.check(i);
    const { data } = this;
    data[i * 4] = x;
    data[i * 4 + 1] = y;
    data[i * 4 + 2] = z;
  }

  get(i: number): Point {
    this.check(i);
    const { data } = this;
    return { x: data[i * 4], y: data[i * 4 + 1], z: data[i * 4 + 2] };
  }

  check(i: number) {
    if (!(Number.isInteger(i) && i >= 0 && i < this.high && this.data[i * 4 + 3] > 0.5)) {
      throw new Error(`There is no ${this.what} position ${i}.`);
    }
  }
}

export class Cells extends RefCounted {
  /** The cells as boxes in the scroll's voxels, faces showing the scan.  Add it to a scene. */
  readonly mesh: THREE.Mesh;
  /**
   * The plane `z = W` of the laid-out space, cut through every cell: the cells laid flat, at layer
   * `W`.  Add it to a scene looked at from above; set `W` with `setLayer`.
   */
  readonly flat: THREE.Mesh;
  /**
   * The same layer, drawn where it reads: each cell's share of the plane as a surface in the scroll.
   * Beside `mesh` in a scene of the scroll, it is the sheet being flattened, seen where it lies —
   * whether the papyrus is on the layer the hand is working is the one thing the hand has to see.
   */
  readonly sheet: THREE.Mesh;

  private readonly samples: Pool;
  private readonly laids: Pool;
  // Sixteen a cell: eight sample indices, then eight laid indices.
  private readonly cellData: Uint32Array;
  // Four a cell: the finest scale it may draw, whether it is alive, and two spare.
  private readonly infoData: Float32Array;
  private readonly buffers: THREE.BufferAttribute[];
  private readonly cellCapacity: number;
  private readonly W = uniform(0);
  private readonly morphUniform = uniform(0);
  private readonly wanting: Wanting;

  private freeCells: number[] = [];
  // One past the highest cell in use: how many instances are drawn.
  private cellHigh = 0;
  // What changed since the last frame: the buffers to send up, the order to place again.
  private buffersDirty = false;
  private orderDirty = true;
  // Which meshes were in a scene at the last order; one added or removed since is a new order.
  private shown = "";
  // How many voxels of the scroll one screen pixel covers, in each space a view looks through.
  private readonly looks = new Map<Space, number>();
  // The chunks last asked for, so that an order that changed no chunk asks for none.
  private wantedKey = "";

  constructor(
    private readonly device: Device,
    chunkManager: ChunkManager,
    layer: WatchableValueInterface<RenderLayer | undefined>,
    private readonly shader: ReturnType<typeof scanOf>,
    private readonly scan: Scan,
    { cells = 1024, samples = 8192, laids = 8192 }: CellsOptions = {},
  ) {
    super();
    this.cellCapacity = cells;
    this.samples = new Pool(samples, "sample");
    this.laids = new Pool(laids, "laid");
    this.cellData = new Uint32Array(cells * 16);
    this.infoData = new Float32Array(cells * 4);
    /*
     * `vec4`, not `vec3`: three.js pads a storage `vec3` to four and rewrites the attribute's own
     * array to match, which would leave the arrays above pointing at nothing.
     */
    const sample = instancedArray(this.samples.data, "vec4");
    const laid = instancedArray(this.laids.data, "vec4");
    const cell = instancedArray(this.cellData, "uint");
    const info = instancedArray(this.infoData, "vec4");
    this.buffers = [sample, laid, cell, info].map(
      (one) => (one as unknown as { value: THREE.BufferAttribute }).value,
    );
    // Visible for the asking: the cells are wherever their meshes are drawn.
    this.wanting = this.registerDisposer(
      new Wanting(chunkManager, layer, new WatchableValue(Number.POSITIVE_INFINITY)),
    );
    this.registerDisposer(() => scan.forget(this));

    const { shapes, box, flat, sheet } = this.materials(sample, laid, cell, info);
    this.mesh = new THREE.Mesh(shapes.box, box);
    this.flat = new THREE.Mesh(shapes.flat, flat);
    this.sheet = new THREE.Mesh(shapes.sheet, sheet);
    // The shaders size them; three.js's own culling would judge a unit box instead.
    this.mesh.frustumCulled = this.flat.frustumCulled = this.sheet.frustumCulled = false;
    this.registerDisposer(() => {
      for (const shape of Object.values(shapes)) shape.dispose();
      box.dispose();
      flat.dispose();
      sheet.dispose();
    });
    // Everything changed since the last frame goes up as the frame starts, before any card draws.
    this.registerDisposer(device.frameStarted.add(() => this.flush()));
  }

  /** How many cells and positions there is room for. */
  get capacity() {
    return { cells: this.cellCapacity, samples: this.samples.capacity, laids: this.laids.capacity };
  }

  /** How many cells and positions are in use. */
  get count() {
    return {
      cells: this.cellHigh - this.freeCells.length,
      samples: this.samples.count,
      laids: this.laids.count,
    };
  }

  /** Adds a place in the scroll a corner reads, and answers its index. */
  addSample(point: Point): number {
    const i = this.samples.add(point);
    this.changed(true);
    return i;
  }

  /** Adds a place in the laid-out space a corner is drawn at, and answers its index. */
  addLaid(point: Point): number {
    const i = this.laids.add(point);
    this.changed(true);
    return i;
  }

  /** Frees a sample position.  The cells naming it should have gone, or been pointed elsewhere, first. */
  removeSample(i: number) {
    this.samples.remove(i);
    this.changed(true);
  }

  /** Frees a laid position.  The cells naming it should have gone, or been pointed elsewhere, first. */
  removeLaid(i: number) {
    this.laids.remove(i);
    this.changed(true);
  }

  sampleOf(i: number): Point {
    return this.samples.get(i);
  }

  laidOf(i: number): Point {
    return this.laids.get(i);
  }

  /**
   * Moves where the corners naming sample `i` read.  Their cells show the scan at the new place on
   * the next frame — as much of it as is resident; the rest is asked for and arrives after.
   */
  setSample(i: number, point: Point) {
    this.samples.set(i, point);
    this.changed(true);
  }

  /**
   * Moves where the corners naming laid `i` are drawn, their pictures going with them.  Nothing is
   * read anew, so this is as immediate as the frame: the clay.
   */
  setLaid(i: number, point: Point) {
    this.laids.set(i, point);
    // Where a cell is drawn says which cells the plane `W` cuts, so the order is placed again.
    this.changed(true);
  }

  /**
   * Adds a cell: eight sample indices and eight laid indices, each numbered `u + 2v + 4w`, and
   * answers the cell's index.  Cells naming the same index share that position.
   */
  addCell(samples: ArrayLike<number>, laids: ArrayLike<number>): number {
    const c = this.freeCells.pop() ?? this.cellHigh++;
    if (c >= this.cellCapacity) {
      this.cellHigh--;
      throw new Error(`No room for another cell: ${this.cellCapacity} is all that was made (CellsOptions.cells).`);
    }
    this.infoData.set([0, 1, 0, 0], c * 4);
    try {
      this.setCell(c, samples, laids);
    } catch (error) {
      this.removeCell(c);
      throw error;
    }
    return c;
  }

  /**
   * Points cell `c` at other positions.  This is how cells are glued and torn: glued, when two name
   * the same index; torn, when one is given an index of its own (`addLaid(laidOf(i))`, say).
   */
  setCell(c: number, samples: ArrayLike<number>, laids: ArrayLike<number>) {
    this.check(c);
    if (samples.length !== 8 || laids.length !== 8) {
      throw new Error(`A cell has eight corners, not ${samples.length} and ${laids.length}.`);
    }
    for (let k = 0; k < 8; k++) {
      this.samples.check(samples[k]);
      this.laids.check(laids[k]);
    }
    for (let k = 0; k < 8; k++) {
      this.cellData[c * 16 + k] = samples[k];
      this.cellData[c * 16 + LAID + k] = laids[k];
    }
    this.changed(true);
  }

  /** Removes a cell.  Its positions stay, for the cells that share them. */
  removeCell(c: number) {
    this.check(c);
    this.infoData[c * 4 + 1] = 0;
    if (c === this.cellHigh - 1) this.cellHigh--;
    else this.freeCells.push(c);
    this.changed(true);
  }

  /** The eight sample indices of cell `c`. */
  samplesOf(c: number): number[] {
    this.check(c);
    return Array.from(this.cellData.subarray(c * 16, c * 16 + 8));
  }

  /** The eight laid indices of cell `c`. */
  laidsOf(c: number): number[] {
    this.check(c);
    return Array.from(this.cellData.subarray(c * 16 + LAID, c * 16 + 16));
  }

  /** Whether cell `c` is there. */
  has(c: number) {
    return Number.isInteger(c) && c >= 0 && c < this.cellHigh && this.infoData[c * 4 + 1] > 0.5;
  }

  /** The layer `flat` shows: the plane `z = W` of the laid-out space, in voxels. */
  get layer() {
    return this.W.value as number;
  }

  /** Turns to layer `W`.  A uniform and the pages the plane now lands in; nothing is computed. */
  setLayer(W: number) {
    this.W.value = W;
    this.changed(false);
  }

  /** How far `mesh` is drawn toward where it is laid out: 0 where it reads, 1 where it is laid. */
  get morph() {
    return this.morphUniform.value as number;
  }

  set morph(t: number) {
    this.morphUniform.value = t;
    this.device.redraw();
  }

  /**
   * Says how closely a view looks: how many voxels of the scroll one of its screen pixels covers,
   * through `space` — for a view of `flat`, a laid-out unit per pixel; for a view of `mesh`, a voxel.
   * Each cell is then drawn, and its pages ordered, at the scale nearest a texel a pixel, which is
   * what keeps a board of hundreds within the atlas.  Never said, every cell is drawn at the finest.
   */
  look(space: Space, voxelsPerPixel: number) {
    this.looks.set(space, voxelsPerPixel);
    this.changed(false);
  }

  /** Whether every chunk of the finest scale under the cells has arrived, and the order is placed. */
  isReady() {
    if (this.orderDirty) return false;
    return this.wantedKey === "" || this.wanting.settled();
  }

  /** The box of the scroll every cell's sample corners bound, or `undefined` with no cell. */
  bounds(): { lower: Point; upper: Point } | undefined {
    const lower = [Infinity, Infinity, Infinity], upper = [-Infinity, -Infinity, -Infinity];
    let any = false;
    for (let c = 0; c < this.cellHigh; c++) {
      if (!this.has(c)) continue;
      any = true;
      this.aabbOf(c, "sample", lower, upper);
    }
    if (!any) return undefined;
    return {
      lower: { x: lower[0], y: lower[1], z: lower[2] },
      upper: { x: upper[0], y: upper[1], z: upper[2] },
    };
  }

  private check(c: number) {
    if (!this.has(c)) throw new Error(`There is no cell ${c}.`);
  }

  private changed(buffers: boolean) {
    if (buffers) this.buffersDirty = true;
    this.orderDirty = true;
    this.device.redraw();
  }

  // As the frame starts: the buffers go up, the instance counts are set, the order is placed.
  private flush() {
    if (this.wasDisposed) return;
    if (this.buffersDirty) {
      this.buffersDirty = false;
      for (const buffer of this.buffers) buffer.needsUpdate = true;
      for (const mesh of [this.mesh, this.flat, this.sheet]) {
        (mesh.geometry as THREE.InstancedBufferGeometry).instanceCount = this.cellHigh;
      }
    }
    const shown = `${this.mesh.parent !== null}|${this.flat.parent !== null}|${this.sheet.parent !== null}`;
    if (this.orderDirty || shown !== this.shown) {
      this.orderDirty = false;
      this.shown = shown;
      this.order();
    }
  }

  // The position of corner `k` of cell `c`, in `space`, as an offset into that pool's data.
  private at(c: number, k: number, space: Space) {
    return this.cellData[c * 16 + (space === "laid" ? LAID : 0) + k] * 4;
  }

  private poolOf(space: Space) {
    return space === "laid" ? this.laids.data : this.samples.data;
  }

  // Widens `lower`/`upper` to the corners of cell `c` in `space`.
  private aabbOf(c: number, space: Space, lower: number[], upper: number[]) {
    const data = this.poolOf(space);
    for (let k = 0; k < 8; k++) {
      const o = this.at(c, k, space);
      for (let i = 0; i < 3; i++) {
        lower[i] = Math.min(lower[i], data[o + i]);
        upper[i] = Math.max(upper[i], data[o + i]);
      }
    }
  }

  // The trilinear blend of cell `c`'s corners in `space`, written into `out`.
  private blend(c: number, space: Space, u: number, v: number, w: number, out: number[]) {
    const data = this.poolOf(space);
    out[0] = out[1] = out[2] = 0;
    for (let k = 0; k < 8; k++) {
      const weight = (k & 1 ? u : 1 - u) * (k & 2 ? v : 1 - v) * (k & 4 ? w : 1 - w);
      if (weight === 0) continue;
      const o = this.at(c, k, space);
      for (let i = 0; i < 3; i++) out[i] += weight * data[o + i];
    }
  }

  // The sum of the twelve edge lengths of cell `c` in `space`.
  private girth(c: number, space: Space) {
    const data = this.poolOf(space);
    let sum = 0;
    for (let k = 0; k < 8; k++)
      for (const bit of [1, 2, 4]) {
        if (k & bit) continue;
        const a = this.at(c, k, space), b = this.at(c, k | bit, space);
        sum += Math.hypot(data[b] - data[a], data[b + 1] - data[a + 1], data[b + 2] - data[a + 2]);
      }
    return sum;
  }

  /*
   * The scale at which a voxel is nearest a pixel: the rule the slice cards follow, so that a cell
   * beside a slice of the same place shows the same detail.
   */
  private levelFor(voxelsPerPixel: number): number {
    const { scales } = this.scan;
    const target = voxelsPerPixel * 1.1;
    let level = scales.length - 1;
    while (level > 0) {
      const size = scales[level].factor, finer = scales[level - 1].factor;
      if (!(size > target)) break;
      if (!(Math.abs(target - finer) < Math.abs(target - size))) break;
      level--;
    }
    return level;
  }

  /**
   * Places the cells' order with the scan, and asks the queue for their chunks.
   *
   * What is wanted is what is drawn.  With `mesh` in a scene, every face of every cell may be
   * looked at, so every page under every cell is cut.  With `flat` or `sheet` in a scene, the plane
   * `W` crosses some cells, and the pages under each one's share of it are cut — and the rest of
   * those cells, and the cells a layer either side, are near: where a hand turning through the
   * layers is going.  Each cell's scale is the finest its views want, coarsened all together while
   * the order would not fit the atlas.
   */
  private order() {
    const showBox = this.mesh.parent !== null;
    const showFlat = this.flat.parent !== null || this.sheet.parent !== null;
    const { scales } = this.scan;
    const W = this.layer;
    const atSample = this.looks.get("sample");
    const atLaid = this.looks.get("laid");
    // Per cell: the finest scale its views want, its box in the scroll, whether it is cut or near,
    // and the box of its share of the plane.
    const wantedLevel = new Int8Array(this.cellHigh);
    const lower: number[][] = [], upper: number[][] = [];
    const cut = new Uint8Array(this.cellHigh), near = new Uint8Array(this.cellHigh);
    const sheetLower: number[][] = [], sheetUpper: number[][] = [];
    const point = [0, 0, 0];
    for (let c = 0; c < this.cellHigh; c++) {
      if (!this.has(c)) continue;
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      this.aabbOf(c, "sample", lo, hi);
      lower[c] = lo;
      upper[c] = hi;
      const wants: number[] = [];
      if (showBox && atSample !== undefined) wants.push(this.levelFor(atSample));
      if (showFlat && atLaid !== undefined) {
        // A laid-out unit on screen covers this many voxels: the cell's stretch, times the zoom.
        const stretch = this.girth(c, "sample") / Math.max(1e-6, this.girth(c, "laid"));
        wants.push(this.levelFor(atLaid * stretch));
      }
      wantedLevel[c] = wants.length > 0 ? Math.min(...wants) : 0;
      if (showBox) cut[c] = 1;
      if (!showFlat) continue;
      /*
       * Where the plane crosses this cell, sampled across it: at each (u, v) the layer `w` at which
       * the laid-out box reaches `z = W`, and the place in the scroll that layer reads.
       */
      const sLower = [Infinity, Infinity, Infinity], sUpper = [-Infinity, -Infinity, -Infinity];
      let crossed = false;
      const N = 3;
      for (let j = 0; j < N; j++)
        for (let i = 0; i < N; i++) {
          const u = i / (N - 1), v = j / (N - 1);
          this.blend(c, "laid", u, v, 0, point);
          const bottom = point[2];
          this.blend(c, "laid", u, v, 1, point);
          const top = point[2];
          const w = (W - bottom) / (top - bottom);
          if (!(w >= -EDGE && w <= 1 + EDGE)) continue;
          crossed = true;
          this.blend(c, "sample", u, v, Math.min(1, Math.max(0, w)), point);
          for (let a = 0; a < 3; a++) {
            sLower[a] = Math.min(sLower[a], point[a]);
            sUpper[a] = Math.max(sUpper[a], point[a]);
          }
        }
      if (crossed) {
        sheetLower[c] = sLower;
        sheetUpper[c] = sUpper;
        near[c] = 1;
      } else {
        // A layer either side: within its own thickness of the plane.
        const lLo = [Infinity, Infinity, Infinity], lHi = [-Infinity, -Infinity, -Infinity];
        this.aabbOf(c, "laid", lLo, lHi);
        const thick = Math.max(1e-6, lHi[2] - lLo[2]);
        if (W >= lLo[2] - thick && W <= lHi[2] + thick) near[c] = 1;
      }
    }

    // The order with every cell `coarser` scales down from what it wants, and how many pages it cuts.
    const place = (coarser: number) => {
      const cutSets = new Map<number, Set<number>>(), nearSets = new Map<number, Set<number>>();
      const setOf = (sets: Map<number, Set<number>>, level: number) => {
        let set = sets.get(level);
        if (set === undefined) sets.set(level, (set = new Set()));
        return set;
      };
      let pages = 0;
      for (let c = 0; c < this.cellHigh; c++) {
        if (!this.has(c)) continue;
        const finest = Math.min(scales.length - 1, wantedLevel[c] + coarser);
        this.infoData[c * 4] = finest;
        const lo = lower[c] as [number, number, number], hi = upper[c] as [number, number, number];
        for (let level = finest; level < Math.min(scales.length, finest + SCALES_WANTED); level++) {
          const scale = scales[level];
          if (cut[c] === 1) {
            const set = setOf(cutSets, level);
            for (const page of pagesUnder(lo, hi, scale)) {
              if (!set.has(page)) {
                set.add(page);
                pages++;
              }
            }
            continue;
          }
          if (sheetLower[c] !== undefined) {
            const set = setOf(cutSets, level);
            const sheet = pagesUnder(
              sheetLower[c] as [number, number, number],
              sheetUpper[c] as [number, number, number],
              scale,
            );
            for (const page of sheet) {
              if (!set.has(page)) {
                set.add(page);
                pages++;
              }
            }
          }
          if (near[c] === 1) {
            const set = setOf(nearSets, level);
            for (const page of pagesUnder(lo, hi, scale)) set.add(page);
          }
        }
      }
      const orders = new Map<number, Order>();
      for (const [level, set] of cutSets) orders.set(level, { cut: [...set], near: [] });
      for (const [level, set] of nearSets) {
        const order = orders.get(level) ?? { cut: [], near: [] };
        const already = cutSets.get(level);
        order.near = [...set].filter((page) => !already?.has(page));
        orders.set(level, order);
      }
      return { orders, pages };
    };
    let coarser = 0;
    let placed = place(0);
    while (placed.pages > PAGES_MOST && coarser < scales.length - 1) placed = place(++coarser);
    // The scale each cell is drawn at went into `info`, which has to go up with the frame.
    this.buffers[3].needsUpdate = true;
    this.scan.order(this, placed.orders);
    this.want(placed.orders, lower, upper, cut, near);
  }

  /*
   * Asks the queue for the chunks under every cell that is cut or near, at the levels its pages were
   * ordered at.  One list for the board, and only when it changed: every call is a message to the
   * worker and a new wish list for the queue.
   */
  private want(
    orders: Map<number, Order>,
    lower: number[][],
    upper: number[][],
    cut: Uint8Array,
    near: Uint8Array,
  ) {
    const wanted: Wanted[] = [];
    const levels = [...orders.keys()].sort((a, b) => a - b);
    const keys: string[] = [];
    for (const level of levels) {
      const scale = this.scan.scales[level];
      const size = this.scan.chunkSizeOf(level);
      const found = new Set<number>();
      for (let c = 0; c < this.cellHigh; c++) {
        if (!this.has(c) || (cut[c] === 0 && near[c] === 0)) continue;
        for (const chunk of chunksUnder(lower[c], upper[c], scale, size)) found.add(chunk);
      }
      const sorted = [...found].sort((a, b) => a - b);
      const chunks = new Float32Array(sorted.length * 3);
      sorted.forEach((packed, n) => {
        chunks[n * 3] = packed & 1023;
        chunks[n * 3 + 1] = (packed >> 10) & 1023;
        chunks[n * 3 + 2] = (packed >> 20) & 1023;
      });
      wanted.push({ level, factor: scale.factor, chunks });
      keys.push(`${level}:${sorted.join(",")}`);
    }
    const key = keys.join("|");
    if (key === this.wantedKey) return;
    this.wantedKey = key;
    this.wanting.want(wanted);
  }

  /**
   * The two materials, and the geometries they are put on.
   *
   * Both draw a unit shape pulled into each cell's shape in the vertex program — a box for `mesh`, a
   * square for `flat` — and both colour a fragment by reading the scan at the trilinear blend of
   * the cell's SAMPLE corners at that fragment's (u, v, w), whichever space the shape was drawn in.
   * The (u, v, w) goes from vertex to fragment as a varying: it is linear over each small triangle
   * of the shape, so interpolating it is exact, where interpolating a position blended from eight
   * corners would not be.  The blends themselves are done in floating point from the buffers, never
   * by a texture unit, whose few bits of weight were a voxel of error on a cell a page wide.
   */
  private materials(sample: Num, laid: Num, cell: Num, info: Num) {
    const { shader, scan } = this;
    const cornerOf = (from: Num, start: number, c: Num, k: number) =>
      from.element(cell.element(c.mul(uint(16)).add(uint(start + k)))).xyz;
    const blendOf = (from: Num, start: number) =>
      Fn(([c, t]: Num[]) => {
        const corner = (k: number) => cornerOf(from, start, c, k);
        const back = mix(mix(corner(0), corner(1), t.x), mix(corner(2), corner(3), t.x), t.y);
        const front = mix(mix(corner(4), corner(5), t.x), mix(corner(6), corner(7), t.x), t.y);
        return mix(back, front, t.z);
      });
    const blendSample = blendOf(sample, 0);
    const blendLaid = blendOf(laid, LAID);
    const gone = (c: Num) => info.element(c).y.lessThan(0.5);

    /*
     * The colour at a cell's (u, v, w): the scan at the blend of its sample corners, read at the
     * finest resident scale no finer than the cell's own, as every card reads.  Outside the scroll
     * there is nothing, and nothing is drawn — a cell pulled past the edge shows the board through.
     */
    const colourAt = (uvw: Num) =>
      Fn(() => {
        const c = instanceIndex;
        const voxel: Num = blendSample(c, uvw).toVar();
        const edge = vec3(...scan.scales[0].upper).sub(0.5);
        If(voxel.lessThan(vec3(-0.5)).any().or(voxel.greaterThanEqual(edge).any()), () => {
          Discard();
        });
        const finest = info.element(c).x.toVar();
        const grey = float(0.5).toVar();
        const found = float(0).toVar();
        for (const scale of scan.scales) {
          If(found.equal(0).and(float(scale.level).greaterThanEqual(finest)), () => {
            const got = shader.at(
              uint(scan.source),
              uint(scale.level),
              float(scale.factor),
              vec3(...scale.upper),
              voxel,
            );
            If(got.y.greaterThan(0), () => {
              grey.assign(got.x);
              found.assign(1);
            });
          });
        }
        return vec4(grey, grey, grey, float(1));
      })();

    // The box: the unit cube's own place is the (u, v, w), drawn between the two spaces.
    const box = new THREE.MeshBasicNodeMaterial();
    box.side = THREE.DoubleSide;
    {
      const uvw = varying(positionGeometry.add(0.5), "cellBoxUVW");
      box.positionNode = Fn(() => {
        const c = instanceIndex;
        const at = mix(blendSample(c, uvw), blendLaid(c, uvw), this.morphUniform).toVar();
        // A cell that has gone collapses to a point and draws nothing.
        If(gone(c), () => {
          at.assign(vec3(0));
        });
        return at;
      })();
      box.colorNode = colourAt(uvw);
    }

    /*
     * The plane: a square's (u, v) is the cell's, and its w is where the cell's laid-out box
     * reaches `z = W` along that (u, v) — found from the bottom and top faces' heights there, which
     * is exact for a box whose bottom and top are flat and a close thing otherwise.  Where that w is
     * outside the cell the plane misses it, and the fragment is dropped; a cell the plane misses
     * entirely draws nothing.
     */
    const planeUVW = (name: string) =>
      varying(
        Fn(() => {
          const c = instanceIndex;
          const uv = positionGeometry.xy.add(0.5);
          const height = (k: number) => cornerOf(laid, LAID, c, k).z;
          const bottom = mix(mix(height(0), height(1), uv.x), mix(height(2), height(3), uv.x), uv.y);
          const top = mix(mix(height(4), height(5), uv.x), mix(height(6), height(7), uv.x), uv.y);
          // A box with no height here is one the plane cannot be inside.
          const thick = top.sub(bottom).toVar();
          If(thick.abs().lessThan(1e-9), () => {
            thick.assign(1e-9);
          });
          return vec3(uv.x, uv.y, this.W.sub(bottom).div(thick));
        })(),
        name,
      );
    // The plane's share of each cell, drawn in `space`: laid out flat, or where it reads.
    const planeIn = (blend: Num, name: string) => {
      const material = new THREE.MeshBasicNodeMaterial();
      material.side = THREE.DoubleSide;
      const uvw = planeUVW(name);
      material.positionNode = Fn(() => {
        const c = instanceIndex;
        const at = blend(c, uvw).toVar();
        If(gone(c), () => {
          at.assign(vec3(0));
        });
        return at;
      })();
      material.colorNode = Fn(() => {
        If(uvw.z.lessThan(-EDGE).or(uvw.z.greaterThan(1 + EDGE)), () => {
          Discard();
        });
        return colourAt(uvw);
      })();
      return material;
    };
    const flat = planeIn(blendLaid, "cellFlatUVW");
    const sheet = planeIn(blendSample, "cellSheetUVW");

    const instanced = (of: THREE.BufferGeometry) => {
      const geometry = new THREE.InstancedBufferGeometry();
      geometry.copy(of as THREE.InstancedBufferGeometry);
      geometry.instanceCount = 0;
      of.dispose();
      return geometry;
    };
    const shapes = {
      box: instanced(new THREE.BoxGeometry(1, 1, 1, SEGMENTS, SEGMENTS, SEGMENTS)),
      flat: instanced(new THREE.PlaneGeometry(1, 1, SEGMENTS, SEGMENTS)),
      sheet: instanced(new THREE.PlaneGeometry(1, 1, SEGMENTS, SEGMENTS)),
    };
    return { shapes, box, flat, sheet };
  }
}

/** Every chunk of `scale` under a box of the scroll, packed as pages are: x, then y, then z. */
function chunksUnder(
  lower: number[],
  upper: number[],
  scale: Scale,
  size: [number, number, number],
): number[] {
  const lo = [0, 0, 0], hi = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    lo[i] = Math.max(0, Math.floor(((lower[i] + 0.5) / scale.factor - 0.5) / size[i]));
    hi[i] = Math.min(
      Math.ceil(scale.upper[i] / size[i]) - 1,
      Math.floor(((upper[i] + 0.5) / scale.factor - 0.5) / size[i]),
    );
  }
  const chunks: number[] = [];
  for (let z = lo[2]; z <= hi[2]; z++)
    for (let y = lo[1]; y <= hi[1]; y++)
      for (let x = lo[0]; x <= hi[0]; x++) chunks.push(packPage(x, y, z));
  return chunks;
}

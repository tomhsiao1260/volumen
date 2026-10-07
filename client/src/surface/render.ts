/**
 * @file Drawing a plane of a piece of sheet: every pixel is a point of the piece (`patch.ts`), and
 * its grey is the scan there (trilinear).  Where the chunks of the level asked for have not arrived,
 * a coarser level that has them is used, so that a card shows something at once and sharpens as the
 * data comes in.
 *
 * The three planes are the sheet's own, as XY, XZ and YZ are the scan's:
 *
 *   UV  the sheet itself, laid flat: u across it, v down the scroll
 *   UW  across the sheets along u: each sheet a band, straight where the flattening is right
 *   VW  across the sheets along v
 *
 * In UW and VW the sheet the card is on is in the middle, so a correct piece shows its sheets as
 * level bands however the papyrus curves — and the way across them is spread by DISTANCE and not by
 * winding (`acrossSheets`), so that the papyrus is drawn at one scale all the way across.
 */

import type { Vec3 } from "./field";
import type { Patch } from "./patch";
import { coverageAt, positionAt } from "./patch";
import type { ZarrLevel } from "./store";

export type SurfacePlane = "uv" | "uw" | "vw";

type Chunk = [number, number, number];

/**
 * Where pixel (row, column) of `plane` sits in the piece: the sheet, and the point on it.  `w` is the
 * sheet the card is on and `span` how many sheets either side of it the cross-sections show.
 */
function mapping(
  patch: Patch,
  plane: SurfacePlane,
  w: number,
  width: number,
  height: number,
  // Where each equal step across the picture falls, in sheets (`acrossSheets`).
  spread: number[],
  /*
   * Where along the axis a cut does NOT show it is taken, 0 to 1 across the grid.
   *
   * A cut along u is one row of the grid and a cut along v one column, and until there was a way to
   * say which, it was always the middle one: the card could be moved through the stack, which it
   * already shows the whole of, and never along the papyrus, which it cannot show at all.
   */
  pin = 0.5,
) {
  const lastU = patch.nu - 1, lastV = patch.nv - 1;
  const alongU = (c: number) => ((c + 0.5) / width) * lastU;
  const alongV = (r: number) => ((r + 0.5) / height) * lastV;
  const sheetAt = (f: number) => {
    if (spread.length < 2) return w;
    const at = Math.min(spread.length - 1, Math.max(0, f * (spread.length - 1)));
    const i = Math.min(spread.length - 2, Math.floor(at));
    return spread[i] + (at - i) * (spread[i + 1] - spread[i]);
  };
  /*
   * On a cut the sheets always stack DOWNWARDS, whichever way the cut runs along the papyrus.
   *
   * They used to stack downwards on one cut and out to the right on the other, which kept u and v
   * each on the axis they have on the flat card — tidy on paper, and wrong in the hand: the same
   * movement through the stack was an up-and-down pull on one card and a sideways one on the other.
   * The axis through the papyrus is the one a person is travelling along, so it is the one that gets
   * the screen's own direction of travel, on both.
   */
  const acrossRow = (r: number) => sheetAt((r + 0.5) / height);
  if (plane === "uw") return (r: number, c: number) => [acrossRow(r), pin * lastV, alongU(c)];
  if (plane === "vw")
    return (r: number, c: number) => [acrossRow(r), ((c + 0.5) / width) * lastV, pin * lastU];
  return (r: number, c: number) => [w, alongV(r), alongU(c)];
}

// How many steps the across-the-sheets map is held at.  Two a sheet over ten sheets is finer than the
// table it is measured from, and the map between them is smooth.
const ACROSS_STEPS = 64;

/**
 * The whole table walked once, down the middle of the piece: how far through the papyrus each sheet
 * is, from one end of the table to the other.
 *
 * A cut gives every sheet the same width of card, and a sheet is not the same thickness everywhere:
 * the march converges where the papyrus is concave, so measured down the middle of one real piece a
 * half-wrap ran from 8.7 voxels to 31.3, three and a half times over.  Drawn by winding, the thin
 * part is magnified three and a half times against the thick part — one band of the picture pulled
 * wide and smeared while the rest is sharp, which is what this is for.
 *
 * Measured once down the middle of the piece rather than per pixel, so the map is the same for every
 * row of the card: a sheet stays a straight band, and only the spacing between bands changes.
 */
export function acrossWalk(patch: Patch) {
  const gi = (patch.nv - 1) / 2, gj = (patch.nu - 1) / 2;
  const out = new Float64Array(3);
  const sheets: number[] = [], walked: number[] = [];
  let last: number[] | undefined;
  let total = 0;
  for (let k = -patch.K * ACROSS_STEPS; k <= patch.K * ACROSS_STEPS; k++) {
    const sheet = k / ACROSS_STEPS;
    const here = positionAt(patch, sheet, gi, gj, out) ? [out[0], out[1], out[2]] : undefined;
    if (sheets.length > 0)
      // Where the piece has nothing the winding's own step stands in, so the walk keeps going.
      total +=
        here === undefined || last === undefined
          ? 30 / ACROSS_STEPS
          : Math.hypot(here[0] - last[0], here[1] - last[1], here[2] - last[2]);
    if (here !== undefined) last = here;
    sheets.push(sheet);
    walked.push(total);
  }
  return { sheets, walked };
}

/**
 * And the map for one card: where each equal step across the cut falls, in sheets, reaching `wanted`
 * voxels of papyrus either side of the sheet shown.
 *
 * A lookup in the walk and nothing else.  It used to walk the table afresh every time it was asked,
 * which is every frame of a slide and — worse — once for every annotation point the card is asked
 * about: a hundred points came to sixty thousand lookups into the table on every change.
 */
export type Walked = { sheets: number[]; walked: number[] };

// How far through the papyrus a sheet is, in voxels, along the walk.
export function farOf(walk: Walked, sheet: number) {
  const { sheets, walked } = walk;
  const n = sheets.length;
  const at = Math.min(n - 1, Math.max(0, (sheet - sheets[0]) * ACROSS_STEPS));
  const i = Math.min(n - 2, Math.floor(at));
  return walked[i] + (at - i) * (walked[i + 1] - walked[i]);
}

/**
 * And the sheet at a distance along it.
 *
 * Past the ends the walk is carried on at the rate it finished at, rather than held at the last
 * sheet.  Held, the picture would repeat that sheet down the rest of the card — a smeared band
 * exactly where the point is to have none; carried on, those places are off the piece and draw as
 * nothing, which says plainly that the table does not reach that far.
 */
export function sheetOf(walk: Walked, far: number) {
  const { sheets, walked } = walk;
  const n = sheets.length;
  const edge = (lo: number, hi: number) => {
    const run = walked[hi] - walked[lo];
    return sheets[hi] + (run > 0 ? (far - walked[hi]) / run : 0) * (sheets[hi] - sheets[lo]);
  };
  if (far <= walked[0]) return edge(1, 0);
  if (far >= walked[n - 1]) return edge(n - 2, n - 1);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (walked[mid] <= far) lo = mid;
    else hi = mid;
  }
  const run = walked[hi] - walked[lo];
  return sheets[lo] + (run > 0 ? (far - walked[lo]) / run : 0) * (sheets[hi] - sheets[lo]);
}

export function acrossSheets(walk: Walked, w: number, wanted: number) {
  const { sheets, walked } = walk;
  const n = sheets.length;
  if (n < 2) return [w];
  const here = farOf(walk, w);
  const reach = Math.min(wanted, Math.max(here - walked[0], walked[n - 1] - here));
  if (!(reach > 0)) return [w];
  const even: number[] = [];
  for (let t = 0; t <= ACROSS_STEPS; t++)
    even.push(sheetOf(walk, here + ((2 * reach * t) / ACROSS_STEPS - reach)));
  return even;
}

/**
 * And the other way: where a sheet falls across a cut, 0 to 1.  The card needs it to put a place in
 * the frame, and it has to be the same map the picture was drawn with.
 */
export function acrossAt(spread: number[], w: number) {
  if (spread.length < 2) return 0.5;
  if (w <= spread[0]) return 0;
  if (w >= spread[spread.length - 1]) return 1;
  for (let i = 0; i + 1 < spread.length; i++) {
    if (w > spread[i + 1]) continue;
    const run = spread[i + 1] - spread[i];
    return (i + (run > 0 ? (w - spread[i]) / run : 0)) / (spread.length - 1);
  }
  return 1;
}

/**
 * How many sheets either side of its own a cut should show, so that it is drawn at the same scale
 * both ways: a square of papyrus as a square, and the grain of it running true.
 *
 * One axis of a cut runs along the sheet, and how much of the scan that covers is decided — it is
 * the piece's own width or height.  The other runs across the sheets, and nothing decides it, so it
 * is decided here: enough wraps that a pixel of it is worth the same as a pixel of the other.  Held
 * under what the table actually holds, so that a cut never asks for a sheet that was never walked;
 * where that bites, the picture is still stretched, and the only cure for that is a deeper table.
 */
export function acrossWanted(patch: Patch, plane: SurfacePlane, width: number, height: number) {
  if (plane === "uv" || !(width > 0) || !(height > 0)) return Infinity;
  // The voxels one pixel of the along-the-sheet axis is worth, and the pixels the other axis has.
  // Both cuts run their own axis across the card and the sheets down it, so both measure the same way.
  const along = (plane === "uw" ? (patch.nu - 1) * patch.hu : (patch.nv - 1) * patch.hv) / width;
  return (height * along) / 2;
}

/**
 * Where a point of a drawn frame sits in the piece — `fx` and `fy` being 0 to 1 across and down it,
 * `w` the sheet the card is on.  It is `mapping` asked about one point instead of every pixel, for
 * turning a place pointed at on the card into a place in the scan.
 */
export function pieceAt(
  patch: Patch,
  plane: SurfacePlane,
  w: number,
  fx: number,
  fy: number,
  // The same map the frame was drawn with, or the answer is about another picture.
  spread: number[],
) {
  const [sheet, gi, gj] = mapping(patch, plane, w, 1, 1, spread)(fy - 0.5, fx - 0.5);
  return { w: sheet, gi, gj };
}

/**
 * A cut of the piece as one picture: the papyrus along the sheet by the distance through it, at a
 * voxel a sample, for the whole of the walk.
 *
 * This is what a cut card shows, and the whole of what it shows.  A cut along u is drawn at the
 * middle row of the grid and a cut along v at the middle column (`mapping`), so neither of them
 * needs a volume — each is one picture, and asking for another sheet only moves the window on it.
 * Three hundred and thirty-eight by four hundred and eighty is a hundred and sixty kilobytes, which
 * is small enough to resample in a moment, hold in the page, and hand to `drawImage` as a source
 * rectangle: a pull is then a picture being panned, which is a thing browsers already do perfectly.
 *
 * The distance axis is uniform in VOXELS, not in windings — the papyrus is not the same thickness
 * everywhere, and a picture uniform in windings would be pre-stretched by exactly the amount
 * `acrossSheets` exists to undo.
 */
export interface FlatCut {
  points: Float32Array;
  wide: number;
  tall: number;
  // The distance along the walk at the first and last sample of the across-the-sheets axis.
  lo: number;
  hi: number;
  // How much papyrus the along-the-sheet axis covers, in voxels.
  along: number;
  step: number;
}

export function flatCut(patch: Patch, walk: Walked, plane: SurfacePlane, step: number): FlatCut {
  const along = plane === "uw" ? (patch.nu - 1) * patch.hu : (patch.nv - 1) * patch.hv;
  const lo = walk.walked[0], hi = walk.walked[walk.walked.length - 1];
  const n = Math.max(2, Math.min(4096, Math.round(along / step)));
  const across = Math.max(2, Math.min(4096, Math.round((hi - lo) / step)));
  // Along the papyrus across the card, through it down the card — the same on both cuts.
  const [wide, tall] = [n, across];
  const points = new Float32Array(wide * tall * 3).fill(NaN);
  const out = new Float64Array(3);
  const middle = plane === "uw" ? (patch.nv - 1) / 2 : (patch.nu - 1) / 2;
  for (let k = 0; k < across; k++) {
    const sheet = sheetOf(walk, lo + ((hi - lo) * k) / (across - 1));
    for (let t = 0; t < n; t++) {
      const at = ((plane === "uw" ? patch.nu - 1 : patch.nv - 1) * t) / (n - 1);
      const gi = plane === "uw" ? middle : at;
      const gj = plane === "uw" ? at : middle;
      if (!positionAt(patch, sheet, gi, gj, out)) continue;
      const o = (k * wide + t) * 3;
      points[o] = out[0];
      points[o + 1] = out[1];
      points[o + 2] = out[2];
    }
  }
  return { points, wide, tall, lo, hi, along, step };
}

// The chunks a cut reads, by the box each patch of it falls in.
export function cutChunks(cut: FlatCut, level: ZarrLevel) {
  const f = level.factor;
  const keys = new Map<string, [number, number, number]>();
  const lo = [0, 0, 0], hi = [0, 0, 0];
  const BLOCK = 16;
  for (let y = 0; y < cut.tall; y += BLOCK)
    for (let x = 0; x < cut.wide; x += BLOCK) {
      lo.fill(Infinity);
      hi.fill(-Infinity);
      let any = false;
      for (let j = y; j < Math.min(y + BLOCK + 1, cut.tall); j++)
        for (let i = x; i < Math.min(x + BLOCK + 1, cut.wide); i++) {
          const o = (j * cut.wide + i) * 3;
          if (Number.isNaN(cut.points[o])) continue;
          any = true;
          for (let c = 0; c < 3; c++) {
            const at = (cut.points[o + c] + 0.5) / f - 0.5;
            lo[c] = Math.min(lo[c], Math.floor(at));
            hi[c] = Math.max(hi[c], Math.floor(at) + 1);
          }
        }
      if (!any) continue;
      for (const chunk of level.chunksBetween(lo, hi)) keys.set(chunk.join("/"), chunk);
    }
  return [...keys.values()];
}

/**
 * The scan read along a cut, a band of rows at a time.
 *
 * In bands because resampling the whole of it is tens of milliseconds and the worker owes the hand
 * an answer sooner than that; and because the rows at the far end are the ones nobody is looking at
 * yet.  Writes straight to RGBA, so the page has nothing to do but hand it to `drawImage`.
 */
export function fillCut(cut: FlatCut, level: ZarrLevel, into: Uint8ClampedArray, from: number, to: number) {
  const f = level.factor;
  const reader = new LevelReader(level);
  const words = new Uint32Array(into.buffer);
  for (let y = from; y < Math.min(to, cut.tall); y++)
    for (let x = 0; x < cut.wide; x++) {
      const o = (y * cut.wide + x) * 3;
      if (Number.isNaN(cut.points[o])) continue;
      const value = reader.sample(
        (cut.points[o] + 0.5) / f - 0.5,
        (cut.points[o + 1] + 0.5) / f - 0.5,
        (cut.points[o + 2] + 0.5) / f - 0.5,
      );
      // Little-endian ABGR: one write instead of four into a clamped array.
      if (value >= 0) words[y * cut.wide + x] = (255 << 24) | (value << 16) | (value << 8) | value;
    }
}

// The box of the scan a piece lies in, which is what has to be fetched before it can be resampled.
export function patchBox(patch: Patch): [Vec3, Vec3] {
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  const { P } = patch;
  for (let o = 0; o < P.length; o += 3) {
    if (Number.isNaN(P[o])) continue;
    for (let c = 0; c < 3; c++) {
      if (P[o + c] < lo[c]) lo[c] = P[o + c];
      if (P[o + c] > hi[c]) hi[c] = P[o + c];
    }
  }
  return [lo, hi];
}

// Reads voxels of one level, remembering the chunks it has looked up during one drawing.
export class LevelReader {
  private cache = new Map<number, Uint8Array | null | undefined>();
  // The chunk looked up last, kept beside the rest: a sheet crosses a handful of chunks and runs
  // along each of them for thousands of pixels in a row, so nearly every look-up is the last one
  // again — and a map look-up for every pixel of every frame was most of what drawing cost.
  private lastId = -1;
  private lastChunk: Uint8Array | null | undefined;
  private kz: number;
  private ky: number;
  private kx: number;

  constructor(readonly level: ZarrLevel) {
    [this.kz, this.ky, this.kx] = level.meta.chunks;
  }

  private chunk(cz: number, cy: number, cx: number) {
    const id = (cz * 4096 + cy) * 4096 + cx;
    if (id === this.lastId) return this.lastChunk;
    let data = this.cache.get(id);
    if (data === undefined && !this.cache.has(id)) {
      data = this.level.inside(cz, cy, cx) ? this.level.get(cz, cy, cx) : null;
      this.cache.set(id, data);
    }
    this.lastId = id;
    this.lastChunk = data;
    return data;
  }

  // The trilinear value at level voxel coordinates, or -1 if a chunk it needs is not loaded.
  sample(lz: number, ly: number, lx: number) {
    const z0 = Math.floor(lz), y0 = Math.floor(ly), x0 = Math.floor(lx);
    const tz = lz - z0, ty = ly - y0, tx = lx - x0;
    const { kz, ky, kx } = this;
    const cz = Math.floor(z0 / kz), cy = Math.floor(y0 / ky), cx = Math.floor(x0 / kx);
    const iz = z0 - cz * kz, iy = y0 - cy * ky, ix = x0 - cx * kx;
    if (z0 >= 0 && y0 >= 0 && x0 >= 0 && iz + 1 < kz && iy + 1 < ky && ix + 1 < kx) {
      // All eight corners in one chunk, which is nearly always.
      const data = this.chunk(cz, cy, cx);
      if (data === undefined) return -1;
      if (data === null) return 0;
      const i = (iz * ky + iy) * kx + ix, sy = kx, sz = ky * kx;
      const c00 = data[i] + (data[i + 1] - data[i]) * tx;
      const c01 = data[i + sy] + (data[i + sy + 1] - data[i + sy]) * tx;
      const c10 = data[i + sz] + (data[i + sz + 1] - data[i + sz]) * tx;
      const c11 = data[i + sz + sy] + (data[i + sz + sy + 1] - data[i + sz + sy]) * tx;
      const c0 = c00 + (c01 - c00) * ty, c1 = c10 + (c11 - c10) * ty;
      return c0 + (c1 - c0) * tz;
    }
    let v = 0;
    for (let c = 0; c < 8; c++) {
      const dz = c >> 2, dy = (c >> 1) & 1, dx = c & 1;
      const weight = (dz ? tz : 1 - tz) * (dy ? ty : 1 - ty) * (dx ? tx : 1 - tx);
      if (weight === 0) continue;
      const z = z0 + dz, y = y0 + dy, x = x0 + dx;
      if (z < 0 || y < 0 || x < 0) continue;
      const qz = Math.floor(z / kz), qy = Math.floor(y / ky), qx = Math.floor(x / kx);
      const data = this.chunk(qz, qy, qx);
      if (data === undefined) return -1;
      if (data === null) continue;
      v += weight * data[((z - qz * kz) * ky + (y - qy * ky)) * kx + (x - qx * kx)];
    }
    return v;
  }
}

// Pixels between the points whose place in the scan is worked out exactly.  A piece is smooth over a
// few pixels, so the ones in between are interpolated, which is most of the drawing's cost saved.
const STEP = 8;

/**
 * Draws a plane of `patch` into `out` (RGBA, width × height), reading `levels[level]` and coarser
 * levels where it is missing.  Pixels the piece does not reach are left transparent.  A quick look is
 * drawn by asking for fewer pixels — the same view, smaller — and scaling it up where it is shown.
 * Returns how many pixels came from a coarser level than asked for, and how many were drawn at all.
 */
export function drawPlane(
  patch: Patch,
  plane: SurfacePlane,
  w: number,
  width: number,
  height: number,
  levels: ZarrLevel[],
  level: number,
  out: Uint8ClampedArray,
  // Where each equal step across the picture falls, in sheets (`acrossSheets`).
  spread: number[],
) {
  /*
   * Written a whole pixel at a time.  Four writes into a clamped array — which rounds and clamps
   * each one — came to as much as reaching into the scan did; as one 32-bit word there is nothing
   * to clamp and a quarter of the stores.  Little-endian, so the bytes fall as red, green, blue,
   * alpha in memory.
   */
  const words = new Uint32Array(out.buffer);
  const readers = levels.map((one) => new LevelReader(one));
  const where = mapping(patch, plane, w, width, height, spread);
  const point = new Float64Array(3);

  // Where the piece is, at every STEP-th pixel across and down, whether it is there at all, and how
  // much of a sheet is there — which the pixels in between are shaded by, so that the edge of a hole
  // is a fade and not a staircase of grid cells.
  const across = Math.ceil(width / STEP) + 1, down = Math.ceil(height / STEP) + 1;
  const places = new Float64Array(across * down * 3);
  const cover = new Float32Array(across * down);
  const there = new Uint8Array(across * down);
  for (let i = 0; i < down; i++)
    for (let j = 0; j < across; j++) {
      const [sheet, gi, gj] = where(Math.min(i * STEP, height - 1), Math.min(j * STEP, width - 1));
      if (!positionAt(patch, sheet, gi, gj, point)) continue;
      places.set(point, (i * across + j) * 3);
      cover[i * across + j] = coverageAt(patch, sheet, gi, gj);
      there[i * across + j] = 1;
    }

  let coarser = 0, drawn = 0;
  for (let r = 0; r < height; r++) {
    const i0 = Math.min(Math.floor(r / STEP), down - 2), ti = (r - i0 * STEP) / STEP;
    for (let c = 0; c < width; c++) {
      const j0 = Math.min(Math.floor(c / STEP), across - 2), tj = (c - j0 * STEP) / STEP;
      const topLeft = i0 * across + j0, bottomLeft = topLeft + across;
      let alpha = 0;
      if (there[topLeft] && there[topLeft + 1] && there[bottomLeft] && there[bottomLeft + 1]) {
        const a = topLeft * 3, b = a + 3, d = bottomLeft * 3, e = d + 3;
        for (let axis = 0; axis < 3; axis++) {
          const top = places[a + axis] * (1 - tj) + places[b + axis] * tj;
          const bottom = places[d + axis] * (1 - tj) + places[e + axis] * tj;
          point[axis] = top * (1 - ti) + bottom * ti;
        }
        const top = cover[topLeft] * (1 - tj) + cover[topLeft + 1] * tj;
        const bottom = cover[bottomLeft] * (1 - tj) + cover[bottomLeft + 1] * tj;
        alpha = top * (1 - ti) + bottom * ti;
      } else {
        // Near the edge of what the piece reaches, where interpolating would round it off.
        const [sheet, gi, gj] = where(r, c);
        if (!positionAt(patch, sheet, gi, gj, point)) {
          words[r * width + c] = 0;
          continue;
        }
        alpha = coverageAt(patch, sheet, gi, gj);
      }
      if (alpha <= 0.02) {
        words[r * width + c] = 0;
        continue;
      }
      let value = -1, l = level;
      for (; l < readers.length; l++) {
        const f = levels[l].factor;
        value = readers[l].sample(
          (point[0] + 0.5) / f - 0.5,
          (point[1] + 0.5) / f - 0.5,
          (point[2] + 0.5) / f - 0.5,
        );
        if (value >= 0) break;
      }
      if (l > level) coarser++;
      if (value < 0) {
        words[r * width + c] = 0;
        continue;
      }
      const grey = value < 0 ? 0 : value > 255 ? 255 : value | 0;
      const shade = Math.round(255 * (alpha > 1 ? 1 : alpha)) * 0x1000000 + grey * 0x10101;
      words[r * width + c] = shade;
      drawn++;
    }
  }
  return { coarser, drawn };
}

/*
 * How many points across the image the chunks are worked out from.  At least as many as the piece has
 * points across it: a coarser net than the piece's own can step over a run of sheet between two of
 * its points, and a pixel drawn from a chunk nobody asked for is drawn from a coarser level for ever,
 * which leaves the card saying it is still loading with nothing left to come.
 */
const LATTICE = 33;
const latticeFor = (patch: Patch) => Math.min(129, Math.max(LATTICE, patch.nu, patch.nv));

/**
 * The chunks of `level` that drawing this plane reads: the bounding box of every cell of a lattice
 * over the image, with a voxel to spare for interpolation.
 */
export function planeChunks(
  patch: Patch,
  plane: SurfacePlane,
  w: number,
  width: number,
  height: number,
  level: ZarrLevel,
  // Where each equal step across the picture falls, in sheets (`acrossSheets`).
  spread: number[],
  // Where along the axis the cut does not show it is taken (`mapping`).
  pin = 0.5,
): Chunk[] {
  const where = mapping(patch, plane, w, width, height, spread, pin);
  const point = new Float64Array(3);
  const lattice = latticeFor(patch);
  const positions = new Float32Array(lattice * lattice * 3).fill(NaN);
  for (let i = 0; i < lattice; i++)
    for (let j = 0; j < lattice; j++) {
      const [sheet, gi, gj] = where(
        (i / (lattice - 1)) * (height - 1),
        (j / (lattice - 1)) * (width - 1),
      );
      if (coverageAt(patch, sheet, gi, gj) > 0 && positionAt(patch, sheet, gi, gj, point)) {
        positions.set(point, (i * lattice + j) * 3);
      }
    }
  const f = level.factor;
  const keys = new Map<string, Chunk>();
  const lo = [0, 0, 0], hi = [0, 0, 0];
  for (let i = 0; i + 1 < lattice; i++)
    for (let j = 0; j + 1 < lattice; j++) {
      lo.fill(Infinity);
      hi.fill(-Infinity);
      // Whichever corners of the cell the piece reaches: a cell beside a hole has some, and the
      // pixels there are drawn like any other, so their chunks are needed like any other.
      let corners = 0;
      for (const k of [i * lattice + j, i * lattice + j + 1, (i + 1) * lattice + j, (i + 1) * lattice + j + 1]) {
        if (Number.isNaN(positions[k * 3])) continue;
        corners++;
        for (let c = 0; c < 3; c++) {
          const at = (positions[k * 3 + c] + 0.5) / f - 0.5;
          lo[c] = Math.min(lo[c], Math.floor(at));
          hi[c] = Math.max(hi[c], Math.floor(at) + 1);
        }
      }
      if (corners === 0) continue;
      for (const chunk of level.chunksBetween(lo, hi)) keys.set(chunk.join("/"), chunk);
    }
  return [...keys.values()];
}

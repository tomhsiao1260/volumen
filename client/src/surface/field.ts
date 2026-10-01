/**
 * @file The prediction around a patch, as a field over positions of the full-resolution scan
 * (z, y, x voxels; voxel i is centred on i):
 *
 *   normal(z, y, x, ref)   the sheet normal, its sign chosen to agree with `ref` (the prediction is
 *                          unsigned), written to `out`
 *
 * Copied out of the chunks into dense arrays once per patch, because building a patch samples it a
 * few million times.
 *
 * That is the whole of what the flattening reads: a direction, and whether there is one.
 *
 * Three other things used to be read here and all three are gone, each for a measured reason
 * (`scratchpad/pup/explain.cjs`, on Scroll 1 at 19449, 7935, 38115):
 *
 *   the phase `cos`      a place on papyrus reads higher than a place in the gap between two sheets
 *                        51% of the time.  A coin.
 *   the surface mask     55% of the sheets the scan shows have no predicted face within 10 voxels.
 *   `grad_mag`           it says a winding takes 30 voxels where the papyrus repeats every 46 — out
 *                        by half, though very steadily (28 to 32).  Its zeros are still read, since
 *                        they are where the network had nothing to say, but its numbers are not.
 *
 * The normal is the part of the prediction that holds up: against the scan's own grain, half of it is
 * within 19 degrees.  So the fit is built on it alone (`patch.ts`), and how far apart the sheets are
 * is a thing the fit is told rather than a thing it reads.
 */

import type { ZarrLevel } from "./store";

export type Vec3 = [number, number, number];

/*
 * What the fit asks of a normal field, and all it asks: which way is across the sheets at a place,
 * with its sign turned to agree with a direction already in hand — and whether there is an answer
 * there at all.  Two things answer to it: the prediction, where there is one, and the scan itself.
 */
export interface NormalField {
  readonly out: Float64Array;
  normal(z: number, y: number, x: number, rz: number, ry: number, rx: number): boolean;
}

export class LasagnaField implements NormalField {
  private f: number;
  private o: number[];
  private d: number[];
  private nx: Float32Array;
  private ny: Float32Array;
  // Not read as a number: `grad_mag` is zero exactly where the network had nothing to say, and that
  // is the whole of what it is used for here — whether there IS a normal at a place.
  private gm: Float32Array;
  // Where `normal` writes its answer.
  readonly out = new Float64Array(3);

  /**
   * `lo` and `hi` bound the full-resolution box the field is needed in; the channels' chunks covering
   * it must be loaded (see `chunksFor`).
   */
  constructor(channels: { grad_mag: ZarrLevel; nx: ZarrLevel; ny: ZarrLevel }, lo: Vec3, hi: Vec3) {
    const { nx, ny, grad_mag: gm } = channels;
    this.f = nx.factor;
    const box = fieldBox(nx, lo, hi);
    this.o = box.lo;
    const a = nx.copyBox(box.lo, box.hi), b = ny.copyBox(box.lo, box.hi), g = gm.copyBox(box.lo, box.hi);
    this.d = a.dims;
    const n = a.data.length;
    this.nx = new Float32Array(n);
    this.ny = new Float32Array(n);
    this.gm = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      if (g.data[k] === 0) continue;
      this.nx[k] = (a.data[k] - 128) / 127;
      this.ny[k] = (b.data[k] - 128) / 127;
      this.gm[k] = g.data[k] / 4000;
    }
  }

  normal(z: number, y: number, x: number, rz: number, ry: number, rx: number) {
    const f = this.f, d = this.d;
    const lz = (z + 0.5) / f - 0.5 - this.o[0];
    const ly = (y + 0.5) / f - 0.5 - this.o[1];
    const lx = (x + 0.5) / f - 0.5 - this.o[2];
    const z0 = Math.floor(lz), y0 = Math.floor(ly), x0 = Math.floor(lx);
    if (z0 < 0 || y0 < 0 || x0 < 0 || z0 + 1 >= d[0] || y0 + 1 >= d[1] || x0 + 1 >= d[2]) return false;
    const tz = lz - z0, ty = ly - y0, tx = lx - x0;
    let az = 0, ay = 0, ax = 0, ws = 0;
    for (let c = 0; c < 8; c++) {
      const cz = c >> 2, cy = (c >> 1) & 1, cx = c & 1;
      const w = (cz ? tz : 1 - tz) * (cy ? ty : 1 - ty) * (cx ? tx : 1 - tx);
      const k = ((z0 + cz) * d[1] + y0 + cy) * d[2] + x0 + cx;
      if (w === 0 || this.gm[k] === 0) continue;
      const vx = this.nx[k], vy = this.ny[k];
      const vz = Math.sqrt(Math.max(0, 1 - vx * vx - vy * vy));
      // Flipped to agree with `ref` before averaging: the same as averaging n·nᵀ while neighbours
      // are within 90° of each other, and much cheaper.
      const s = vz * rz + vy * ry + vx * rx < 0 ? -w : w;
      az += s * vz;
      ay += s * vy;
      ax += s * vx;
      ws += w;
    }
    const len = Math.sqrt(az * az + ay * ay + ax * ax);
    if (ws < 0.25 || len < 1e-6) return false;
    this.out[0] = az / len;
    this.out[1] = ay / len;
    this.out[2] = ax / len;
    return true;
  }
}

// The box of `level` voxels covering the full-resolution box, with one voxel to spare on each side
// for interpolation.
function fieldBox(level: ZarrLevel, lo: Vec3, hi: Vec3, spare = 1) {
  const f = level.factor;
  return {
    lo: lo.map((v) => Math.floor(v / f) - spare),
    hi: hi.map((v) => Math.floor(v / f) + spare),
  };
}

/**
 * The surface prediction over the box, read out chunk by chunk rather than through the store like
 * the other channels: its chunks are far too big to keep (see `readBox`).
 */
// The chunks of each channel the field for this box needs.
export function chunksFor(level: ZarrLevel, lo: Vec3, hi: Vec3) {
  const box = fieldBox(level, lo, hi);
  return level.chunksBetween(box.lo, box.hi);
}

// How far around each place a scan-derived answer looks, in voxels of that level.
const around = (level: ZarrLevel, micron: number) =>
  Math.max(1, Math.round(AROUND_UM / (micron * level.factor) / 2));

/**
 * Which level of the scan to work the normal out on: the one whose voxels come nearest NORMAL_UM.
 * The scan is served at 1.1, 2.4, 7.9, 8.6 or 9.4 µm and each at halvings of that, so there is always
 * one within a factor of two, and the answer is the same piece of papyrus whichever scan it is.
 */
export function normalLevel(levels: ZarrLevel[], micron: number) {
  let best = 0;
  for (let i = 1; i < levels.length; i++)
    if (Math.abs(levels[i].factor * micron - NORMAL_UM) < Math.abs(levels[best].factor * micron - NORMAL_UM))
      best = i;
  return best;
}

// And the chunks of it a box needs, which is more than the box: the gradient and the averaging both
// reach past the edge.
export function scanChunksFor(level: ZarrLevel, lo: Vec3, hi: Vec3, micron: number) {
  const box = fieldBox(level, lo, hi, around(level, micron) + 1);
  return level.chunksBetween(box.lo, box.hi);
}

/*
 * How big a voxel the normal is worked out on, and over how much of the scroll each answer is taken,
 * both in µm.
 *
 * In µm because this is the whole point of it: the scan comes at 1.1, 2.4, 7.9, 8.6 and 9.4 µm and
 * the answer should be the same piece of papyrus every time.  The first picks which level of the scan
 * to read — fine enough that a sheet and the gap after it are several voxels, coarse enough that the
 * work is small and the grain of the scan averages out.  The second is how far around each place is
 * looked at: about half the distance from one sheet to the next, so that a place sees the sheet it is
 * on and the gap either side, and no further — further and a bend is averaged away.
 */
const NORMAL_UM = 16;
const AROUND_UM = 96;
// And how much of the pull at a place has to lie in one direction before there is a direction at all:
// in a stack of sheets nearly all of it does, and in a blur none of it does.
const ONE_WAY = 0.55;

/**
 * The sheet normal worked out from the SCAN, where there is no prediction to read — which is most
 * scans: of the twenty-three in the app, five have a Lasagna prediction and every one of those is a
 * 2.4 µm scan.  The 1.1 µm scans, the 7.9 to 9.4 µm ones and the overviews have none at all.
 *
 * It is the structure tensor, which is the standard way to get the lie of a layered thing out of the
 * data: at each place the scan's gradient, multiplied by itself into a 3×3, and those averaged over
 * the neighbourhood.  Across a stack of sheets the gradient points the same way every time — along
 * the normal — so the average has nearly all of its weight in that one direction, and that direction
 * is the answer.  Where the scan is a blur the weight is spread evenly and there is no answer, which
 * is the same thing `grad_mag` being zero says about the prediction.
 *
 * The answer is a direction without a sign, exactly as the prediction's is, and for the same reason:
 * nothing local says which side of a sheet is out.  So it is given the same way, turned to agree with
 * a reference, and the march carries the sign along from the seed.
 *
 * Kept as the six numbers of the tensor rather than as the direction, and the direction worked out
 * where it is asked for.  That is what makes the sign free: the answer at a place is found by
 * starting from the direction asked about and letting the tensor turn it, a few times over, which
 * lands on the strongest direction nearest the one it started from.
 */
export class ScanField implements NormalField {
  private f: number;
  private o: number[];
  private d: number[];
  // zz, yy, xx, zy, zx, yx of the averaged gradient-against-itself, at each voxel of the box.
  private t: Float32Array;
  readonly out = new Float64Array(3);

  constructor(level: ZarrLevel, lo: Vec3, hi: Vec3, micron: number) {
    this.f = level.factor;
    const over = around(level, micron);
    // Room for the gradient and for the averaging, both of which eat into the rim.
    const box = fieldBox(level, lo, hi, over + 1);
    const got = level.copyBox(box.lo, box.hi);
    const d = got.dims, n = got.data.length;
    this.o = box.lo;
    this.d = d;

    const t = new Float32Array(n * 6);
    const [dz, dy, dx] = d;
    for (let z = 1; z + 1 < dz; z++)
      for (let y = 1; y + 1 < dy; y++)
        for (let x = 1; x + 1 < dx; x++) {
          const k = (z * dy + y) * dx + x;
          const gz = got.data[k + dy * dx] - got.data[k - dy * dx];
          const gy = got.data[k + dx] - got.data[k - dx];
          const gx = got.data[k + 1] - got.data[k - 1];
          t[k * 6] = gz * gz;
          t[k * 6 + 1] = gy * gy;
          t[k * 6 + 2] = gx * gx;
          t[k * 6 + 3] = gz * gy;
          t[k * 6 + 4] = gz * gx;
          t[k * 6 + 5] = gy * gx;
        }
    this.t = blur(t, d, over);
  }

  normal(z: number, y: number, x: number, rz: number, ry: number, rx: number) {
    const f = this.f, d = this.d;
    const lz = (z + 0.5) / f - 0.5 - this.o[0];
    const ly = (y + 0.5) / f - 0.5 - this.o[1];
    const lx = (x + 0.5) / f - 0.5 - this.o[2];
    const z0 = Math.floor(lz), y0 = Math.floor(ly), x0 = Math.floor(lx);
    if (z0 < 0 || y0 < 0 || x0 < 0 || z0 + 1 >= d[0] || y0 + 1 >= d[1] || x0 + 1 >= d[2]) return false;
    const tz = lz - z0, ty = ly - y0, tx = lx - x0;
    const j = [0, 0, 0, 0, 0, 0];
    for (let c = 0; c < 8; c++) {
      const cz = c >> 2, cy = (c >> 1) & 1, cx = c & 1;
      const w = (cz ? tz : 1 - tz) * (cy ? ty : 1 - ty) * (cx ? tx : 1 - tx);
      if (w === 0) continue;
      const k = (((z0 + cz) * d[1] + y0 + cy) * d[2] + x0 + cx) * 6;
      for (let i = 0; i < 6; i++) j[i] += w * this.t[k + i];
    }
    const trace = j[0] + j[1] + j[2];
    if (trace < 1e-9) return false;

    // Turned by the tensor a few times over, from the direction asked about: it lands on the one the
    // pull is strongest along, and keeps the sign it started with.
    let vz = rz, vy = ry, vx = rx;
    for (let k = 0; k < 5; k++) {
      const az = j[0] * vz + j[3] * vy + j[4] * vx;
      const ay = j[3] * vz + j[1] * vy + j[5] * vx;
      const ax = j[4] * vz + j[5] * vy + j[2] * vx;
      const len = Math.sqrt(az * az + ay * ay + ax * ax);
      if (len < 1e-12) return false;
      vz = az / len;
      vy = ay / len;
      vx = ax / len;
    }
    // How much of the pull lies that way; evenly spread means the scan has no grain here.
    const az = j[0] * vz + j[3] * vy + j[4] * vx;
    const ay = j[3] * vz + j[1] * vy + j[5] * vx;
    const ax = j[4] * vz + j[5] * vy + j[2] * vx;
    if ((vz * az + vy * ay + vx * ax) / trace < ONE_WAY) return false;

    const s = vz * rz + vy * ry + vx * rx < 0 ? -1 : 1;
    this.out[0] = s * vz;
    this.out[1] = s * vy;
    this.out[2] = s * vx;
    return true;
  }
}

// A box average of each of the six, done one axis at a time and twice over, which is near enough a
// bell and costs the same however wide it is.
function blur(t: Float32Array, d: number[], over: number) {
  const [dz, dy, dx] = d;
  const step = [dy * dx, dx, 1];
  const size = [dz, dy, dx];
  let from = t, into = new Float32Array(t.length);
  for (let pass = 0; pass < 2; pass++)
    for (let axis = 0; axis < 3; axis++) {
      const s = step[axis] * 6, n = size[axis];
      for (let z = 0; z < dz; z++)
        for (let y = 0; y < dy; y++)
          for (let x = 0; x < dx; x++) {
            const at = [z, y, x][axis];
            const k = ((z * dy + y) * dx + x) * 6;
            const lo = Math.max(0, at - over), hi = Math.min(n - 1, at + over);
            for (let i = 0; i < 6; i++) {
              let sum = 0;
              for (let o = lo; o <= hi; o++) sum += from[k + (o - at) * s + i];
              into[k + i] = sum / (hi - lo + 1);
            }
          }
      [from, into] = [into, from];
    }
  return from;
}

/**
 * @file The prediction around a patch, as a field over positions of the full-resolution scan
 * (z, y, x voxels; voxel i is centred on i):
 *
 *   normal(z, y, x, ref)   the sheet normal, its sign chosen to agree with `ref` (the prediction is
 *                          unsigned), written to `out`
 *   density(z, y, x)       windings crossed per voxel along the normal, 0 where there is no prediction
 *
 * Copied out of the chunks into dense arrays once per patch, because building a patch samples it a
 * few million times.
 *
 * These two are the whole of what the flattening reads.  The phase and the surface prediction used to
 * be read here as well, and both are gone: measured on Scroll 1 (`scratchpad/pup/explain.cjs`), a
 * place on papyrus reads higher in the phase than a place in the gap between two sheets 51% of the
 * time — a coin — and 55% of the sheets the scan shows have no predicted face within 10 voxels of
 * them.  The normal is the part of the prediction that holds up: against the scan's own grain, half
 * of it is within 19 degrees.  So the fit is built on it alone (`patch.ts`).
 */

import type { ZarrLevel } from "./store";

export type Vec3 = [number, number, number];

export class LasagnaField {
  private f: number;
  private o: number[];
  private d: number[];
  private nx: Float32Array;
  private ny: Float32Array;
  private gm: Float32Array;
  // Where `normal` writes its answer.
  readonly out = new Float64Array(3);

  /**
   * `lo` and `hi` bound the full-resolution box the field is needed in; the channels' chunks covering
   * it must be loaded (see `chunksFor`).
   */
  constructor(
    channels: { cos?: ZarrLevel; grad_mag: ZarrLevel; nx: ZarrLevel; ny: ZarrLevel },
    lo: Vec3,
    hi: Vec3,
    unused?: unknown,
  ) {
    void unused;
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

  density(z: number, y: number, x: number) {
    const f = this.f, d = this.d;
    const lz = (z + 0.5) / f - 0.5 - this.o[0];
    const ly = (y + 0.5) / f - 0.5 - this.o[1];
    const lx = (x + 0.5) / f - 0.5 - this.o[2];
    const z0 = Math.floor(lz), y0 = Math.floor(ly), x0 = Math.floor(lx);
    if (z0 < 0 || y0 < 0 || x0 < 0 || z0 + 1 >= d[0] || y0 + 1 >= d[1] || x0 + 1 >= d[2]) return 0;
    const tz = lz - z0, ty = ly - y0, tx = lx - x0;
    let v = 0, ws = 0;
    for (let c = 0; c < 8; c++) {
      const cz = c >> 2, cy = (c >> 1) & 1, cx = c & 1;
      const w = (cz ? tz : 1 - tz) * (cy ? ty : 1 - ty) * (cx ? tx : 1 - tx);
      const g = this.gm[((z0 + cz) * d[1] + y0 + cy) * d[2] + x0 + cx];
      if (w === 0 || g === 0) continue;
      v += w * g;
      ws += w;
    }
    return ws < 0.25 ? 0 : v / ws;
  }
}

// The box of `level` voxels covering the full-resolution box, with one voxel to spare on each side
// for interpolation.
function fieldBox(level: ZarrLevel, lo: Vec3, hi: Vec3) {
  const f = level.factor;
  return {
    lo: lo.map((v) => Math.floor(v / f) - 1),
    hi: hi.map((v) => Math.floor(v / f) + 1),
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

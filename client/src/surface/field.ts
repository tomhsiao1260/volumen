/**
 * @file The prediction around a patch, as a field over positions of the full-resolution scan
 * (z, y, x voxels; voxel i is centred on i):
 *
 *   normal(z, y, x, ref)   the sheet normal, its sign chosen to agree with `ref` (the prediction is
 *                          unsigned), written to `out`
 *   density(z, y, x)       sheets crossed per voxel along the normal, 0 where there is no prediction
 *   phase(z, y, x)         1 on a sheet, 0 halfway between two sheets
 *   band(z, y, x)          the surface prediction: above 127 where a sheet's face is
 *
 * Copied out of the chunks into dense arrays once per patch, because building a patch samples it a
 * few million times.
 *
 * What says where the sheets are is the band, where the scan has one: it is 2–10 µm a voxel against
 * the phase's 19 µm, and measured on Scrolls 1, 3 and PHerc1447 it puts whole layers on papyrus
 * 92–100% of the time against the phase's 1–100%.  The phase is the fallback for the scans with no
 * surface prediction.  The density is never counted on: its winding scale is not the same from one
 * scan to the next — on PHerc1447 it under-counts by about four — so it only says where there is a
 * prediction at all, and roughly how far apart the sheets are.
 */

import type { Dense, ZarrLevel } from "./store";

export type Vec3 = [number, number, number];

export class LasagnaField {
  private f: number;
  private o: number[];
  private d: number[];
  private nx: Float32Array;
  private ny: Float32Array;
  private gm: Float32Array;
  private fc: number;
  private oc: number[];
  private dc: number[];
  private ph: Uint8Array;
  private fm = 0;
  private om: number[] = [];
  private dm: number[] = [];
  private mk: Uint8Array | undefined;
  // Whether the surface prediction is there, and so whether `band` says anything.
  readonly hasBands: boolean;
  // Where `normal` writes its answer.
  readonly out = new Float64Array(3);

  /**
   * `lo` and `hi` bound the full-resolution box the field is needed in; the channels' chunks covering
   * it must be loaded (see `chunksFor`).
   */
  constructor(
    channels: { cos: ZarrLevel; grad_mag: ZarrLevel; nx: ZarrLevel; ny: ZarrLevel },
    lo: Vec3,
    hi: Vec3,
    mask?: MaskBox,
  ) {
    const { nx, ny, grad_mag: gm, cos } = channels;
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
    this.fc = cos.factor;
    const cbox = fieldBox(cos, lo, hi);
    this.oc = cbox.lo;
    const c = cos.copyBox(cbox.lo, cbox.hi);
    this.dc = c.dims;
    this.ph = c.data;
    this.hasBands = mask !== undefined;
    if (mask !== undefined) {
      this.fm = mask.factor;
      this.om = mask.lo;
      this.dm = mask.dims;
      this.mk = mask.data;
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

  phase(z: number, y: number, x: number) {
    const f = this.fc, d = this.dc;
    const lz = (z + 0.5) / f - 0.5 - this.oc[0];
    const ly = (y + 0.5) / f - 0.5 - this.oc[1];
    const lx = (x + 0.5) / f - 0.5 - this.oc[2];
    const z0 = Math.floor(lz), y0 = Math.floor(ly), x0 = Math.floor(lx);
    if (z0 < 0 || y0 < 0 || x0 < 0 || z0 + 1 >= d[0] || y0 + 1 >= d[1] || x0 + 1 >= d[2]) return 0;
    const tz = lz - z0, ty = ly - y0, tx = lx - x0;
    let v = 0;
    for (let c = 0; c < 8; c++) {
      const cz = c >> 2, cy = (c >> 1) & 1, cx = c & 1;
      v +=
        (cz ? tz : 1 - tz) *
        (cy ? ty : 1 - ty) *
        (cx ? tx : 1 - tx) *
        this.ph[((z0 + cz) * d[1] + y0 + cy) * d[2] + x0 + cx];
    }
    return v / 255;
  }

  band(z: number, y: number, x: number) {
    const mk = this.mk;
    if (mk === undefined) return 0;
    const f = this.fm, d = this.dm;
    const lz = (z + 0.5) / f - 0.5 - this.om[0];
    const ly = (y + 0.5) / f - 0.5 - this.om[1];
    const lx = (x + 0.5) / f - 0.5 - this.om[2];
    const z0 = Math.floor(lz), y0 = Math.floor(ly), x0 = Math.floor(lx);
    if (z0 < 0 || y0 < 0 || x0 < 0 || z0 + 1 >= d[0] || y0 + 1 >= d[1] || x0 + 1 >= d[2]) return 0;
    const tz = lz - z0, ty = ly - y0, tx = lx - x0;
    let v = 0;
    for (let c = 0; c < 8; c++) {
      const cz = c >> 2, cy = (c >> 1) & 1, cx = c & 1;
      v +=
        (cz ? tz : 1 - tz) *
        (cy ? ty : 1 - ty) *
        (cx ? tx : 1 - tx) *
        mk[((z0 + cz) * d[1] + y0 + cy) * d[2] + x0 + cx];
    }
    return v;
  }

  /**
   * How far along the normal (`nz`, `ny`, `nx`) from a point the nearest sheet is, looking no further
   * than `span` voxels either way; NaN if there is none in reach.  This is the one question the patch
   * asks of the prediction, and the answer comes from the surface prediction where the scan has one
   * and from the phase where it has not.
   *
   * A face of a sheet is a band 20–40 µm thick, but a line crossing it at an angle can find it in
   * pieces, so runs closer together than one voxel of the prediction are one band — otherwise a
   * sheet is read as two and everything built on it counts half sheets.
   */
  nearestSheet(z: number, y: number, x: number, nz: number, ny: number, nx: number, span: number) {
    if (!this.hasBands) return this.nearestPeak(z, y, x, nz, ny, nx, span);
    const merge = Math.max(2, this.fm);
    const step = Math.max(1, merge / 2);
    const on = (t: number) => this.band(z + nz * t, y + ny * t, x + nx * t) > 127;
    let found = NaN;
    for (let d = 0; d <= span && Number.isNaN(found); d += step) {
      if (on(d)) found = d;
      else if (d > 0 && on(-d)) found = -d;
    }
    if (Number.isNaN(found)) return NaN;
    // The whole band around it, jumping gaps smaller than `merge`.  A face is 20–40 µm thick, so
    // there is no point walking further than a few of the prediction's own voxels.
    const walk = merge * 4;
    let low = found, high = found;
    for (const dir of [-1, 1]) {
      let last = found, gap = 0;
      for (let t = found + dir * step; Math.abs(t - found) <= walk && Math.abs(t) <= span + merge; t += dir * step) {
        if (on(t)) (last = t), (gap = 0);
        else if ((gap += step) > merge) break;
      }
      if (dir < 0) low = last;
      else high = last;
    }
    return (low + high) / 2;
  }

  /**
   * How far apart the sheets are at a point, along its normal: the middle gap between the sheets
   * within `reach` voxels either way, or NaN where fewer than two were found.  This is the one
   * number the whole patch is scaled by, so it is measured rather than taken from the density, whose
   * winding scale differs from scan to scan.
   */
  spacingAt(z: number, y: number, x: number, nz: number, ny: number, nx: number, reach: number) {
    const merge = Math.max(2, this.fm);
    const step = Math.max(1, merge / 2);
    const middles: number[] = [];
    let start = NaN, last = NaN, gap = 0;
    for (let t = -reach; t <= reach; t += step) {
      if (this.band(z + nz * t, y + ny * t, x + nx * t) > 127) {
        if (Number.isNaN(start)) start = t;
        last = t;
        gap = 0;
      } else if (!Number.isNaN(start) && (gap += step) > merge) {
        middles.push((start + last) / 2);
        start = NaN;
      }
    }
    if (!Number.isNaN(start)) middles.push((start + last) / 2);
    if (middles.length < 2) return NaN;
    const gaps = middles.slice(1).map((m, i) => m - middles[i]).sort((a, b) => a - b);
    return gaps[gaps.length >> 1];
  }

  // The nearest peak of the phase, for the scans with no surface prediction.
  private nearestPeak(z: number, y: number, x: number, nz: number, ny: number, nx: number, span: number) {
    let best = NaN, bestValue = 0.5;
    let before = -1, previous = -1;
    for (let t = -span - 1; t <= span + 1; t += 0.5) {
      const value = this.phase(z + nz * t, y + ny * t, x + nx * t);
      const at = t - 0.5;
      if (previous > before && previous >= value && previous > bestValue && Math.abs(at) <= span) {
        if (Number.isNaN(best) || Math.abs(at) < Math.abs(best)) (best = at), (bestValue = previous);
      }
      before = previous;
      previous = value;
    }
    return best;
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
export interface MaskBox extends Dense {
  lo: number[];
  factor: number;
}

export async function readMask(level: ZarrLevel, lo: Vec3, hi: Vec3): Promise<MaskBox> {
  const box = fieldBox(level, lo, hi);
  const dense = await level.readBox(box.lo, box.hi);
  return { ...dense, lo: box.lo, factor: level.factor };
}

// The chunks of each channel the field for this box needs.
export function chunksFor(level: ZarrLevel, lo: Vec3, hi: Vec3) {
  const box = fieldBox(level, lo, hi);
  return level.chunksBetween(box.lo, box.hi);
}

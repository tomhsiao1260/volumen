/**
 * @file Drawing one layer of a patch: every pixel is a point of the layer's grid (bilinear between
 * its four nearest grid points), and its grey is the scan there (trilinear).  Where the chunks of the
 * level asked for have not arrived, a coarser level that has them is used, so that a card shows the
 * layer at once and sharpens as the data comes in.
 */

import type { ZarrLevel } from "./store";

type Chunk = [number, number, number];

/**
 * The chunks of `level` that drawing the layer `grid` (flat z, y, x per grid point, nu × nv) reads:
 * every grid cell's bounding box, with a voxel to spare for interpolation.
 */
export function layerChunks(grid: Float32Array, nu: number, nv: number, level: ZarrLevel): Chunk[] {
  const f = level.factor;
  const keys = new Map<string, Chunk>();
  const lo = [0, 0, 0], hi = [0, 0, 0];
  for (let i = 0; i + 1 < nv; i++)
    for (let j = 0; j + 1 < nu; j++) {
      lo.fill(Infinity);
      hi.fill(-Infinity);
      let valid = true;
      for (const k of [i * nu + j, i * nu + j + 1, (i + 1) * nu + j, (i + 1) * nu + j + 1]) {
        for (let c = 0; c < 3; c++) {
          const v = grid[k * 3 + c];
          if (Number.isNaN(v)) valid = false;
          const l = (v + 0.5) / f - 0.5;
          lo[c] = Math.min(lo[c], Math.floor(l));
          hi[c] = Math.max(hi[c], Math.floor(l) + 1);
        }
      }
      if (!valid) continue;
      for (const chunk of level.chunksBetween(lo, hi)) keys.set(chunk.join("/"), chunk);
    }
  return [...keys.values()];
}

// Reads voxels of one level, remembering the chunks it has looked up during one drawing.
class LevelReader {
  private cache = new Map<number, Uint8Array | null | undefined>();
  private kz: number;
  private ky: number;
  private kx: number;

  constructor(readonly level: ZarrLevel) {
    [this.kz, this.ky, this.kx] = level.meta.chunks;
  }

  private chunk(cz: number, cy: number, cx: number) {
    const id = (cz * 4096 + cy) * 4096 + cx;
    let data = this.cache.get(id);
    if (data === undefined && !this.cache.has(id)) {
      data = this.level.inside(cz, cy, cx) ? this.level.get(cz, cy, cx) : null;
      this.cache.set(id, data);
    }
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
      const w = (dz ? tz : 1 - tz) * (dy ? ty : 1 - ty) * (dx ? tx : 1 - tx);
      if (w === 0) continue;
      const z = z0 + dz, y = y0 + dy, x = x0 + dx;
      if (z < 0 || y < 0 || x < 0) continue;
      const qz = Math.floor(z / kz), qy = Math.floor(y / ky), qx = Math.floor(x / kx);
      const data = this.chunk(qz, qy, qx);
      if (data === undefined) return -1;
      if (data === null) continue;
      v += w * data[((z - qz * kz) * ky + (y - qy * ky)) * kx + (x - qx * kx)];
    }
    return v;
  }
}

/**
 * Draws the layer `grid` into `out` (RGBA, width × height), reading `levels[level]` and coarser
 * levels where it is missing.  Pixels off the layer are left transparent.  Returns how many pixels
 * came from a coarser level than asked for, or from none, and how many were drawn at all.
 */
export function drawLayer(
  grid: Float32Array,
  nu: number,
  nv: number,
  width: number,
  height: number,
  levels: ZarrLevel[],
  level: number,
  out: Uint8ClampedArray,
) {
  const readers = levels.map((l) => new LevelReader(l));
  let coarser = 0, drawn = 0;
  for (let r = 0; r < height; r++) {
    const gi = ((r + 0.5) / height) * (nv - 1);
    const i0 = Math.min(nv - 2, Math.floor(gi)), ti = gi - i0;
    for (let c = 0; c < width; c++) {
      const gj = ((c + 0.5) / width) * (nu - 1);
      const j0 = Math.min(nu - 2, Math.floor(gj)), tj = gj - j0;
      const a = (i0 * nu + j0) * 3, b = a + 3, d = a + nu * 3, e = d + 3;
      const o = (r * width + c) * 4;
      const z =
        (grid[a] * (1 - tj) + grid[b] * tj) * (1 - ti) + (grid[d] * (1 - tj) + grid[e] * tj) * ti;
      if (Number.isNaN(z)) {
        out[o + 3] = 0;
        continue;
      }
      const y =
        (grid[a + 1] * (1 - tj) + grid[b + 1] * tj) * (1 - ti) + (grid[d + 1] * (1 - tj) + grid[e + 1] * tj) * ti;
      const x =
        (grid[a + 2] * (1 - tj) + grid[b + 2] * tj) * (1 - ti) + (grid[d + 2] * (1 - tj) + grid[e + 2] * tj) * ti;
      let v = -1, l = level;
      for (; l < readers.length; l++) {
        const f = levels[l].factor;
        v = readers[l].sample((z + 0.5) / f - 0.5, (y + 0.5) / f - 0.5, (x + 0.5) / f - 0.5);
        if (v >= 0) break;
      }
      if (l > level) coarser++;
      if (v < 0) {
        out[o + 3] = 0;
        continue;
      }
      out[o] = out[o + 1] = out[o + 2] = v;
      out[o + 3] = 255;
      drawn++;
    }
  }
  return { coarser, drawn };
}

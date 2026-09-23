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
 * In UW and VW, w runs in sheets rather than voxels and the sheet the card is on is in the middle,
 * so a correct piece shows its sheets as level bands however the papyrus curves.
 */

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
  span: number,
  width: number,
  height: number,
) {
  const lastU = patch.nu - 1, lastV = patch.nv - 1;
  const alongU = (c: number) => ((c + 0.5) / width) * lastU;
  const alongV = (r: number) => ((r + 0.5) / height) * lastV;
  const acrossRow = (r: number) => w + ((r + 0.5) / height - 0.5) * 2 * span;
  const acrossColumn = (c: number) => w + ((c + 0.5) / width - 0.5) * 2 * span;
  if (plane === "uw") return (r: number, c: number) => [acrossRow(r), lastV / 2, alongU(c)];
  if (plane === "vw") return (r: number, c: number) => [acrossColumn(c), alongV(r), lastU / 2];
  return (r: number, c: number) => [w, alongV(r), alongU(c)];
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
 * levels where it is missing.  Pixels the piece does not reach are left transparent.  With `step`
 * above one, only every `step`-th pixel each way is worked out and the rest of its square copied, for
 * a quick first look at a sheet the wheel has just reached.  Returns how many pixels came from a
 * coarser level than asked for, and how many were drawn at all.
 */
export function drawPlane(
  patch: Patch,
  plane: SurfacePlane,
  w: number,
  span: number,
  width: number,
  height: number,
  levels: ZarrLevel[],
  level: number,
  out: Uint8ClampedArray,
  step = 1,
) {
  const readers = levels.map((one) => new LevelReader(one));
  const where = mapping(patch, plane, w, span, width, height);
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
  for (let r = 0; r < height; r += step) {
    const i0 = Math.min(Math.floor(r / STEP), down - 2), ti = (r - i0 * STEP) / STEP;
    for (let c = 0; c < width; c += step) {
      const o = (r * width + c) * 4;
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
          out[o + 3] = 0;
          continue;
        }
        alpha = coverageAt(patch, sheet, gi, gj);
      }
      if (alpha <= 0.02) {
        out[o + 3] = 0;
        for (let rr = r; rr < Math.min(r + step, height); rr++)
          for (let cc = c; cc < Math.min(c + step, width); cc++) out[(rr * width + cc) * 4 + 3] = 0;
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
        out[o + 3] = 0;
        continue;
      }
      out[o] = out[o + 1] = out[o + 2] = value;
      out[o + 3] = Math.round(255 * Math.min(1, alpha));
      drawn++;
      // The rest of this pixel's square, while it is standing in for them.
      for (let rr = r; rr < Math.min(r + step, height); rr++)
        for (let cc = c; cc < Math.min(c + step, width); cc++) {
          if (rr === r && cc === c) continue;
          const q = (rr * width + cc) * 4;
          out[q] = out[q + 1] = out[q + 2] = value;
          out[q + 3] = out[o + 3];
        }
    }
  }
  return { coarser, drawn };
}

// How many points across the image the chunks are worked out from; between them the piece is smooth.
const LATTICE = 33;

/**
 * The chunks of `level` that drawing this plane reads: the bounding box of every cell of a lattice
 * over the image, with a voxel to spare for interpolation.
 */
export function planeChunks(
  patch: Patch,
  plane: SurfacePlane,
  w: number,
  span: number,
  width: number,
  height: number,
  level: ZarrLevel,
): Chunk[] {
  const where = mapping(patch, plane, w, span, width, height);
  const point = new Float64Array(3);
  const positions = new Float32Array(LATTICE * LATTICE * 3).fill(NaN);
  for (let i = 0; i < LATTICE; i++)
    for (let j = 0; j < LATTICE; j++) {
      const [sheet, gi, gj] = where(
        (i / (LATTICE - 1)) * (height - 1),
        (j / (LATTICE - 1)) * (width - 1),
      );
      if (coverageAt(patch, sheet, gi, gj) > 0.02 && positionAt(patch, sheet, gi, gj, point)) {
        positions.set(point, (i * LATTICE + j) * 3);
      }
    }
  const f = level.factor;
  const keys = new Map<string, Chunk>();
  const lo = [0, 0, 0], hi = [0, 0, 0];
  for (let i = 0; i + 1 < LATTICE; i++)
    for (let j = 0; j + 1 < LATTICE; j++) {
      lo.fill(Infinity);
      hi.fill(-Infinity);
      // Whichever corners of the cell the piece reaches: a cell beside a hole has some, and the
      // pixels there are drawn like any other, so their chunks are needed like any other.
      let corners = 0;
      for (const k of [i * LATTICE + j, i * LATTICE + j + 1, (i + 1) * LATTICE + j, (i + 1) * LATTICE + j + 1]) {
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

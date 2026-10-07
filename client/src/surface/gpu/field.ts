/**
 * The flattening as something a GPU can read: the march's table packed into one 3-D image.
 *
 * `positionAt` (`patch.ts`) is a trilinear read of `Patch.P` over (layer, v, u) — eight corners,
 * weights multiplied out, twenty-four multiply-adds — and the CPU renderer cannot afford it: it
 * evaluates it at every eighth pixel and interpolates the rest (`drawPlane`'s `STEP`). That same
 * read is one of the things a texture unit does, so the table belongs in a texture.
 *
 * The packing turns on a coincidence in the fit, which is worth stating because everything below
 * depends on it: `P` holds `NaN` exactly where `A` holds 0 — both are written in the same branch of
 * `table()` and nowhere else. So put the position in RGB and `A` in alpha, with zeros rather than
 * `NaN` in the dead texels, and a trilinear read gives both answers at once:
 *
 *   - `rgb` is exactly what `positionAt` would have returned
 *   - `a` reaches 1 only when every corner carrying weight was valid, because `A` is 0 or 1 and the
 *     eight weights sum to 1 — so `a < 1` is exactly `positionAt`'s `return false`, and `a` on its
 *     own is `coverageAt`
 *
 * Nothing in here touches WebGL. It is typed arrays in and typed arrays out, so the day the renderer
 * is rewritten against another API this file is not part of the rewrite.
 */
import type { Patch } from "../patch";
import type { Walked } from "../render";
import { sheetOf } from "../render";

// How finely the walk is inverted.  Two thousand steps over a piece thirty sheets deep is sixty a
// sheet, far finer than the table itself, and it is eight kilobytes.
const WALK_STEPS = 2048;

export interface Field {
  // The grid, and how many layers of it the table holds.
  nu: number;
  nv: number;
  layers: number;
  // Layers to a whole sheet, and how many whole sheets each way the table reaches.
  per: number;
  K: number;
  /*
   * RGBA, float32, laid out (layer, v, u) with u fastest — which is the order `P` is already in, and
   * the order a 3-D texture of width `nu`, height `nv` and depth `layers` wants.
   */
  data: Float32Array;
  /*
   * The walk inverted: the winding at each of `WALK_STEPS` equal distances from `lo` to `hi` voxels
   * through the papyrus.
   *
   * A cut spreads the sheets by distance, because the papyrus is not the same thickness everywhere
   * and spreading by winding draws the thin parts magnified.  Written out this way a cut needs no
   * map of its own: the card says which distances its two edges are at, and every pixel between
   * reads its winding here.
   */
  walk: Float32Array;
  lo: number;
  hi: number;
}

/** The table packed for upload.  One pass over `P`; nothing is interpolated here. */
export function fieldOf(patch: Patch, walked: Walked): Field {
  const { nu, nv, K, per, P, A } = patch;
  const layers = 2 * K * per + 1;
  const count = nu * nv;
  const data = new Float32Array(layers * count * 4);
  for (let node = 0; node < layers * count; node++) {
    // A node the march never reached stays all zero: zero position, and zero weight in the alpha
    // that says so.  `NaN` would poison the interpolation of every neighbour.
    if (A[node] < 0.5) continue;
    const from = node * 3, into = node * 4;
    data[into] = P[from];
    data[into + 1] = P[from + 1];
    data[into + 2] = P[from + 2];
    data[into + 3] = 1;
  }
  const lo = walked.walked[0];
  const hi = walked.walked[walked.walked.length - 1];
  const walk = new Float32Array(WALK_STEPS);
  for (let at = 0; at < WALK_STEPS; at++) {
    walk[at] = sheetOf(walked, lo + ((hi - lo) * at) / (WALK_STEPS - 1));
  }
  return { nu, nv, layers, per, K, data, walk, lo, hi };
}

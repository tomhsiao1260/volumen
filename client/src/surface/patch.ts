/**
 * @file A flattened piece of papyrus: a grid of points over one sheet, and the same grid over each of
 * the sheets either side of it.
 *
 * The result is a table P[k][i][j] of scan positions: row i and column j of the grid on layer
 * w = k / per, where whole w are sheets and the rest lie evenly between them.  Drawing a layer is
 * then looking positions up in the table and sampling the scan there (`render.ts`).
 *
 * Each sheet is *fitted*, not traced: the grid is held together — its edges keep the length they were
 * laid out with, its diagonals too, so that the card's scale stays honest — while the prediction
 * pulls each point along its normal onto the nearest sheet, gently at first.  Points that end up on
 * no sheet are holes, and the card shows them as nothing rather than as a plausible picture of the
 * wrong place.
 *
 * The obvious alternative — follow a streamline from every point and work out afterwards which sheet
 * each one landed on — is what this replaced, and it tore: measured on Scroll 1, 7.5% of neighbouring
 * points ended up on different sheets, against 0.0% here, and whole layers slid into the gaps between
 * sheets.  A grid that is held together cannot do that, because a point would have to drag its
 * neighbours with it.
 */

import type { LasagnaField, Vec3 } from "./field";
import type { ChainSaid } from "./types";

// Positions and directions are full-resolution voxels in (z, y, x) order.
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit = (a: Vec3): Vec3 => mul(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));
// The cross product of the vectors as (x, y, z), written in (z, y, x) order.
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[2] * b[1] - a[1] * b[2],
  a[0] * b[2] - a[2] * b[0],
  a[1] * b[0] - a[0] * b[1],
];

function normalAt(field: LasagnaField, p: Vec3, ref: Vec3): Vec3 | null {
  if (!field.normal(p[0], p[1], p[2], ref[0], ref[1], ref[2])) return null;
  return [field.out[0], field.out[1], field.out[2]];
}

/**
 * The direction away from the scroll's axis at `p`, from the umbilicus' points (x, y, z), sorted by
 * z; undefined without them.
 */
export function outward(
  umbilicus: { x: number; y: number; z: number }[] | null,
  p: Vec3,
): Vec3 | undefined {
  if (umbilicus === null || umbilicus.length === 0) return undefined;
  let a = umbilicus[0], b = umbilicus[umbilicus.length - 1];
  for (let i = 0; i + 1 < umbilicus.length; i++) {
    if (umbilicus[i].z <= p[0] && umbilicus[i + 1].z >= p[0]) {
      a = umbilicus[i];
      b = umbilicus[i + 1];
      break;
    }
  }
  const t = b.z === a.z ? 0 : Math.min(1, Math.max(0, (p[0] - a.z) / (b.z - a.z)));
  const dy = p[1] - (a.y + (b.y - a.y) * t), dx = p[2] - (a.x + (b.x - a.x) * t);
  const length = Math.hypot(dy, dx);
  return length < 1 ? undefined : [0, dy / length, dx / length];
}

/**
 * The directions a patch is drawn in on the tangent plane with normal `n`: `down` along +z (as the
 * scroll stands), and `right` such that the screen looks along +n, from the inside of the sheet
 * outward — the papyrus was rolled with the writing inside, so this is the side it was read from.
 */
export function frame(n: Vec3) {
  let down: Vec3 = add([1, 0, 0], mul(n, -n[0]));
  if (Math.hypot(...down) < 0.2) down = add([0, 1, 0], mul(n, -n[1]));
  down = unit(down);
  return { down, right: unit(cross(down, n)) };
}

export interface PatchGrid {
  // Columns and rows of the grid, both odd so that it has a centre point, and their spacing in voxels.
  nu: number;
  nv: number;
  hu: number;
  hv: number;
}

export interface Patch extends PatchGrid {
  // Whole sheets on each side of the base in the table, and table layers per sheet.
  K: number;
  per: number;
  // P[((k + K·per)·nv + i)·nu + j]·3: the position of grid point (i, j) on layer k / per.
  P: Float32Array;
  // A[…]: how much of a sheet is there, 0 to 1.  Whole where the fit ended on a predicted face,
  // nothing where the papyrus has parted or is missing, and between the two over the half sheet
  // leading to a neighbour that is not there — which is what makes the edge of a hole a fade rather
  // than a staircase of grid cells.
  A: Float32Array;
  right: Vec3;
  down: Vec3;
  // How far the points of each sheet ended up from the prediction's nearest band, in voxels: the
  // fit's own account of how well it went, the base sheet first and then the ones around it.
  off: number[];
  /*
   * How far the sheet ended from each place a person said it passes through, in voxels.  It is the
   * one number that answers "did the fit listen to me": everything else says how the piece looks to
   * itself, and this says whether what was said got through.
   */
  said: { chain: string; away: number }[];
  /*
   * Per chain: which wrap of this piece it was answered on, how many different wraps its points were
   * found on before it was listened to, how many of its points this piece could use at all, and how
   * many wraps it had to be moved to keep off another chain's wrap.
   */
  spread: { chain: string; sheet: number; sheets: number; used: number; of: number; moved: number }[];
  // The normal at the base's centre: the direction w grows in.
  normal: Vec3;
}

/**
 * The base surface through `p0`, where the normal is `n0`: grid positions (flat z, y, x) and their
 * normals.  A height field H over the tangent plane, H = 0 at the centre, whose slopes match the
 * field's normals in the least-squares sense (SOR), resampling the normals where the surface moved
 * to a few times over.
 */
function baseSurface(field: LasagnaField, p0: Vec3, n0: Vec3, grid: PatchGrid) {
  const { nu, nv, hu, hv } = grid;
  const { right, down } = frame(n0);
  const ci = (nv - 1) / 2, cj = (nu - 1) / 2;
  const count = nu * nv;
  const H = new Float64Array(count);
  const gu = new Float64Array(count), gv = new Float64Array(count), wt = new Float64Array(count);
  const position = (i: number, j: number, h: number) =>
    add(add(p0, mul(right, (j - cj) * hu)), add(mul(down, (i - ci) * hv), mul(n0, h)));

  for (let pass = 0; pass < 3; pass++) {
    for (let i = 0; i < nv; i++)
      for (let j = 0; j < nu; j++) {
        const k = i * nu + j;
        const n = normalAt(field, position(i, j, H[k]), n0);
        const cn = n === null ? 0 : dot(n, n0);
        if (n === null || cn < 0.3) {
          gu[k] = gv[k] = 0;
          wt[k] = 0.01;
          continue;
        }
        gu[k] = Math.max(-2, Math.min(2, -dot(n, right) / cn));
        gv[k] = Math.max(-2, Math.min(2, -dot(n, down) / cn));
        wt[k] = 1;
      }
    if (pass === 0) {
      // A starting guess: the slopes integrated along the middle row, then down every column.
      for (let j = cj + 1; j < nu; j++) H[ci * nu + j] = H[ci * nu + j - 1] + (hu * (gu[ci * nu + j - 1] + gu[ci * nu + j])) / 2;
      for (let j = cj - 1; j >= 0; j--) H[ci * nu + j] = H[ci * nu + j + 1] - (hu * (gu[ci * nu + j + 1] + gu[ci * nu + j])) / 2;
      for (let j = 0; j < nu; j++) {
        for (let i = ci + 1; i < nv; i++) H[i * nu + j] = H[(i - 1) * nu + j] + (hv * (gv[(i - 1) * nu + j] + gv[i * nu + j])) / 2;
        for (let i = ci - 1; i >= 0; i--) H[i * nu + j] = H[(i + 1) * nu + j] - (hv * (gv[(i + 1) * nu + j] + gv[i * nu + j])) / 2;
      }
    }
    for (let sweep = 0; sweep < 120; sweep++) {
      for (let i = 0; i < nv; i++)
        for (let j = 0; j < nu; j++) {
          if (i === ci && j === cj) continue;
          const k = i * nu + j;
          let num = 0, den = 0, w: number;
          if (j + 1 < nu) (w = Math.min(wt[k], wt[k + 1])), (num += w * (H[k + 1] - (hu * (gu[k] + gu[k + 1])) / 2)), (den += w);
          if (j > 0) (w = Math.min(wt[k], wt[k - 1])), (num += w * (H[k - 1] + (hu * (gu[k] + gu[k - 1])) / 2)), (den += w);
          if (i + 1 < nv) (w = Math.min(wt[k], wt[k + nu])), (num += w * (H[k + nu] - (hv * (gv[k] + gv[k + nu])) / 2)), (den += w);
          if (i > 0) (w = Math.min(wt[k], wt[k - nu])), (num += w * (H[k - nu] + (hv * (gv[k] + gv[k - nu])) / 2)), (den += w);
          H[k] += 1.8 * (num / den - H[k]);
        }
    }
  }
  const X = new Float64Array(count * 3), N = new Float64Array(count * 3);
  for (let i = 0; i < nv; i++)
    for (let j = 0; j < nu; j++) {
      const k = i * nu + j;
      const p = position(i, j, H[k]);
      X.set(p, k * 3);
      N.set(normalAt(field, p, n0) ?? n0, k * 3);
    }
  return { X, N, right, down };
}

// Passes of the fit: the prediction's pull grows over the first part of them, the rest settles.
const SWEEPS = 30;
// Of a sheet's spacing: how far the fit looks for a sheet, and how far a sheet may drift from where
// it started before it is no longer the same sheet.
const LOOK = 0.45;
/*
 * Of a sheet's spacing: how near the next sheet may be and how far, when a piece steps from one to
 * the next.  The search has to start beyond the sheet it is leaving — the prediction marks both of
 * its faces, and a search that starts too near finds the far one and calls it the next sheet, which
 * collapses the whole piece into the thickness of one — and stop before the sheet after next.
 */
const NEXT_NEAREST = 0.6;
const NEXT_FURTHEST = 1.5;
/*
 * How far either way the wrap spacing is measured at each node, of the estimate taken at the seed:
 * far enough to see a wrap on each side, not so far that a crushed neighbourhood decides for a
 * whole one.  And how far from that estimate a node's own answer is allowed to be, since a single
 * reading in a damaged place should not scale that node's whole fit.
 */
const SPACING_REACH = 1.6;
const SPACING_LEAST = 0.35;
const SPACING_MOST = 2.2;

/**
 * How far apart the wraps are at each node of a sheet, measured along that node's own normal.
 *
 * The one number taken at the seed is not enough.  Measured over six places on Scroll 1, the wraps
 * within a single card are 9 to 65 voxels apart while the seed said 38 or 43 — and every window and
 * clamp in the fit is scaled by it.  Where it is too big, the search reaches past the halfway line
 * between two wraps and the fit settles on the wrong one; where it is too small, the step to the
 * next wrap falls short.  Each node knowing its own spacing is what keeps both inside the wrap they
 * belong to.
 */
function spacingAt(
  field: LasagnaField,
  X: Float64Array,
  N: Float64Array,
  count: number,
  spacing: number,
  out: Float64Array,
) {
  const reach = spacing * SPACING_REACH;
  const least = spacing * SPACING_LEAST, most = spacing * SPACING_MOST;
  for (let k = 0; k < count; k++) {
    const o = k * 3;
    const here = field.spacingAt(X[o], X[o + 1], X[o + 2], N[o], N[o + 1], N[o + 2], reach);
    out[k] = Number.isNaN(here) ? spacing : Math.min(most, Math.max(least, here));
  }
}
/*
 * How far a sheet may drift, of its spacing, while it is fitted: from the base surface, which is a
 * guess made from the normals and has to be free to find the papyrus, and from a step, which has
 * already landed on the next sheet and only wants tidying.  Left as free as the base, a stepped
 * sheet slides back onto the one it came from wherever the prediction is stronger there, and the
 * piece folds up — at one place on Scroll 1 the sheets ended 8 voxels apart where the prediction
 * said 38.
 */
const BASE_STRAY = 0.45;
const STEP_STRAY = 0.22;
/*
 * And how far it may drift where a person has said where it passes.  The clamp is loose on the base
 * wrap because `baseSurface` is only a guess made from the normals and the fit has to be free to go
 * and find the papyrus.  Where somebody has said where the papyrus is, that reasoning is spent: the
 * starting point is no longer a guess, and a loose clamp there is only room for the fit to undo what
 * it was told.  Measured: with the base wrap left at 0.45 the fit walked back 23 voxels from places
 * it had been given, which is most of the way to the next wrap.
 */
const TOLD_STRAY = 0.1;
// How much of a node has to have come from a person before it counts as papyrus on their word alone.
const SAID_IS_PAPYRUS = 0.5;
/*
 * Two chains are one layer only if they pass within this much of a wrap of each other sideways and
 * meet within this much of a wrap through the papyrus.  Anything else is two layers, which is what
 * drawing a second annotation means.
 */
const SAME_NEAR = 0.6;
const SAME_DEPTH = 0.25;
const PIN_ROUNDS = 8;
// Near enough that a place counts as met: well under one step of the grid, which is about six voxels.
const PIN_CLOSE = 1;

function resampleNormals(field: LasagnaField, X: Float64Array, N: Float64Array, count: number, reference: Vec3) {
  for (let k = 0; k < count; k++) {
    const o = k * 3;
    if (field.normal(X[o], X[o + 1], X[o + 2], reference[0], reference[1], reference[2])) {
      N[o] = field.out[0];
      N[o + 1] = field.out[1];
      N[o + 2] = field.out[2];
    } else {
      N[o] = reference[0];
      N[o + 1] = reference[1];
      N[o + 2] = reference[2];
    }
  }
}

// Each point's move replaced by the middle one of its 3×3 neighbourhood: one point jumping to a
// sheet of its own is what stretches the grid, and the median simply outvotes it.
function median3(from: Float64Array, into: Float64Array, nu: number, nv: number) {
  const around: number[] = [];
  for (let i = 0; i < nv; i++)
    for (let j = 0; j < nu; j++) {
      around.length = 0;
      for (let di = -1; di <= 1; di++)
        for (let dj = -1; dj <= 1; dj++) {
          const a = i + di, b = j + dj;
          if (a < 0 || b < 0 || a >= nv || b >= nu) continue;
          const value = from[a * nu + b];
          if (!Number.isNaN(value)) around.push(value);
        }
      if (around.length === 0) {
        into[i * nu + j] = NaN;
        continue;
      }
      around.sort((x, y) => x - y);
      into[i * nu + j] = around[around.length >> 1];
    }
}

// Pulls an edge back to the length it should have, moving both ends half way.
function holdEdge(X: Float64Array, a: number, b: number, rest: number, stiffness: number) {
  const p = a * 3, q = b * 3;
  const dz = X[q] - X[p], dy = X[q + 1] - X[p + 1], dx = X[q + 2] - X[p + 2];
  const length = Math.sqrt(dz * dz + dy * dy + dx * dx);
  if (length < 1e-6) return;
  const move = (stiffness * (length - rest)) / length / 2;
  X[p] += dz * move;
  X[p + 1] += dy * move;
  X[p + 2] += dx * move;
  X[q] -= dz * move;
  X[q + 1] -= dy * move;
  X[q + 2] -= dx * move;
}

/**
 * Fits the grid `X` onto one sheet.  The edges are held at the spacing the grid was laid out with —
 * and the diagonals too, which is what keeps the card's scale honest — the bend is smoothed, and the
 * prediction pulls each point along its normal, the pull growing from nothing so that the grid
 * settles into a shape before it starts believing the data.
 *
 * Three things keep a sheet from tearing, and all three are needed: no point may move further in one
 * sweep than the grid's own step, so it cannot outrun its neighbours; no point may drift more than
 * half a sheet from where it started, or many small pulls walk it onto the next sheet; and the pull
 * is the median of a neighbourhood, so a single point cannot drag the grid after it.
 *
 * Returns which points ended up on a sheet.  The rest are holes: the papyrus has parted there, or is
 * not there at all, and a card showing a plausible picture of the wrong place would be worse.
 */
function fitSheet(
  field: LasagnaField,
  X: Float64Array,
  grid: PatchGrid,
  // How far apart the wraps are AT EACH NODE.  One number for the whole card is not enough: measured
  // on Scroll 1 the wraps of a single card are 9 to 65 voxels apart, while the estimate taken in one
  // small box at the seed said 38 or 43.  Everything here is scaled by it, and where the estimate is
  // too big the search window and the drift clamp reach past the halfway line between two wraps —
  // so the fit finds the wrap next door, calls it the nearest one, and the clamp holds it there.
  // The springs then carry the whole neighbourhood across, so nothing is torn and nothing shows.
  sp: Float64Array,
  reference: Vec3,
  // How far each node may drift from where this fit started, as a part of its own wrap spacing.  One
  // number for the whole sheet, until a person has said something about part of it.
  wander: number | Float64Array = BASE_STRAY,
) {
  const { nu, nv, hu, hv } = grid;
  const count = nu * nv;
  const N = new Float64Array(count * 3);
  const start = X.slice();
  const moves = new Float64Array(count);
  const smooth = new Float64Array(count);
  const held = new Uint8Array(count);
  const span = (k: number) => sp[k] * LOOK;
  const stray = (k: number) => sp[k] * (typeof wander === "number" ? wander : wander[k]);
  // A node that was told where to be may go there, however far that is: the clamp is what keeps the
  // fit from wandering onto a neighbouring sheet, and being on the neighbouring sheet is the very
  // thing being corrected.
  const most = Math.min(hu, hv);
  const diagonal = Math.hypot(hu, hv);

  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    if (sweep % 10 === 0) resampleNormals(field, X, N, count, reference);
    const settling = Math.min(1, sweep / (SWEEPS * 0.6));
    const pull = settling * settling;
    // Asking the prediction is most of the work and the answer hardly changes between one sweep and
    // the next, so it is asked every other sweep and the grid settles in between.
    if (sweep % 2 === 0 || sweep >= SWEEPS - 2) {
      for (let k = 0; k < count; k++) {
        const o = k * 3;
        moves[k] = field.nearestSheet(X[o], X[o + 1], X[o + 2], N[o], N[o + 1], N[o + 2], span(k));
      }
      median3(moves, smooth, nu, nv);
    }
    if (pull > 0) {
      for (let k = 0; k < count; k++) {
        const t = smooth[k];
        if (Number.isNaN(t)) continue;
        const o = k * 3;
        let move = Math.max(-most, Math.min(most, t * pull * 0.7));
        const drift =
          (X[o] + N[o] * move - start[o]) * N[o] +
          (X[o + 1] + N[o + 1] * move - start[o + 1]) * N[o + 1] +
          (X[o + 2] + N[o + 2] * move - start[o + 2]) * N[o + 2];
        const loose = stray(k);
        if (Math.abs(drift) > loose) move += Math.sign(drift) * loose - drift;
        X[o] += N[o] * move;
        X[o + 1] += N[o + 1] * move;
        X[o + 2] += N[o + 2] * move;
      }
    }
    // The grid answers back: three passes, so that its shape weighs as much as the pull.
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < nv; i++)
        for (let j = 0; j < nu; j++) {
          const k = i * nu + j;
          if (j + 1 < nu) holdEdge(X, k, k + 1, hu, 0.6);
          if (i + 1 < nv) holdEdge(X, k, k + nu, hv, 0.6);
          if (i + 1 < nv && j + 1 < nu) holdEdge(X, k, k + nu + 1, diagonal, 0.3);
          if (i + 1 < nv && j > 0) holdEdge(X, k, k + nu - 1, diagonal, 0.3);
        }
    }
    for (const [di, dj] of [[0, 1], [1, 0]] as const) {
      for (let i = di; i < nv - di; i++)
        for (let j = dj; j < nu - dj; j++) {
          const k = (i * nu + j) * 3, a = k - (di * nu + dj) * 3, b = k + (di * nu + dj) * 3;
          for (let c = 0; c < 3; c++) X[k + c] += ((X[a + c] + X[b + c]) / 2 - X[k + c]) * 0.12;
        }
    }
  }

  resampleNormals(field, X, N, count, reference);
  let off = 0, on = 0;
  for (let k = 0; k < count; k++) {
    const o = k * 3;
    const t = field.nearestSheet(X[o], X[o + 1], X[o + 2], N[o], N[o + 1], N[o + 2], Math.max(2, most * 0.6));
    held[k] = Number.isNaN(t) ? 0 : 1;
    if (held[k]) {
      off += Math.abs(t);
      on++;
    }
  }
  return { held, off: on === 0 ? NaN : off / on };
}

/**
 * Fills the small holes: a point with no sheet of its own, ringed by points that have one, is on the
 * papyrus too — the fit's springs have already put it where the surface goes, and the prediction
 * simply has nothing to say there.  Only holes a point or two across close this way; a real gap
 * stays a gap.
 */
function fillHoles(held: Uint8Array, nu: number, nv: number) {
  for (let round = 0; round < 2; round++) {
    const was = held.slice();
    for (let i = 0; i < nv; i++)
      for (let j = 0; j < nu; j++) {
        const k = i * nu + j;
        if (was[k]) continue;
        let around = 0, ringed = 0;
        for (let di = -1; di <= 1; di++)
          for (let dj = -1; dj <= 1; dj++) {
            const a = i + di, b = j + dj;
            if ((di === 0 && dj === 0) || a < 0 || b < 0 || a >= nv || b >= nu) continue;
            around++;
            if (was[a * nu + b]) ringed++;
          }
        if (around >= 5 && ringed >= around - 2) held[k] = 1;
      }
  }
}

/**
 * The next sheet out: the whole layer moved one sheet's spacing along its own normals.  Where it
 * lands is left to the fit, which reaches half a sheet either way; letting each point find its own
 * next sheet first sounds better but is not — where the prediction is patchy the points disagree and
 * the layer arrives already torn.
 */
function nextSheet(
  field: LasagnaField,
  X: Float64Array,
  grid: PatchGrid,
  dir: 1 | -1,
  sp: Float64Array,
  reference: Vec3,
) {
  const { nu, nv } = grid;
  const count = nu * nv;
  const out = new Float64Array(count * 3);
  const N = new Float64Array(count * 3);
  const moves = new Float64Array(count);
  const smooth = new Float64Array(count);
  resampleNormals(field, X, N, count, reference);
  /*
   * Each point to its own next sheet, since the sheets are not evenly spaced (`nextBand`); the
   * spacing where the prediction has nothing to say there, and the median of the neighbours in
   * place of an answer that stands out, so that one bad reading cannot drag the grid after it.
   */
  for (let k = 0; k < count; k++) {
    const o = k * 3;
    moves[k] = field.nextBand(
      X[o],
      X[o + 1],
      X[o + 2],
      N[o] * dir,
      N[o + 1] * dir,
      N[o + 2] * dir,
      sp[k] * NEXT_NEAREST,
      sp[k] * NEXT_FURTHEST,
    );
  }
  median3(moves, smooth, nu, nv);
  for (let k = 0; k < count; k++) {
    const move = Number.isNaN(smooth[k]) ? sp[k] : smooth[k];
    const o = k * 3;
    for (let c = 0; c < 3; c++) out[o + c] = X[o + c] + N[o + c] * dir * move;
  }
  return out;
}

/**
 * The patch over `grid` around `seed` (full-resolution voxels, z/y/x), `K` sheets each way, or
 * undefined where there is no sheet to build it on.  w grows in the direction of the normal that
 * agrees with `towards` — away from the scroll's axis, or the way a previous patch went.  `spacing`
 * is how many voxels apart the sheets are here, which sets the whole patch's scale.
 */
/*
 * A place a person has said one of the wraps passes through, and the grid node nearest it.
 */
interface Held {
  // Which chain said it, so that the piece can answer each one separately.
  chain: string;
  node: number;
  at: Vec3;
  // The square of the grid it was last found over, so the next look can start there.
  cell?: { i: number; j: number };
}

/*
 * How far a thing said reaches across the grid, in wraps, and how long the field is relaxed for.  A
 * person pointing at the papyrus means the papyrus around it — about a wrap of it — and not the
 * whole card.
 */
const SAID_REACH = 1;
const SAID_PASSES = 80;
/*
 * And how much further it reaches over papyrus the prediction had nothing to say about.  A hole is
 * where the fit found no band at all — the wrap has dived into the gap, or the prediction is simply
 * missing — and it is exactly where a person has something to add and nothing is arguing back.  So a
 * correction carries across a hole rather than dying in the middle of it, which is what makes saying
 * something at the edge of a pit close the pit.
 */
const SAID_OVER_HOLES = 3;
// Of a wrap: how far from the piece a place may be and still be about it.
const SAID_OF_PIECE = 1.5;
/*
 * And how many times the correction and the grid answer each other before the fit starts.  Once is
 * not enough in either direction: a wrap moved onto a place and handed straight over is pulled back
 * off it by the springs, which have no opposition until the fit's own pull has grown; and a wrap
 * relaxed without the correction being put back simply returns to where it was.  Alternating them
 * converges on the shape that meets what was said and is still a grid.
 */
const SAID_ROUNDS = 6;

/**
 * The correction a wrap needs to meet what was said, as a field over the whole grid: how far each
 * node should move along its normal.
 *
 * The nodes that were told take the distance to their place exactly.  Every other node solves
 * ∇²u = u/λ², with λ one wrap — so the correction is smooth everywhere, has no seam anywhere, and
 * dies away over about a wrap.  That is the whole of what an annotation does now.
 *
 * It used to do five things: it was spread by nearest-wins over a radius in grid steps, pushed in by
 * six rounds of springs and smoothing, written over the median that the fit uses to vote down a lone
 * disagreeing node, and it released the drift clamp around itself.  With a hundred places said on one
 * card those five fought each other — nearest-wins cut the card into a hundred cells with a step at
 * every boundary, and the released clamps between them left the fit free to drift from all of it.
 * Measured on the user's own card, the first two things said made the piece flatter and the rest made
 * it worse than saying nothing at all (`pup/flatter.cjs`).
 *
 * Now it is a starting point and nothing else.  The fit that follows is the fit that runs when
 * nobody has said anything, with all three of its safeguards — a step no longer than the grid, a
 * drift clamp, and the median — doing exactly what they do the rest of the time.
 */
function saidField(
  grid: PatchGrid,
  sp: Float64Array,
  // The nodes that are to take a value exactly, and what each is to take.  Worked out by the caller
  // from where the place falls on the wrap, not from the node, because a node is never quite under
  // the place: see `placeValues`.
  held: { node: number; value: number }[],
  u: Float64Array,
  // Where the wrap was found to be on papyrus at all, from the piece built before anything was said.
  papyrus: Uint8Array | undefined,
) {
  const { nu, nv, hu, hv } = grid;
  const count = nu * nv;
  const fixed = new Uint8Array(count);
  u.fill(0);
  for (const one of held) {
    u[one.node] = one.value;
    fixed[one.node] = 1;
  }
  const step = (hu + hv) / 2;
  for (let pass = 0; pass < SAID_PASSES; pass++)
    for (let i = 0; i < nv; i++)
      for (let j = 0; j < nu; j++) {
        const k = i * nu + j;
        if (fixed[k] === 1) continue;
        // The grid's edge mirrors, so a correction reaching it is not pulled back to nothing.
        const left = j > 0 ? u[k - 1] : u[k + 1];
        const right = j + 1 < nu ? u[k + 1] : u[k - 1];
        const above = i > 0 ? u[k - nu] : u[k + nu];
        const below = i + 1 < nv ? u[k + nu] : u[k - nu];
        const over = papyrus === undefined || papyrus[k] === 1 ? 1 : SAID_OVER_HOLES;
        const away = step / (sp[k] * SAID_REACH * over);
        u[k] = (left + right + above + below) / (4 + away * away);
      }
}

/*
 * The wrap's own normal at each node, from the grid rather than from the prediction.
 *
 * The predicted normal is what the wrap is built along, but it is not what the wrap IS: where the
 * prediction is wrong — which is exactly where a person annotates — the two point different ways.
 * Measuring a place against the predicted normal there reads as no distance at all while the papyrus
 * is ten voxels away, so what a place is measured against, and the way the wrap is moved to meet it,
 * are both taken from the surface the person is looking at.
 */
function surfaceNormals(X: Float64Array, nu: number, nv: number, out: Float64Array, towards: Vec3) {
  const at = (k: number, c: number) => X[k * 3 + c];
  for (let i = 0; i < nv; i++)
    for (let j = 0; j < nu; j++) {
      const k = i * nu + j;
      const right = j + 1 < nu ? k + 1 : k, left = j > 0 ? k - 1 : k;
      const below = i + 1 < nv ? k + nu : k, above = i > 0 ? k - nu : k;
      const du = [0, 1, 2].map((c) => at(right, c) - at(left, c));
      const dv = [0, 1, 2].map((c) => at(below, c) - at(above, c));
      let n = [
        du[1] * dv[2] - du[2] * dv[1],
        du[2] * dv[0] - du[0] * dv[2],
        du[0] * dv[1] - du[1] * dv[0],
      ];
      let length = Math.hypot(n[0], n[1], n[2]);
      // A torn or missing corner leaves no triangle to take a normal from; the way the piece grows
      // is the honest fallback there.
      if (!(length > 1e-9)) {
        n = [towards[0], towards[1], towards[2]];
        length = Math.hypot(n[0], n[1], n[2]) || 1;
      }
      const sign = n[0] * towards[0] + n[1] * towards[1] + n[2] * towards[2] < 0 ? -1 : 1;
      for (let c = 0; c < 3; c++) out[k * 3 + c] = (sign * n[c]) / length;
    }
}

/*
 * Where a place falls on a wrap: the square of the grid it is over, the nearest point of that square
 * to it, and how far off the wrap it is along the wrap's own normal.
 *
 * This is the whole of the fix to what an annotation does.  Before, a place was tied to the nearest
 * NODE and the wrap was moved until that node lay in the place's normal plane — which reads as a
 * perfect answer while the surface between the nodes passes ten voxels away, because a node is on
 * average half a grid step to the side of the place and the wrap is tilted there.  Measured on the
 * user's own fifteen-point chain, every place was reported met exactly and four of them were seven
 * to fourteen voxels off the surface being drawn (`pup/onewrap.cjs`).  A place is over a square, not
 * at a node, so the square is what has to be moved.
 */
function onWrap(X: Float64Array, nu: number, nv: number, N: Float64Array, at: Vec3, hint?: { i: number; j: number }) {
  let best:
    | { corners: [number, number, number, number]; gap: number; away: number; over: boolean; i: number; j: number }
    | undefined;
  const look = (i: number, j: number) => {
    const k0 = i * nu + j, k1 = k0 + 1, k2 = k0 + nu, k3 = k2 + 1;
    for (const k of [k0, k1, k2, k3]) if (Number.isNaN(X[k * 3])) return;
    const du = [0, 1, 2].map((c) => X[k1 * 3 + c] - X[k0 * 3 + c]);
    const dv = [0, 1, 2].map((c) => X[k2 * 3 + c] - X[k0 * 3 + c]);
    const d = [0, 1, 2].map((c) => at[c] - X[k0 * 3 + c]);
    const a = du[0] * du[0] + du[1] * du[1] + du[2] * du[2];
    const b = du[0] * dv[0] + du[1] * dv[1] + du[2] * dv[2];
    const c2 = dv[0] * dv[0] + dv[1] * dv[1] + dv[2] * dv[2];
    const det = a * c2 - b * b;
    if (!(det > 1e-9)) return;
    const p = d[0] * du[0] + d[1] * du[1] + d[2] * du[2];
    const q = d[0] * dv[0] + d[1] * dv[1] + d[2] * dv[2];
    // Where in the square the place sits, kept inside it: outside, the edge is the nearest the wrap
    // comes, and that is the honest place to measure from.
    const rawS = (c2 * p - b * q) / det, rawT = (a * q - b * p) / det;
    const s = Math.min(1, Math.max(0, rawS));
    const t = Math.min(1, Math.max(0, rawT));
    const foot = [0, 1, 2].map((c) => X[k0 * 3 + c] + du[c] * s + dv[c] * t);
    const away = Math.hypot(at[0] - foot[0], at[1] - foot[1], at[2] - foot[2]);
    if (best !== undefined && away >= best.away) return;
    // The normal of the square, taken from its corners so that it is the surface's and not the
    // prediction's, and pointing the way the piece grows.
    const n = [0, 1, 2].map(
      (c) => (N[k0 * 3 + c] + N[k1 * 3 + c] + N[k2 * 3 + c] + N[k3 * 3 + c]) / 4,
    );
    const length = Math.hypot(n[0], n[1], n[2]) || 1;
    best = {
      corners: [k0, k1, k2, k3],
      gap: ((at[0] - foot[0]) * n[0] + (at[1] - foot[1]) * n[1] + (at[2] - foot[2]) * n[2]) / length,
      away,
      // Whether the place is over the wrap at all, and not off the side of it.  Only the edge squares
      // can fail this: everywhere else there is a square underneath.  A place off the side can never
      // be met however hard the edge is pulled towards it, so it is neither used nor counted against
      // the fit — it is simply not on this piece, which is what the list already says of it.
      over: Math.abs(rawS - s) <= 1 && Math.abs(rawT - t) <= 1,
      i,
      j,
    };
  };
  // Near where it was last time first, since a place does not move and the wrap only ever shifts a
  // little; the whole grid only when that finds nothing it is over.
  if (hint !== undefined) {
    for (let i = Math.max(0, hint.i - 3); i <= Math.min(nv - 2, hint.i + 3); i++)
      for (let j = Math.max(0, hint.j - 3); j <= Math.min(nu - 2, hint.j + 3); j++) look(i, j);
    if (best !== undefined && best.away < Math.abs(best.gap) * 1.05 + 1e-6) return best;
  }
  best = undefined;
  for (let i = 0; i + 1 < nv; i++) for (let j = 0; j + 1 < nu; j++) look(i, j);
  return best;
}

/*
 * What each told node should take, for the places held on one wrap: the square each place is over,
 * and its four corners all taking the same distance.  Four corners taking one value moves the whole
 * square by it, which moves the surface under the place by it — which is the thing that was wanted,
 * and the thing that tying it to a node did not do.
 */
function placeValues(held: Held[], X: Float64Array, nu: number, nv: number, N: Float64Array) {
  const out: { node: number; value: number }[] = [];
  for (const one of held) {
    const found = onWrap(X, nu, nv, N, one.at, one.cell);
    if (found === undefined || !found.over) continue;
    one.cell = { i: found.i, j: found.j };
    for (const node of found.corners) out.push({ node, value: found.gap });
  }
  return out;
}

/**
 * Which sheet of this piece each thing said belongs to, and where it holds that sheet.
 *
 * Asked of a piece already built, and answered by looking: the nearest point of any of its fitted
 * sheets to the place said.  The obvious cheaper answer — how far along the normal it is from the
 * middle sheet, divided by the spacing — is wrong two sheets out and was measured to be wrong here:
 * the sheets of one card are 42 to 65 voxels apart, so that estimate puts a place on the sheet next
 * to the one it is plainly on, the fit then drags a sheet sixty voxels to meet it, and a person who
 * has just said something true watches their piece get worse.  Drawing more of them made it worse
 * faster, which is exactly what should not happen.
 *
 * A chain is answered by the point of it nearest the seed — not by a vote, because half a chain lying
 * in a part of the piece that has jumped would carry the vote and drag the half that was right after
 * it.  Every point of the chain then holds that one sheet, wherever each was found.
 */
function holdsFor(
  chains: ChainSaid[],
  sheets: Map<number, { X: Float64Array }>,
  nu: number,
  nv: number,
  // How far from any fitted wrap a place may be and still be about this piece.  It has to be more
  // than a wrap: a person says something exactly where the fit has gone wrong, and where the fit has
  // gone wrong there is no fitted wrap near the papyrus they are pointing at — the piece has dived
  // into the gap or has nothing there at all.  Measured on the user's own card, a reach of three grid
  // steps threw away ten of their forty-three places, and they were the ten in the pit.
  reach: number,
  seed: Vec3,
  // How far apart the wraps are here, which is the ruler for "these two chains are the same wrap",
  // and the way w grows, which is what "the wrap further out" means.
  spacing: number,
  outward: Vec3,
) {
  const count = nu * nv;
  const holds = new Map<number, Held[]>();
  // How many sheets of this piece each chain's points were found on before it was listened to.  One
  // is a chain the fit already agrees with; more than one is either the jump being corrected or a
  // chain drawn across the sheets by mistake, and the person is the only one who can tell which.
  const spread: { chain: string; sheet: number; sheets: number; used: number; of: number; moved: number }[] = [];
  /*
   * Each wrap's own normal, so that "which side of this wrap is the chain on, and how far" can be
   * answered.  It is what decides, when two chains land on one wrap, which of them is the wrap out.
   */
  const facing = new Map<number, Float64Array>();
  for (const [which, one] of sheets) {
    const N = new Float64Array(count * 3);
    surfaceNormals(one.X, nu, nv, N, outward);
    facing.set(which, N);
  }
  const nearest = (at: Vec3) => {
    let sheet = 0, node = -1, away = Infinity;
    for (const [which, one] of sheets)
      for (let k = 0; k < count; k++) {
        const o = k * 3;
        if (Number.isNaN(one.X[o])) continue;
        const d = (one.X[o] - at[0]) ** 2 + (one.X[o + 1] - at[1]) ** 2 + (one.X[o + 2] - at[2]) ** 2;
        if (d < away) {
          away = d;
          sheet = which;
          node = k;
        }
      }
    return { sheet, node, away: Math.sqrt(away) };
  };
  // Every chain's answer, before any of them is given a wrap: they have to be seen together for
  // "two chains are two wraps" to mean anything.
  const asked: {
    chain: string;
    // The layer the person put this chain on, by name, if they named one.
    said: string | null;
    sheet: number;
    off: number;
    sheets: number;
    places: { at: Vec3; node: number }[];
    of: number;
    at?: number;
  }[] = [];
  for (const chain of chains) {
    if (chain.kind !== "same" || chain.points.length < 2) continue;
    const places = chain.points
      .map((point) => ({ at: point.at, ...nearest(point.at) }))
      // A place no sheet of this piece comes near is not on this piece at all.
      .filter((one) => one.node >= 0 && one.away <= reach)
      .map((one) => ({
        ...one,
        seedAway: Math.hypot(one.at[0] - seed[0], one.at[1] - seed[1], one.at[2] - seed[2]),
      }));
    if (places.length < 2) {
      // Nothing of it is near this piece.  Saying so is the difference between an annotation that
      // does nothing and an annotation that looks exactly like one that does.
      spread.push({ chain: chain.id, sheet: 0, sheets: 0, used: places.length, of: chain.points.length, moved: 0 });
      continue;
    }
    const anchor = places.reduce((best, one) => (one.seedAway < best.seedAway ? one : best));
    // Which side of that wrap the chain sits on, and how far: the anchor's distance from the wrap
    // itself, signed along the wrap's own normal, which is what puts two chains in the right order
    // through the papyrus.  Asked of the surface rather than of the nearest node, the same way every
    // other distance here is asked, so that a hole or a tilt cannot turn it into nothing.
    const N = facing.get(anchor.sheet)!;
    const under = onWrap(sheets.get(anchor.sheet)!.X, nu, nv, N, anchor.at);
    const off = under === undefined || !Number.isFinite(under.gap) ? 0 : under.gap;
    asked.push({
      chain: chain.id,
      said: chain.layer ?? null,
      sheet: anchor.sheet,
      off,
      sheets: new Set(places.map((place) => place.sheet)).size,
      places,
      of: chain.points.length,
    });
  }

  /*
   * And now the one rule that was missing: two chains are two wraps.
   *
   * A person who draws a second same winding has said "this is another layer" — that is the whole
   * meaning of drawing it separately.  Holding both on one wrap asks a single surface to pass through
   * two layers of papyrus, and since every place said is now met exactly, it does: it weaves from one
   * layer to the other and back between the places, which is what the user saw and reported.  So
   * chains that land on the same wrap are spread over neighbouring wraps, in the order they sit along
   * the normal, and only chains that are genuinely at the same depth — within a quarter of a wrap —
   * are left together, because two chains on one layer is a thing a person may reasonably mean.
   */
  /*
   * Whether two chains are the same layer is asked where they come NEAREST each other, and nowhere
   * else.  How far each of them is from the wrap it was attributed to says nothing: when the fit has
   * collapsed two layers onto one wrap, that wrap sits near both, and both look like it.  Where the
   * two chains pass close by, though, the papyrus is either one sheet — they meet — or two, and then
   * the distance between them along the normal is the thickness of what lies between.
   */
  const between = (a: (typeof asked)[0], b: (typeof asked)[0], N: Float64Array) => {
    let best = Infinity, from = a.places[0], to = b.places[0];
    for (const p of a.places)
      for (const q of b.places) {
        const d = (p.at[0] - q.at[0]) ** 2 + (p.at[1] - q.at[1]) ** 2 + (p.at[2] - q.at[2]) ** 2;
        if (d < best) {
          best = d;
          from = p;
          to = q;
        }
      }
    const o = from.node * 3;
    const along =
      (to.at[0] - from.at[0]) * N[o] + (to.at[1] - from.at[1]) * N[o + 1] + (to.at[2] - from.at[2]) * N[o + 2];
    const away = Math.sqrt(best);
    return { along, sideways: Math.sqrt(Math.max(0, away * away - along * along)) };
  };
  /*
   * The chains, in the order they lie through the papyrus, each given a wrap of its own.
   *
   * Sorting them by depth and handing out consecutive wraps is the only way to keep the order right:
   * resolving clashes one wrap at a time moves a chain onto the wrap of a chain not looked at yet.
   * Chains that meet — near each other sideways and touching through the papyrus — are one layer and
   * keep one wrap between them, because two annotations about one layer is a thing a person may mean.
   */
  const depth = (one: (typeof asked)[0]) => {
    const d = one.sheet + one.off / spacing;
    return Number.isFinite(d) ? d : one.sheet;
  };
  const order = [...asked].sort((a, b) => depth(a) - depth(b));
  /*
   * Which chains are the same layer.
   *
   * The fit's own answer is kept: two chains it put on one wrap stay on one wrap, because two
   * annotations drawn separately are often about the same winding and it is not for the tool to
   * decide otherwise.  Only one thing overrides it, and it is not a guess about what was meant but a
   * fact about the papyrus: where two chains pass close by each other and are further apart through
   * the sheet than a quarter of a wrap, no single surface can hold both, and forcing one to — which
   * is what happened while every place said was met exactly — makes it weave from one layer to the
   * other and back.  Those are split.
   *
   * And a chain the person has named is on the layer of that name and no other: same name, same wrap;
   * different names, different wraps; whatever the fit thought.  That is the whole of what a person
   * can usually see, and having to say instead how many wraps apart two places are — which they often
   * cannot know — is what would make the tool unusable.
   */
  const layers: { chains: typeof asked; said: string | null }[] = [];
  const cannot = (a: (typeof asked)[0], b: (typeof asked)[0]) => {
    const { along, sideways } = between(a, b, facing.get(a.sheet)!);
    return sideways <= spacing * SAME_NEAR && Math.abs(along) > spacing * SAME_DEPTH;
  };
  for (const one of order) {
    if (one.said !== null) {
      const already = layers.find((layer) => layer.said === one.said);
      if (already !== undefined) already.chains.push(one);
      else layers.push({ chains: [one], said: one.said });
      continue;
    }
    const with_ = layers.find(
      (layer) =>
        layer.said === null &&
        layer.chains[0].sheet === one.sheet &&
        !layer.chains.some((each) => cannot(each, one)),
    );
    if (with_ !== undefined) with_.chains.push(one);
    else layers.push({ chains: [one], said: null });
  }
  /*
   * And where each layer goes: as near as it can to where its chains were found, and never onto the
   * wrap of the layer before it.
   */
  const wraps = [...sheets.keys()].sort((a, b) => a - b);
  const lowest = wraps[0] ?? 0, highest = wraps[wraps.length - 1] ?? 0;
  let above = -Infinity;
  for (const layer of layers.sort((a, b) => depth(a.chains[0]) - depth(b.chains[0]))) {
    const guess = Math.round(depth(layer.chains[0]));
    const w = Math.max(Number.isFinite(guess) ? guess : layer.chains[0].sheet, above + 1, lowest);
    above = w;
    for (const one of layer.chains) one.at = w <= highest ? w : undefined;
  }
  for (const one of asked) {
    spread.push({
      chain: one.chain,
      sheet: one.at ?? one.sheet,
      sheets: one.sheets,
      // A chain with nowhere to go — the wrap it would need is off the end of the piece — is not fed
      // to the fit at all, and says so rather than quietly bending the wrap of another chain.
      used: one.at === undefined ? 0 : one.places.length,
      of: one.of,
      moved: one.at === undefined ? 0 : one.at - one.sheet,
    });
    if (one.at === undefined) continue;
    const said = holds.get(one.at) ?? [];
    for (const place of one.places) said.push({ chain: one.chain, node: place.node, at: place.at });
    holds.set(one.at, said);
  }
  return { holds, spread };
}

export function buildPatch(
  field: LasagnaField,
  seed: Vec3,
  towards: Vec3,
  grid: PatchGrid,
  K = 3,
  per = 8,
  spacing = 40,
  chains: ChainSaid[] = [],
): Patch | undefined {
  const n00 = normalAt(field, seed, towards);
  if (n00 === null) return undefined;
  const onto = field.nearestSheet(seed[0], seed[1], seed[2], n00[0], n00[1], n00[2], spacing * LOOK);
  if (Number.isNaN(onto)) return undefined;
  const p0 = add(seed, mul(n00, onto));
  const n0 = normalAt(field, p0, n00);
  if (n0 === null) return undefined;

  const { nu, nv } = grid;
  const count = nu * nv;
  const { X, right, down } = baseSurface(field, p0, n0, grid);
  /*
   * The sheets, grown from the base outward, holding each to whatever has been said about it.
   *
   * It is done twice when anything has been said: once told nothing, to have a piece to measure the
   * things said against, and once holding them.  Which sheet a place belongs to cannot be worked out
   * before there are sheets to compare it with, and working it out from the spacing instead is wrong
   * by a whole sheet two sheets out (`holdsFor`).
   */
  // Each sheet's own spacing, measured again for every sheet just before it is fitted.
  const sp = new Float64Array(count);
  const spN = new Float64Array(count * 3);
  // And the wrap's own, which is what places are measured against and moved along.
  const surfN = new Float64Array(count * 3);
  // The correction what was said asks for, node by node, along the normal.
  const u = new Float64Array(count);
  const measure = (sheet: Float64Array) => {
    resampleNormals(field, sheet, spN, count, n0);
    spacingAt(field, sheet, spN, count, spacing, sp);
  };

  const grow = (holds: Map<number, Held[]>, before?: Map<number, { held: Uint8Array }>) => {
    const sheets = new Map<number, { X: Float64Array; held: Uint8Array }>();
    const offs: number[] = [];
    const said: { chain: string; away: number }[] = [];
    /*
     * What was said about this wrap, put in before it is fitted: the wrap is moved onto the places
     * and then fitted from there, the same way it would be fitted from anywhere else.  Nothing about
     * the fit changes; it is only started somewhere better.
     */
    /*
     * Moves a wrap onto what was said, and answers how tightly each node should then be held.  The
     * second is the same field as the first, solved once more with every told place worth one: it is
     * how much of this node's position came from a person rather than from the guess it started as.
     */
    const told = (at: number, sheet: Float64Array, wander: Float64Array, firm: Float64Array) => {
      const held = holds.get(at);
      if (held === undefined || held.length === 0) return;
      const papyrus = before?.get(at)?.held;
      measure(sheet);
      const diagonal = Math.hypot(grid.hu, grid.hv);
      for (let round = 0; round < SAID_ROUNDS; round++) {
        surfaceNormals(sheet, nu, nv, surfN, n0);
        // What is still wanted, from where the wrap is now: it shrinks as the places are met.
        saidField(grid, sp, placeValues(held, sheet, nu, nv, surfN), u, papyrus);
        for (let k = 0; k < count; k++) {
          const o = k * 3;
          sheet[o] += surfN[o] * u[k];
          sheet[o + 1] += surfN[o + 1] * u[k];
          sheet[o + 2] += surfN[o + 2] * u[k];
        }
        for (let pass = 0; pass < 2; pass++)
          for (let i = 0; i < nv; i++)
            for (let j = 0; j < nu; j++) {
              const k = i * nu + j;
              if (j + 1 < nu) holdEdge(sheet, k, k + 1, grid.hu, 0.6);
              if (i + 1 < nv) holdEdge(sheet, k, k + nu, grid.hv, 0.6);
              if (i + 1 < nv && j + 1 < nu) holdEdge(sheet, k, k + nu + 1, diagonal, 0.3);
              if (i + 1 < nv && j > 0) holdEdge(sheet, k, k + nu - 1, diagonal, 0.3);
            }
      }
      surfaceNormals(sheet, nu, nv, surfN, n0);
      // One at every told node asks for the shape of the field rather than the correction, which
      // comes out as how much of each node's position came from a person rather than from the guess.
      saidField(
        grid,
        sp,
        placeValues(held, sheet, nu, nv, surfN).map((one) => ({ ...one, value: 1 })),
        u,
        papyrus,
      );
      for (let k = 0; k < count; k++) {
        firm[k] = Math.max(0, Math.min(1, u[k]));
        wander[k] = wander[k] - (wander[k] - TOLD_STRAY) * firm[k];
      }
    };

    /*
     * And where a person has said the wrap passes, there is papyrus — whatever the prediction has to
     * say about it.  A pit on the card is exactly a place the prediction has nothing to say; if the
     * only way to fill one were for the prediction to change its mind, saying so by hand could never
     * close a pit, which is the one thing a person most wants to do about one.
     */
    const covers = (firm: Float64Array, held: Uint8Array) => {
      for (let k = 0; k < count; k++) if (firm[k] > SAID_IS_PAPYRUS) held[k] = 1;
    };
    /*
     * And last of all, the places are met exactly.
     *
     * An annotation is not a suggestion to the fit.  A person looking at the papyrus and saying "the
     * wrap goes through here" knows something the prediction does not, and a tool that treats that as
     * one more term to be balanced against the others gives them the one experience that makes a tool
     * useless: they say the same thing over and over and the line will not move.  So the fit runs,
     * with what was said as its starting point so that it settles somewhere sensible, and then every
     * told node is put exactly where it was told and the leftover is carried away smoothly by the
     * same field that carried the correction in — harmonic, so the papyrus around it bends once and
     * gently rather than kinking at the node.
     *
     * Nothing moves the wrap after this.  Whatever the fit would have preferred, the places said are
     * where it passes.
     */
    const pin = (at: number, sheet: Float64Array) => {
      const told = holds.get(at);
      if (told === undefined || told.length === 0) return;
      measure(sheet);
      // Over and over: moving the wrap bends it a little, so each pass lands nearer than the last.
      // It stops early when every place is within a voxel, which is well under one step of the grid.
      for (let round = 0; round < PIN_ROUNDS; round++) {
        surfaceNormals(sheet, nu, nv, surfN, n0);
        const values = placeValues(told, sheet, nu, nv, surfN);
        if (values.every((one) => Math.abs(one.value) < PIN_CLOSE)) break;
        saidField(grid, sp, values, u, undefined);
        for (let k = 0; k < count; k++) {
          const o = k * 3;
          sheet[o] += surfN[o] * u[k];
          sheet[o + 1] += surfN[o + 1] * u[k];
          sheet[o + 2] += surfN[o + 2] * u[k];
        }
      }
    };

    /*
     * How far the wrap ended from each place: the distance to the surface itself, over the squares of
     * the grid.  Not the distance to the nearest node, which is a grid step even when the place is
     * met exactly, and not the distance along the normal at a node, which is what `pin` sets to zero
     * and so can only ever report success.  A number that cannot say no is not a measurement.
     */
    const answered = (at: number, sheet: Float64Array) => {
      const told = holds.get(at);
      if (told === undefined || told.length === 0) return;
      surfaceNormals(sheet, nu, nv, surfN, n0);
      for (const one of told) {
        const found = onWrap(sheet, nu, nv, surfN, one.at, one.cell);
        if (found !== undefined && found.over) said.push({ chain: one.chain, away: found.away });
      }
    };

    const middle = X.slice();
    const wander = new Float64Array(count).fill(BASE_STRAY);
    const firm = new Float64Array(count);
    told(0, middle, wander, firm);
    measure(middle);
    // The base wrap keeps its own freedom whether or not anything was said about it: `baseSurface` is
    // a guess made from the normals and needs the room to find the papyrus either way.
    const first = fitSheet(field, middle, grid, sp, n0, wander);
    pin(0, middle);
    answered(0, middle);
    covers(firm, first.held);
    fillHoles(first.held, nu, nv);
    sheets.set(0, { X: middle, held: first.held });
    offs.push(first.off);

    for (const dir of [1, -1] as const) {
      let from = middle;
      for (let k = 1; k <= K; k++) {
        measure(from);
        const next = nextSheet(field, from, grid, dir, sp, n0);
        const loose = new Float64Array(count).fill(STEP_STRAY);
        const spoken = new Float64Array(count);
        told(k * dir, next, loose, spoken);
        measure(next);
        const fitted = fitSheet(field, next, grid, sp, n0, loose);
        pin(k * dir, next);
        answered(k * dir, next);
        covers(spoken, fitted.held);
        fillHoles(fitted.held, nu, nv);
        sheets.set(k * dir, { X: next, held: fitted.held });
        offs.push(fitted.off);
        from = next;
      }
    }
    return { sheets, offs, said };
  };

  let grown = grow(new Map());
  let spread: { chain: string; sheet: number; sheets: number; used: number; of: number; moved: number }[] = [];
  if (chains.length > 0) {
    const found = holdsFor(chains, grown.sheets, nu, nv, spacing * SAID_OF_PIECE, seed, spacing, n0);
    spread = found.spread;
    if (found.holds.size > 0) {
      grown = grow(found.holds, grown.sheets);
      /*
       * Asked again of the piece that listened.  What matters to the person who drew a chain is
       * whether its points are all on one wrap NOW — that is the thing they said and the thing they
       * can go and look at — not how many wraps they were scattered over before anything was done
       * about it.
       */
      spread = holdsFor(chains, grown.sheets, nu, nv, spacing * SAID_OF_PIECE, seed, spacing, n0).spread;
    }
  }
  const { sheets, offs, said } = grown;

  // The table: each sheet, and the layers within half a sheet either side of it.  Between two sheets
  // the layers follow the way from one to the other; where the next sheet is missing they follow the
  // normal instead, and the coverage fades to nothing over that half sheet.
  const L = 2 * K * per + 1;
  const P = new Float32Array(L * count * 3).fill(NaN);
  const A = new Float32Array(L * count);
  const N = new Float64Array(count * 3);
  for (let k = -K; k <= K; k++) {
    const here = sheets.get(k)!;
    resampleNormals(field, here.X, N, count, n0);
    for (let node = 0; node < count; node++) {
      const q = node * 3;
      for (let s = -per / 2; s <= per / 2; s++) {
        const layer = (k + K) * per + s;
        if (layer < 0 || layer >= L) continue;
        const neighbour = sheets.get(k + Math.sign(s));
        const t = Math.abs(s) / per;
        const o = layer * count + node;
        // Where two sheets meet in the same layer, the one that has something there wins.
        const coverage = here.held[node] * (1 - t) + (neighbour?.held[node] ?? 0) * t;
        if (!Number.isNaN(P[o * 3]) && coverage <= A[o]) continue;
        A[o] = coverage;
        for (let c = 0; c < 3; c++) {
          P[o * 3 + c] =
            neighbour !== undefined && neighbour.held[node]
              ? here.X[q + c] + (neighbour.X[q + c] - here.X[q + c]) * t
              : here.X[q + c] + N[q + c] * Math.sign(s) * t * spacing;
        }
      }
    }
  }
  return { ...grid, K, per, P, A, right, down, normal: n0, off: offs, said, spread };
}

/**
 * What the patch came out like, for a page that asks: how much of each sheet is there at all, how
 * much of it is torn (neighbouring points further apart than the grid was laid out to be), how far
 * the scale is off, and how far apart the sheets ended up.  Rounded, and only ever printed.
 */
export function patchFacts(patch: Patch) {
  const { nu, nv, K, per, P, hu, hv } = patch;
  const count = nu * nv;
  const step = Math.min(hu, hv);
  const at = (k: number, node: number) => (k + K) * per * count + node;
  const there = (o: number) => patch.A[o] >= 0.5 && !Number.isNaN(P[o * 3]);
  const holes: number[] = [], torn: number[] = [], apart: number[] = [];
  const stretch: number[] = [];
  for (let k = -K; k <= K; k++) {
    let missing = 0, tears = 0, pairs = 0;
    for (let i = 0; i < nv; i++)
      for (let j = 0; j < nu; j++) {
        const node = i * nu + j, o = at(k, node);
        if (!there(o)) {
          missing++;
          continue;
        }
        for (const [di, dj] of [[0, 1], [1, 0]] as const) {
          if (i + di >= nv || j + dj >= nu) continue;
          const q = at(k, (i + di) * nu + j + dj);
          if (!there(q)) continue;
          const d = Math.hypot(P[o * 3] - P[q * 3], P[o * 3 + 1] - P[q * 3 + 1], P[o * 3 + 2] - P[q * 3 + 2]);
          pairs++;
          stretch.push(d / (di ? hv : hu));
          if (d > step * 2.5) tears++;
        }
      }
    holes.push(missing / count);
    torn.push(tears / (pairs || 1));
    if (k < K) {
      const gaps: number[] = [];
      for (let node = 0; node < count; node++) {
        const o = at(k, node), q = at(k + 1, node);
        if (there(o) && there(q)) {
          gaps.push(Math.hypot(P[o * 3] - P[q * 3], P[o * 3 + 1] - P[q * 3 + 1], P[o * 3 + 2] - P[q * 3 + 2]));
        }
      }
      gaps.sort((a, b) => a - b);
      if (gaps.length) apart.push(gaps[gaps.length >> 1]);
    }
  }
  stretch.sort((a, b) => a - b);
  const percent = (xs: number[]) => xs.map((x) => `${Math.round(x * 100)}%`).join(" ");
  const off = patch.off.filter((one) => !Number.isNaN(one));
  return {
    /*
     * Whether what was said got through, where it did least well, and — the part worth looking at
     * before anything else — how many sheets each chain's points were found on to begin with.  A
     * chain meant to lie along one sheet whose points were found on four of them is either a bad
     * piece or a bad chain, and saying so is the difference between a tool and a guess.
     */
    said:
      patch.spread.length === 0
        ? "–"
        : `${patch.said.length} points, chains on ${patch.spread.map((one) => `${one.sheets} wrap${one.sheets === 1 ? "" : "s"}`).join(", ")}` +
          (patch.said.length === 0
            ? ""
            : ` · furthest ${Math.max(...patch.said.map((one) => one.away)).toFixed(0)} voxels`),
    /*
     * And the same, chain by chain, for the person who wrote them: which sheet of this piece each was
     * answered on, how many sheets its points were found spread over, and how far the fitted sheet
     * ended from the furthest of them.  A chain found on one sheet is one the piece agrees with; a
     * chain found on three is either a jump being corrected or a chain drawn across the sheets, and
     * only the person can say which — but they cannot say it at all unless they are told.
     */
    heard: patch.spread.map((one) => ({
      chain: one.chain,
      sheet: one.sheet,
      sheets: one.sheets,
      used: one.used,
      of: one.of,
      moved: one.moved,
      worst: Math.max(
        0,
        ...patch.said.filter((each) => each.chain === one.chain).map((each) => each.away),
      ),
    })),
    // How far the fit ended from the prediction it was following, at worst and on average: small
    // says the piece sits on the predicted sheets, and whatever is wrong is wrong with those.
    off: off.length ? `${(off.reduce((s, v) => s + v, 0) / off.length).toFixed(1)}–${Math.max(...off).toFixed(1)}` : "–",
    holes: percent(holes),
    torn: percent(torn),
    apart: apart.map((a) => Math.round(a)).join(" "),
    stretch: stretch.length
      ? `${stretch[Math.floor(stretch.length * 0.05)].toFixed(2)}–${stretch[Math.floor(stretch.length * 0.95)].toFixed(2)}`
      : "–",
  };
}

/**
 * Where grid point (`gi`, `gj`) of sheet `w` sits in the scan (sheets from the piece's own, both the
 * point and the sheet fractional), written into `out`; false where the table has nothing there.
 */
export function positionAt(patch: Patch, w: number, gi: number, gj: number, out: Float64Array) {
  const { nu, nv, K, per, P } = patch;
  const count = nu * nv;
  const at = (w + K) * per;
  if (at < 0 || at > 2 * K * per || gi < 0 || gj < 0 || gi > nv - 1 || gj > nu - 1) return false;
  const k0 = Math.min(Math.floor(at), 2 * K * per - 1), tk = at - k0;
  const i0 = Math.min(Math.floor(gi), nv - 2), ti = gi - i0;
  const j0 = Math.min(Math.floor(gj), nu - 2), tj = gj - j0;
  out[0] = out[1] = out[2] = 0;
  for (let dk = 0; dk < 2; dk++)
    for (let di = 0; di < 2; di++)
      for (let dj = 0; dj < 2; dj++) {
        const weight = (dk ? tk : 1 - tk) * (di ? ti : 1 - ti) * (dj ? tj : 1 - tj);
        if (weight === 0) continue;
        const o = (((k0 + dk) * count + (i0 + di) * nu + j0 + dj)) * 3;
        if (Number.isNaN(P[o])) return false;
        out[0] += weight * P[o];
        out[1] += weight * P[o + 1];
        out[2] += weight * P[o + 2];
      }
  return true;
}

/**
 * How much of a sheet there is at grid point (`gi`, `gj`) of layer `w`: 1 on the papyrus, 0 where
 * there is none, and between the two at the edge of a hole.
 */
export function coverageAt(patch: Patch, w: number, gi: number, gj: number) {
  const { nu, nv, K, per, A } = patch;
  const count = nu * nv;
  const at = (w + K) * per;
  if (at < 0 || at > 2 * K * per || gi < 0 || gj < 0 || gi > nv - 1 || gj > nu - 1) return 0;
  const k0 = Math.min(Math.floor(at), 2 * K * per - 1), tk = at - k0;
  const i0 = Math.min(Math.floor(gi), nv - 2), ti = gi - i0;
  const j0 = Math.min(Math.floor(gj), nu - 2), tj = gj - j0;
  let value = 0;
  for (let dk = 0; dk < 2; dk++)
    for (let di = 0; di < 2; di++)
      for (let dj = 0; dj < 2; dj++) {
        const weight = (dk ? tk : 1 - tk) * (di ? ti : 1 - ti) * (dj ? tj : 1 - tj);
        if (weight === 0) continue;
        value += weight * A[(k0 + dk) * count + (i0 + di) * nu + j0 + dj];
      }
  return value;
}

/**
 * Where a voxel sits on the piece: the sheet and the grid point whose position is nearest to it, and
 * how far away that is in voxels.  The table is searched first — a couple of hundred thousand points,
 * a millisecond — and then the place between its points is found by halving steps, since the table
 * is an eighth of a sheet apart along w and some ten voxels apart across the sheet.
 *
 * It is how a place pointed at on a slice card is shown on a surface card: the piece is a curved
 * slab, so a voxel inside it comes back a fraction of a voxel away, and one outside comes back as
 * far away as it is — which is what says the place is not on this piece at all.
 */
export function nearestOn(patch: Patch, at: Vec3) {
  const { nu, nv, K, per, P } = patch;
  const count = nu * nv;
  let best = Infinity, bk = -1, bi = 0, bj = 0;
  for (let k = 0; k <= 2 * K * per; k++)
    for (let i = 0; i < nv; i++)
      for (let j = 0; j < nu; j++) {
        const o = (k * count + i * nu + j) * 3;
        if (Number.isNaN(P[o])) continue;
        const dz = P[o] - at[0], dy = P[o + 1] - at[1], dx = P[o + 2] - at[2];
        const away = dz * dz + dy * dy + dx * dx;
        if (away < best) {
          best = away;
          bk = k;
          bi = i;
          bj = j;
        }
      }
  if (bk < 0) return undefined;
  const out = new Float64Array(3);
  const measure = (w: number, gi: number, gj: number) =>
    positionAt(patch, w, gi, gj, out)
      ? Math.hypot(out[0] - at[0], out[1] - at[1], out[2] - at[2])
      : Infinity;
  let w = bk / per - K, gi = bi, gj = bj, away = Math.sqrt(best);
  const moves = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (let step = 0.5; step > 1 / 64; step /= 2)
    for (let pass = 0; pass < 8; pass++) {
      let moved = false;
      for (const [dk, di, dj] of moves) {
        const w2 = w + (dk * step) / per, gi2 = gi + di * step, gj2 = gj + dj * step;
        const closer = measure(w2, gi2, gj2);
        if (closer < away) {
          away = closer;
          w = w2;
          gi = gi2;
          gj = gj2;
          moved = true;
        }
      }
      if (!moved) break;
    }
  return { w, gi, gj, away };
}

/**
 * The grid of layer `w` (sheets from the base, fractional): positions (flat z, y, x, row by row),
 * NaN where the table has nothing, linear between the table's layers.
 */
export function layerGrid(patch: Patch, w: number) {
  const { nu, nv, K, per, P, A } = patch;
  const count = nu * nv;
  const out = new Float32Array(count * 3).fill(NaN);
  const at = Math.min(Math.max((w + K) * per, 0), 2 * K * per);
  const k0 = Math.min(Math.floor(at), 2 * K * per - 1), t = at - k0;
  for (let node = 0; node < count; node++) {
    const a = k0 * count + node, b = (k0 + 1) * count + node;
    // Half covered is not a sheet to stand a new piece on.
    if (A[a] * (1 - t) + A[b] * t < 0.5) continue;
    for (let c = 0; c < 3; c++) {
      out[node * 3 + c] =
        t === 0 ? P[a * 3 + c] : t === 1 ? P[b * 3 + c] : P[a * 3 + c] * (1 - t) + P[b * 3 + c] * t;
    }
  }
  return out;
}

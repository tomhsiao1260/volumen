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
  // Per chain, which sheet of this piece it was answered on and how many different sheets its points
  // were found on: one means the fit already agreed, more means it did not.
  spread: { chain: string; sheet: number; sheets: number }[];
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
 * How far a sheet may drift, of its spacing, while it is fitted: from the base surface, which is a
 * guess made from the normals and has to be free to find the papyrus, and from a step, which has
 * already landed on the next sheet and only wants tidying.  Left as free as the base, a stepped
 * sheet slides back onto the one it came from wherever the prediction is stronger there, and the
 * piece folds up — at one place on Scroll 1 the sheets ended 8 voxels apart where the prediction
 * said 38.
 */
const BASE_STRAY = 0.45;
const STEP_STRAY = 0.22;

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
  spacing: number,
  reference: Vec3,
  wander = BASE_STRAY,
  holding: Held[] = [],
) {
  const { nu, nv, hu, hv } = grid;
  const count = nu * nv;
  const N = new Float64Array(count * 3);
  const start = X.slice();
  const moves = new Float64Array(count);
  const smooth = new Float64Array(count);
  const held = new Uint8Array(count);
  const span = spacing * LOOK;
  const stray = spacing * wander;
  // A node that was told where to be may go there, however far that is: the clamp is what keeps the
  // fit from wandering onto a neighbouring sheet, and being on the neighbouring sheet is the very
  // thing being corrected.
  /*
   * A node that was told where to be may go there, however far that is: the clamp is what keeps the
   * fit from wandering onto a neighbouring wrap, and being on the neighbouring wrap is the very thing
   * being corrected.
   *
   * Only the told nodes themselves, though — never the grid around them.  The clamp is measured from
   * where this fit started, and it starts after `holdTo` has already carried the neighbourhood across;
   * so the neighbourhood is clamped around its corrected place, which is what we want, and freeing it
   * as well only buys it room to wander.  With a hundred and more places said on one card, freeing a
   * neighbourhood around each of them released the clamp over the whole piece — and then the more a
   * person said, the further the fit was free to drift from all of it.
   */
  const free = new Uint8Array(count);
  for (const one of holding) free[one.node] = 1;
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
        moves[k] = field.nearestSheet(X[o], X[o + 1], X[o + 2], N[o], N[o + 1], N[o + 2], span);
      }
      median3(moves, smooth, nu, nv);
      /*
       * And where a person has said the sheet passes, that is where it goes — after the median,
       * which is there to vote down a single node that disagrees with its neighbours, and which
       * would otherwise vote down exactly the node that has been told something.
       */
      for (const one of holding) {
        const o = one.node * 3;
        smooth[one.node] =
          (one.at[0] - X[o]) * N[o] + (one.at[1] - X[o + 1]) * N[o + 1] + (one.at[2] - X[o + 2]) * N[o + 2];
      }
    }
    if (pull > 0) {
      for (let k = 0; k < count; k++) {
        const t = smooth[k];
        if (Number.isNaN(t)) continue;
        const o = k * 3;
        const reach = free[k] === 1 ? most * 4 : most;
        let move = Math.max(-reach, Math.min(reach, t * pull * 0.7));
        const drift =
          (X[o] + N[o] * move - start[o]) * N[o] +
          (X[o + 1] + N[o + 1] * move - start[o + 1]) * N[o + 1] +
          (X[o + 2] + N[o + 2] * move - start[o + 2]) * N[o + 2];
        if (free[k] === 0 && Math.abs(drift) > stray) move += Math.sign(drift) * stray - drift;
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
  spacing: number,
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
      spacing * NEXT_NEAREST,
      spacing * NEXT_FURTHEST,
    );
  }
  median3(moves, smooth, nu, nv);
  for (let k = 0; k < count; k++) {
    const move = Number.isNaN(smooth[k]) ? spacing : smooth[k];
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
 * A place a person has said one of the sheets passes through, and the grid node nearest it.  How far
 * the correction reaches across the grid, and how many rounds of pulling and letting the grid answer
 * back: a person points at one place and means the papyrus around it, but not the whole card.
 */
const HOLD_REACH = 9;
const HOLD_ROUNDS = 6;

interface Held {
  // Which chain said it, so that the piece can answer each one separately.
  chain: string;
  node: number;
  at: Vec3;
}

/*
 * How much of the grid each held place speaks for: 1 at the place itself, nothing at `HOLD_REACH`
 * grid steps away.  A person pointing at the papyrus means the papyrus, not the node — and a piece
 * that has jumped has jumped over a region, so a correction that moved one node and left its
 * neighbours a sheet away would only tear the grid.  Spread, never averaged: where two places reach
 * the same node the nearer one has it, since halfway between two sheets is the one certainly wrong
 * answer.
 */
function spreadOf(grid: PatchGrid, held: Held[], want: Float64Array, firm: Float64Array, offsets: number[]) {
  const { nu, nv } = grid;
  want.fill(0);
  firm.fill(0);
  const reach = Math.ceil(HOLD_REACH);
  held.forEach((one, k) => {
    const gi = Math.floor(one.node / nu), gj = one.node % nu;
    for (let i = Math.max(0, gi - reach); i <= Math.min(nv - 1, gi + reach); i++)
      for (let j = Math.max(0, gj - reach); j <= Math.min(nu - 1, gj + reach); j++) {
        const away = Math.hypot(i - gi, j - gj) / HOLD_REACH;
        if (away > 1) continue;
        const weight = (1 - away * away) ** 2;
        const node = i * nu + j;
        if (weight > firm[node]) {
          firm[node] = weight;
          want[node] = offsets[k];
        }
      }
  });
}

/**
 * Moves a fitted sheet onto the places a person said it passes through.  Each held node is moved
 * along the normal to meet its place, the move is carried to the grid around it — falling off to
 * nothing at `HOLD_REACH` — and then the grid is pulled back into shape, a few times over.
 *
 * The moves are spread, never averaged.  Two sheets' worth of disagreement averaged is the gap
 * between them, which is the one answer that is certainly wrong; so where two places reach the same
 * node, the nearer one has it.
 */
function holdTo(
  field: LasagnaField,
  X: Float64Array,
  grid: PatchGrid,
  reference: Vec3,
  held: Held[],
) {
  const { nu, nv, hu, hv } = grid;
  const count = nu * nv;
  const N = new Float64Array(count * 3);
  const want = new Float64Array(count);
  const firm = new Float64Array(count);
  const diagonal = Math.hypot(hu, hv);
  for (let round = 0; round < HOLD_ROUNDS; round++) {
    resampleNormals(field, X, N, count, reference);
    spreadOf(
      grid,
      held,
      want,
      firm,
      held.map((one) => {
        const o = one.node * 3;
        return (
          (one.at[0] - X[o]) * N[o] + (one.at[1] - X[o + 1]) * N[o + 1] + (one.at[2] - X[o + 2]) * N[o + 2]
        );
      }),
    );
    for (let k = 0; k < count; k++) {
      if (firm[k] === 0) continue;
      const o = k * 3;
      const move = want[k] * firm[k] * 0.8;
      X[o] += N[o] * move;
      X[o + 1] += N[o + 1] * move;
      X[o + 2] += N[o + 2] * move;
    }
    for (let pass = 0; pass < 2; pass++)
      for (let i = 0; i < nv; i++)
        for (let j = 0; j < nu; j++) {
          const k = i * nu + j;
          if (j + 1 < nu) holdEdge(X, k, k + 1, hu, 0.6);
          if (i + 1 < nv) holdEdge(X, k, k + nu, hv, 0.6);
          if (i + 1 < nv && j + 1 < nu) holdEdge(X, k, k + nu + 1, diagonal, 0.3);
          if (i + 1 < nv && j > 0) holdEdge(X, k, k + nu - 1, diagonal, 0.3);
        }
    // Carried outward, so that a place held is a piece of papyrus moved and not a spike in the grid.
    for (const [di, dj] of [[0, 1], [1, 0]] as const)
      for (let i = di; i < nv - di; i++)
        for (let j = dj; j < nu - dj; j++) {
          const k = (i * nu + j) * 3, a = k - (di * nu + dj) * 3, b = k + (di * nu + dj) * 3;
          for (let c = 0; c < 3; c++) X[k + c] += ((X[a + c] + X[b + c]) / 2 - X[k + c]) * 0.12;
        }
  }
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
  count: number,
  step: number,
  seed: Vec3,
) {
  const holds = new Map<number, Held[]>();
  // How many sheets of this piece each chain's points were found on before it was listened to.  One
  // is a chain the fit already agrees with; more than one is either the jump being corrected or a
  // chain drawn across the sheets by mistake, and the person is the only one who can tell which.
  const spread: { chain: string; sheet: number; sheets: number }[] = [];
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
  for (const chain of chains) {
    if (chain.kind !== "same" || chain.points.length < 2) continue;
    const places = chain.points
      .map((point) => ({ at: point.at, ...nearest(point.at) }))
      // A place no sheet of this piece comes near is not on this piece at all.
      .filter((one) => one.node >= 0 && one.away <= 3 * step)
      .map((one) => ({
        ...one,
        seedAway: Math.hypot(one.at[0] - seed[0], one.at[1] - seed[1], one.at[2] - seed[2]),
      }));
    if (places.length < 2) {
      // Nothing of it is near this piece.  Saying so is the difference between an annotation that
      // does nothing and an annotation that looks exactly like one that does.
      spread.push({ chain: chain.id, sheet: 0, sheets: 0 });
      continue;
    }
    const anchor = places.reduce((best, one) => (one.seedAway < best.seedAway ? one : best));
    spread.push({
      chain: chain.id,
      sheet: anchor.sheet,
      sheets: new Set(places.map((place) => place.sheet)).size,
    });
    const said = holds.get(anchor.sheet) ?? [];
    for (const place of places) said.push({ chain: chain.id, node: place.node, at: place.at });
    holds.set(anchor.sheet, said);
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
  const grow = (holds: Map<number, Held[]>) => {
    const sheets = new Map<number, { X: Float64Array; held: Uint8Array }>();
    const offs: number[] = [];
    const said: { chain: string; away: number }[] = [];
    const settle = (at: number, sheet: Float64Array) => {
      const held = holds.get(at);
      if (held === undefined || held.length === 0) return undefined;
      // First the places are met and the grid around them carried along, then the whole sheet is
      // fitted again still holding them, so that the papyrus either side comes with it.
      holdTo(field, sheet, grid, n0, held);
      const fitted = fitSheet(field, sheet, grid, spacing, n0, STEP_STRAY, held);
      for (const one of held) {
        const o = one.node * 3;
        said.push({
          chain: one.chain,
          away: Math.hypot(sheet[o] - one.at[0], sheet[o + 1] - one.at[1], sheet[o + 2] - one.at[2]),
        });
      }
      return fitted;
    };

    const middle = X.slice();
    const first = settle(0, middle) ?? fitSheet(field, middle, grid, spacing, n0);
    fillHoles(first.held, nu, nv);
    sheets.set(0, { X: middle, held: first.held });
    offs.push(first.off);

    for (const dir of [1, -1] as const) {
      let from = middle;
      for (let k = 1; k <= K; k++) {
        const next = nextSheet(field, from, grid, dir, spacing, n0);
        let fitted = fitSheet(field, next, grid, spacing, n0, STEP_STRAY);
        fitted = settle(k * dir, next) ?? fitted;
        fillHoles(fitted.held, nu, nv);
        sheets.set(k * dir, { X: next, held: fitted.held });
        offs.push(fitted.off);
        from = next;
      }
    }
    return { sheets, offs, said };
  };

  let grown = grow(new Map());
  let spread: { chain: string; sheet: number; sheets: number }[] = [];
  if (chains.length > 0) {
    const found = holdsFor(chains, grown.sheets, count, Math.max(grid.hu, grid.hv), seed);
    spread = found.spread;
    if (found.holds.size > 0) grown = grow(found.holds);
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

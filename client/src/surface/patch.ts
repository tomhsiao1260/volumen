/**
 * @file A flattened piece of papyrus: a grid of points over one sheet, and the same grid over each of
 * the sheets either side of it.
 *
 * The result is a table P[k][i][j] of scan positions: row i and column j of the grid on layer
 * w = k / per, where whole w are sheets and the rest lie evenly between them.  Drawing a layer is
 * then looking positions up in the table and sampling the scan there (`render.ts`).
 *
 * THIS FIT USES ONE THING AND NOTHING ELSE: the prediction's normal field.  Not the phase, not the
 * surface mask, not the scan, and it never looks around for a nearby sheet to snap to.
 *
 * That is a decision and not an omission.  Measured on Scroll 1 at (19449, 7935, 38115), over a box
 * of 340x240 voxels (`scratchpad/pup/explain.cjs`):
 *
 *   the phase `cos`   the sheets repeat every 46 voxels and cos repeats every 48 — the PERIOD is
 *                     right — but where in that period it puts a sheet is not: read on a bright band
 *                     of the scan it is 139, read in the gap between two it is 143, and a place on
 *                     papyrus reads higher than a place in a gap 51% of the time.  50% is a coin.
 *   the surface mask  443 sheets in the scan, 379 faces marked, but 55% of the sheets have no face
 *                     within 10 voxels and 47% of the faces are more than 10 voxels from any sheet;
 *                     the faces repeat every 56 voxels against the sheets' 46.
 *   the normal        against the scan's own grain, where the scan has a grain to compare with: half
 *                     within 19 degrees, a quarter more than 35 out.  The best of the three by far.
 *
 * So the normal says which way is across the sheets, and `density` — the same field's magnitude —
 * says how much of a winding a voxel of that direction is worth.  Together they say where the next
 * sheet is without anyone having to look for it: walk along the normal, adding up the winding as you
 * go, and stop when a whole one has gone by.  Nothing in here searches, and nothing snaps.
 *
 * What this deliberately does NOT do, so that it can be built on rather than argued with:
 *   - it does not put the seed onto a sheet first; the piece starts where the person pressed
 *   - it does not pull the grid onto anything; there is no fitting, only integration
 *   - it does not read a person's annotations; that goes on top of this, next, on purpose
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
function frame(n: Vec3) {
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
  // P[((k + K·per)·count + node)·3]: the position of grid node `node` on layer k / per.
  P: Float32Array;
  // A[…]: whether the march reached that layer at that node at all — 1 where it did, 0 where the
  // prediction ran out on the way and there is nothing honest to draw.
  A: Float32Array;
  right: Vec3;
  down: Vec3;
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

/*
 * How far one step of the march may be, as a part of the space between two sheets.  There are `per`
 * samples to a sheet, so a twelfth is a step and a half to each sample — enough for the midpoint
 * rule, which is second order, and no more.
 */
const STEP_OF_WRAP = 1 / 12;
/*
 * And how much of the way each node is moved towards the middle of its neighbours after every sample.
 *
 * The nodes walk the same field but each walks its own path, and two that start a few voxels apart
 * drift apart a little more with every step — measured on Scroll 1, a node sat 0.02 voxels off the
 * line between its neighbours on the base, 0.10 one sheet out and 0.15 two sheets out.  That is a
 * sheet slowly turning into a rumpled one, and it shows up magnified: where a sheet lies nearly along
 * the plane of a slice card — here the normal's z is 0.09 — a fifth of a voxel of rumple is two
 * voxels of sideways wobble in the line, and the line comes out as a saw.
 *
 * So the grid is held together as it walks.  It is a plain Laplacian and it pulls towards the MIDDLE
 * of the neighbours, so a sheet that is genuinely curved keeps its curve: over a cell and a half, the
 * span this reaches, a sheet bending on a radius of five hundred voxels departs from the straight
 * line between its neighbours by two hundredths of a voxel.  What it takes out is what is not a
 * sheet's shape at all.
 */
const HOLD = 0.25;
/*
 * How far a place may be from the piece and still be taken as a thing said about it, as a part of the
 * space between two sheets.  Further than this and the person was talking about somewhere else.
 */
const SAID_REACH = 1.5;
// How much further than the piece needs each node walks, in sheets: the room a correction slides into.
const MARGIN = 1;
/*
 * How far a thing said reaches, as a multiple of how far apart the things said are, and the least and
 * most it may be in voxels.
 *
 * Decided by the annotations rather than fixed, and that is what makes drawing more of them work:
 * drawn close together they reach a short way, and the correction can then say something fine; drawn
 * far apart they reach further and the correction is broad and gentle.  A number fixed here instead
 * would be a ceiling on how fine a thing a person is allowed to say.
 */
const REACH_OF_GAP = 2;
const REACH_LEAST = 4;

/**
 * The wraps a piece walks out from a surface: the base into layer 0, then every node together, one
 * sample at a time, out to `K` sheets each way.
 *
 * Together and not one after another, because a sheet is a sheet: the nodes are not independent
 * walkers that happen to be drawn as a grid, and marching each to the end before starting the next
 * is what lets them drift apart (`HOLD`).
 */
function walk(
  field: LasagnaField,
  X: Float64Array,
  n0: Vec3,
  grid: PatchGrid,
  // How many samples each way to walk, and how many of them make a sheet.
  reach: number,
  per: number,
  // How far one sheet is from the next, in voxels: the one number this fit is told rather than reads.
  spacing: number,
) {
  const { nu, nv } = grid;
  const count = nu * nv;
  const layers = 2 * reach + 1;
  const P = new Float32Array(layers * count * 3).fill(NaN);
  const A = new Float32Array(layers * count);
  const middle = reach * count;
  for (let node = 0; node < count; node++) {
    if (Number.isNaN(X[node * 3])) continue;
    const o = (middle + node) * 3;
    P[o] = X[node * 3];
    P[o + 1] = X[node * 3 + 1];
    P[o + 2] = X[node * 3 + 2];
    A[middle + node] = 1;
  }

  const wanted = reach;
  const each = spacing / per;
  const steps = Math.max(1, Math.round(each / (spacing * STEP_OF_WRAP)));
  const ds = each / steps;
  for (const dir of [1, -1] as const) {
    const at = X.slice();
    const ref = new Float64Array(count * 3);
    for (let node = 0; node < count; node++) ref.set(n0, node * 3);
    const alive = new Uint8Array(count);
    for (let node = 0; node < count; node++) alive[node] = Number.isNaN(X[node * 3]) ? 0 : 1;

    for (let k = 1; k <= wanted; k++) {
      for (let step = 0; step < steps; step++) {
        for (let node = 0; node < count; node++) {
          if (!alive[node]) continue;
          const o = node * 3;
          const here: Vec3 = [at[o], at[o + 1], at[o + 2]];
          const was: Vec3 = [ref[o], ref[o + 1], ref[o + 2]];
          const n = normalAt(field, here, was);
          if (n === null) {
            alive[node] = 0;
            continue;
          }
          // Taken at the middle of the step, so that a normal that turns does not walk the march off
          // the sheet — the same reason a curve is integrated by its midpoint and not by its start.
          const half: Vec3 = [
            here[0] + (n[0] * dir * ds) / 2,
            here[1] + (n[1] * dir * ds) / 2,
            here[2] + (n[2] * dir * ds) / 2,
          ];
          const mid = normalAt(field, half, n) ?? n;
          at[o] = here[0] + mid[0] * dir * ds;
          at[o + 1] = here[1] + mid[1] * dir * ds;
          at[o + 2] = here[2] + mid[2] * dir * ds;
          ref.set(mid, o);
        }
        hold(at, alive, nu, nv);
      }
      const layer = middle + dir * k * count;
      for (let node = 0; node < count; node++) {
        if (!alive[node]) continue;
        const o = node * 3;
        P[(layer + node) * 3] = at[o];
        P[(layer + node) * 3 + 1] = at[o + 1];
        P[(layer + node) * 3 + 2] = at[o + 2];
        A[layer + node] = 1;
      }
    }
  }
  return { P, A };
}

// Each node a tenth of the way towards the middle of the neighbours it has.
function hold(at: Float64Array, alive: Uint8Array, nu: number, nv: number) {
  const was = at.slice();
  for (let i = 0; i < nv; i++)
    for (let j = 0; j < nu; j++) {
      const k = i * nu + j;
      if (!alive[k]) continue;
      let n = 0;
      const sum = [0, 0, 0];
      for (const [di, dj] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
        const y = i + di, x = j + dj;
        if (y < 0 || x < 0 || y >= nv || x >= nu) continue;
        const o = y * nu + x;
        if (!alive[o]) continue;
        sum[0] += was[o * 3];
        sum[1] += was[o * 3 + 1];
        sum[2] += was[o * 3 + 2];
        n++;
      }
      if (n === 0) continue;
      for (let c = 0; c < 3; c++) at[k * 3 + c] += HOLD * (sum[c] / n - was[k * 3 + c]);
    }
}

/**
 * What a person has said, as a correction to the winding — in wraps, at the grid node each thing was
 * said nearest to.
 *
 * This is the whole of how an annotation reaches this fit, and it is said in the fit's own terms.
 * The piece is a winding field walked out from a surface: every place in it has a w, whole numbers
 * being the sheets.  So
 *
 *   a SAME winding says its points are all one sheet — that is, they all have the same whole w, and
 *     the correction at each is however far its w is from the one the chain sits on;
 *   a RELATIVE winding says two places are NOT one sheet — that is, their w differ by at least one,
 *     and where the piece has them within half a wrap of each other the further of the two is
 *     corrected out to the next whole one.
 *
 * Nothing here looks for papyrus, and nothing snaps to anything.  A thing said is a statement about
 * the winding, the fit is a winding, and the two meet in the same number.
 */
function saidAbout(
  patch: Patch,
  chains: ChainSaid[],
  spacing: number,
  /*
   * Which sheet each chain is on, settled the first time and kept.
   *
   * Settled once because it is a decision and not a measurement: a chain whose points straddle the
   * halfway line between two sheets votes one way on one pass and the other way on the next, and the
   * piece is then pulled back and forth and never arrives.  The first piece is the honest place to
   * decide it — nothing has been moved for anybody yet.
   */
  sheets: Map<string, number>,
) {
  const { nu, nv } = patch;
  const reach = spacing * SAID_REACH;
  const found = new Map<string, { gi: number; gj: number; w: number; at: Vec3 }[]>();
  for (const chain of chains) {
    const places = [];
    for (const point of chain.points) {
      const on = nearestOn(patch, point.at);
      if (on === undefined || on.away > reach) continue;
      /*
       * Kept where it really is, between the grid points, and never rounded to one of them.  Rounding
       * puts two places a few voxels apart on one node, where they fight over its one value and the
       * last one wins; and it puts two that are meant to say the same thing on NEIGHBOURING nodes,
       * where holding each exactly leaves a step between them — and a step in the correction is a
       * crease in the sheet.  Between the nodes they ask for a slope instead, which a sheet can be.
       */
      places.push({
        gi: Math.min(nv - 1, Math.max(0, on.gi)),
        gj: Math.min(nu - 1, Math.max(0, on.gj)),
        w: on.w,
        at: point.at,
      });
    }
    /*
     * Every point kept.  Not thinned, and that is the point of this tool.
     *
     * Thinning a chain to one point every twenty voxels is what the Vesuvius Challenge does, and for
     * a spiral across a whole scroll it is right; here it would throw away the thing being looked at.
     * What this is for is the small undulations in one small piece, and those live at exactly the
     * scale a thinning would remove.
     *
     * The jitter of a hand is dealt with instead of thrown away, and the difference is everything: a
     * hand is wrong by a few voxels in a way that is NOT the same from one click to the next, so a
     * run of points over one stretch of sheet averages it down by the square root of how many there
     * are, while a real undulation is the same in all of them and survives.  So more points make the
     * answer better rather than noisier, which is what a person drawing carefully has a right to
     * expect.  What limits how fine a thing can be said is the control field (`bend`), and nothing
     * else.
     */
    if (places.length > 0) found.set(chain.id, places);
  }

  const want: { gi: number; gj: number; value: number }[] = [];
  for (const chain of chains) {
    const places = found.get(chain.id);
    if (places === undefined || places.length < 2 || chain.kind !== "same") continue;
    // The one most of its points are nearest to, the first time it is asked.
    let sheet = sheets.get(chain.id);
    if (sheet === undefined) {
      const votes = new Map<number, number>();
      for (const one of places) votes.set(Math.round(one.w), (votes.get(Math.round(one.w)) ?? 0) + 1);
      let best = -1;
      sheet = 0;
      for (const [which, count] of votes) if (count > best) { best = count; sheet = which; }
      sheets.set(chain.id, sheet);
    }
    /*
     * Moving the base OUT by one winding moves every wrap out with it, so a place measured against
     * the piece reads one LESS than it did — the correction is the place's own w less the wrap its
     * chain is on, not the other way about.
     */
    for (const one of places) want.push({ gi: one.gi, gj: one.gj, value: one.w - sheet });
  }
  for (const chain of chains) {
    if (chain.kind !== "step") continue;
    const places = found.get(chain.id);
    if (places === undefined || places.length < 2) continue;
    const already = (one: { gi: number; gj: number; w: number; at: Vec3 }) => {
      const said = want.find((each) => each.gi === one.gi && each.gj === one.gj);
      return one.w - (said?.value ?? 0);
    };
    for (let k = 0; k + 1 < places.length; k++) {
      const [a, b] = [places[k], places[k + 1]];
      // Already different sheets: a thing already true asks for nothing.
      if (Math.abs(already(a) - already(b)) >= 0.5) continue;
      // The one the piece is less sure of — further from a whole wrap — is the one that moves.
      const [stay, move] = Math.abs(a.w - Math.round(a.w)) <= Math.abs(b.w - Math.round(b.w)) ? [a, b] : [b, a];
      const to = Math.round(already(stay)) + (move.w >= stay.w ? 1 : -1);
      want.push({ gi: move.gi, gj: move.gj, value: move.w - to });
    }
  }
  return want;
}

/**
 * Those corrections spread over the grid: the smoothest field that passes EXACTLY through every place
 * said, and fades back to nothing away from them.
 *
 * Exactly through every one, because a line that does not go through the place a person put their
 * finger is the one thing an annotation must never be, and because this is a tool for looking rather
 * than a thing that guesses: what it is for is that a person can say something, see what it does, and
 * say the next thing.  Every point is adopted whole.
 *
 * And that does NOT have to be bought with a sheet shaped like a saw — which is what came out of
 * solving this on the grid with a plain Laplacian.  The Laplacian's own answer to a point held at a
 * value is a spike: in two dimensions its Green's function is log r, which has no bottom, so the
 * field dives at every place said and climbs back between them.  The saw was never the price of
 * exactness; it was the price of asking for the flattest field rather than the least BENT one.
 *
 * So the field is built the other way round: not solved on the grid at all, but written as a sum of
 * one smooth bump per place said, with the heights chosen so that the sum reads exactly what was said
 * at every one of them.  The bump is the Matérn of five halves,
 *
 *     φ(r) = (1 + √5 r/ℓ + 5r²/3ℓ²) · e^(−√5 r/ℓ)
 *
 * which is twice differentiable — so a place said is a smooth rise and not a spike — positive
 * definite, so the heights always exist and are unique, and falling away to nothing, so that where
 * nobody has said anything the sheet is the prediction's own and not an extrapolation of somebody's
 * hand.  A thin plate spline interpolates exactly too, but its bump grows as r² log r: a few places
 * said in the middle of a card would tip the whole of it, including the parts nobody has looked at.
 */
function bend(grid: PatchGrid, want: { gi: number; gj: number; value: number }[], reach: number) {
  const { nu, nv, hu, hv } = grid;
  const n = want.length;
  // In voxels, so that one reach means the same thing across and down a grid that is not square.
  const where = want.map((one) => [one.gj * hu, one.gi * hv]);
  const bump = (a: number[], b: number[]) => {
    const r = (Math.hypot(a[0] - b[0], a[1] - b[1]) * Math.sqrt(5)) / reach;
    return (1 + r + (r * r) / 3) * Math.exp(-r);
  };

  // The heights, from the one small dense system this needs: K h = v.
  const K: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = new Array<number>(n + 1);
    for (let j = 0; j < n; j++) row[j] = bump(where[i], where[j]);
    // Two places said all but on top of one another leave the system all but singular; a touch on the
    // diagonal makes it solvable, and what comes out is the two of them met halfway.
    row[i] += 1e-6;
    row[n] = want[i].value;
    K.push(row);
  }
  for (let c = 0; c < n; c++) {
    let best = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(K[r][c]) > Math.abs(K[best][c])) best = r;
    [K[c], K[best]] = [K[best], K[c]];
    const pivot = K[c][c];
    if (Math.abs(pivot) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const factor = K[r][c] / pivot;
      if (factor === 0) continue;
      for (let k = c; k <= n; k++) K[r][k] -= factor * K[c][k];
    }
  }
  const height = new Float64Array(n);
  for (let c = 0; c < n; c++) height[c] = Math.abs(K[c][c]) < 1e-12 ? 0 : K[c][n] / K[c][c];

  const out = new Float64Array(nu * nv);
  for (let i = 0; i < nv; i++)
    for (let j = 0; j < nu; j++) {
      const at = [j * hu, i * hv];
      let sum = 0;
      for (let k = 0; k < n; k++) sum += height[k] * bump(at, where[k]);
      out[i * nu + j] = sum;
    }
  return out;
}

/**
 * How far one thing said should reach: twice the middle of the distances from each place said to the
 * nearest other one, held between a few voxels and the space between two sheets.
 *
 * Twice, so that the bumps of neighbours overlap and the field between them is theirs rather than a
 * row of separate hills; the middle rather than the least, so that one pair drawn close together does
 * not make the whole correction short-sighted.  Held under a sheet's spacing because nothing a person
 * says about one sheet should reach across to the next.
 */
function reachOf(want: { gi: number; gj: number; value: number }[], grid: PatchGrid, spacing: number) {
  const { hu, hv } = grid;
  const where = want.map((one) => [one.gj * hu, one.gi * hv]);
  const gaps: number[] = [];
  for (let i = 0; i < where.length; i++) {
    let near = Infinity;
    for (let j = 0; j < where.length; j++) {
      if (i === j) continue;
      near = Math.min(near, Math.hypot(where[i][0] - where[j][0], where[i][1] - where[j][1]));
    }
    if (Number.isFinite(near)) gaps.push(near);
  }
  if (gaps.length === 0) return spacing;
  gaps.sort((one, two) => one - two);
  return Math.min(spacing, Math.max(REACH_LEAST, REACH_OF_GAP * gaps[gaps.length >> 1]));
}

/**
 * How far one sheet is from the next, in voxels — from what a person has said, where they have said
 * anything.
 *
 * This is the one thing the fit needs that the normal field does not give it.  A direction says which
 * way is across the sheets; it says nothing about how far across.  The prediction has a number for it
 * — `grad_mag` — and measured on Scroll 1 it is out by half, steadily (`field.ts`), so a fit that
 * walks it is a wrap and a half out by its third sheet.
 *
 * A relative winding is exactly this number said by hand: "these two places are different sheets",
 * and how far apart they are along the normal is what one sheet is worth.  The middle of them is
 * taken rather than the least or the most, so that one pair drawn across two sheets does not set the
 * scale for the whole piece.  With nothing said, the fallback is a guess and is meant to look like
 * one.
 */
function spacingSaid(field: LasagnaField, chains: ChainSaid[], n0: Vec3, fallback: number) {
  const gaps: number[] = [];
  for (const chain of chains) {
    if (chain.kind !== "step") continue;
    for (let k = 0; k + 1 < chain.points.length; k++) {
      const [a, b] = [chain.points[k].at, chain.points[k + 1].at];
      const middle: Vec3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      const n = normalAt(field, middle, n0) ?? n0;
      const gap = Math.abs((b[0] - a[0]) * n[0] + (b[1] - a[1]) * n[1] + (b[2] - a[2]) * n[2]);
      // Two places closer than this along the normal are not two sheets, whatever was meant by them.
      if (gap > 4) gaps.push(gap);
    }
  }
  if (gaps.length === 0) return fallback;
  gaps.sort((one, two) => one - two);
  return gaps[gaps.length >> 1];
}

export function buildPatch(
  field: LasagnaField,
  seed: Vec3,
  towards: Vec3,
  grid: PatchGrid,
  K = 3,
  per = 8,
  // What one sheet is worth in voxels when nobody has said; a relative winding says it properly.
  spacing = 40,
  // What a person has said about the sheets here.
  chains: ChainSaid[] = [],
  // The surface to start from, node by node, when there already is one — a piece built further out
  // starts from the wrap it is centred on rather than solving the tangent plane again.  NaN where
  // that wrap has nothing at a node, and the piece has nothing there either.
  from?: Float32Array,
): Patch | undefined {
  // Where the person pressed, not the nearest sheet to it: moving the seed is already a decision
  // about which sheet they meant, and this fit makes no such decisions.
  const n0 = normalAt(field, seed, towards);
  if (n0 === null) return undefined;

  const { nu, nv } = grid;
  const count = nu * nv;
  const apart = spacingSaid(field, chains, n0, spacing);
  const { X, right, down } =
    from !== undefined && from.length === count * 3
      ? { X: Float64Array.from(from), ...frame(n0) }
      : baseSurface(field, seed, n0, grid);

  /*
   * Walked once, and further than the piece needs: the room either side is what a correction slides
   * into.
   */
  const reach = (K + MARGIN) * per;
  const walked = walk(field, X, n0, grid, reach, per, apart);
  const table = (R: number, Q: { P: Float32Array; A: Float32Array }, shift?: Float64Array) => {
    const layers = 2 * K * per + 1;
    const P = new Float32Array(layers * count * 3).fill(NaN);
    const A = new Float32Array(layers * count);
    for (let k = -K * per; k <= K * per; k++)
      for (let node = 0; node < count; node++) {
        // Where on this node's own walk the sheet it wants is, once what was said has slid it.
        const at = k + (shift === undefined ? 0 : shift[node] * per);
        const a = Math.floor(at), t = at - a;
        if (a + R < 0 || a + 1 + R > 2 * R) continue;
        const from = (a + R) * count + node, to = (a + 1 + R) * count + node;
        if (Q.A[from] < 0.5 || Q.A[to] < 0.5) continue;
        const into = (k + K * per) * count + node;
        for (let c = 0; c < 3; c++) P[into * 3 + c] = Q.P[from * 3 + c] * (1 - t) + Q.P[to * 3 + c] * t;
        A[into] = 1;
      }
    return { P, A };
  };

  const plain: Patch = { ...grid, K, per, ...table(reach, walked), right, down, normal: n0 };
  if (chains.length === 0) return plain;

  /*
   * And what a person has said, held EXACTLY — by sliding the winding rather than by bending the
   * sheet into place.
   *
   * This is the shape of the Vesuvius Challenge's own spiral fit, in the small.  There, a sheet is not
   * a surface that is moved about: it is an integer level set of one winding function defined
   * everywhere, and an annotation is a statement about that function, solved together with everything
   * else.  Here the winding function is already in hand — every node has walked its own path, and how
   * far along the path a place is IS its winding — so a thing said is met by resampling each node's
   * path at a shifted winding, which is exact and linear and done once.
   *
   * It replaces an iteration that moved the base, walked again and measured again, hoping to creep up
   * on the answer.  Measured, that hoping did not work: twenty points said to be one sheet were left
   * 17 voxels off it, and taking the whole correction each round made it worse round by round — 26
   * voxels out became 17, then 18, 21, 24, 30.  Nothing creeps here; the places said are where the
   * sheet is because that is what the table was built from.
   */
  const want = saidAbout(plain, chains, apart, new Map<string, number>());
  if (want.length === 0) return plain;
  return { ...grid, K, per, ...table(reach, walked, bend(grid, want, reachOf(want, grid, apart))), right, down, normal: n0 };
}

/**
 * How far apart this piece's wraps actually came out, in voxels: the middle of the distances from
 * each node of wrap 0 to the same node of wrap 1.
 *
 * Asked of the piece rather than of the prediction on purpose.  The number is what a drag across the
 * sheet lines is measured in and what sets the card's scale, and for that it has to describe the
 * wraps that are drawn — not what the prediction said before they were walked.  Measured on Scroll 1
 * the two differ by half: `grad_mag` says a winding takes 30 voxels there and the wraps come out 34
 * apart, while the papyrus itself repeats every 46.  That last gap is a fault of the prediction's
 * winding scale and is for the layer above this one to correct; this only stops the card telling the
 * hand one thing and the eye another.
 */
export function wrapGap(patch: Patch) {
  const { nu, nv, K, per, P } = patch;
  const count = nu * nv;
  const gaps: number[] = [];
  for (let node = 0; node < count; node++) {
    const a = (0 + K * per) * count + node, b = (per + K * per) * count + node;
    if (Number.isNaN(P[a * 3]) || Number.isNaN(P[b * 3])) continue;
    gaps.push(Math.hypot(P[a * 3] - P[b * 3], P[a * 3 + 1] - P[b * 3 + 1], P[a * 3 + 2] - P[b * 3 + 2]));
  }
  if (gaps.length === 0) return NaN;
  gaps.sort((one, two) => one - two);
  return gaps[gaps.length >> 1];
}

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
  return {
    // Per wrap, how much of it the prediction ran out on before the march could finish it.
    holes: percent(holes),
    // And how badly the grid is pulled about: neighbours further apart than they were laid out, and
    // how far apart one wrap and the next came out.  Both are the piece describing itself; nothing
    // here is measured against the prediction, because this fit does not disagree with it anywhere —
    // it IS the prediction, walked.
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
// What held each node of the nearest fitted wrap to `w`, and how far it ended from it.
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

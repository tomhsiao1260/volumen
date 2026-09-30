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
import { WHY_NOTHING, WHY_PREDICTION } from "./types";
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
  // P[((k + K·per)·count + node)·3]: the position of grid node `node` on layer k / per.
  P: Float32Array;
  // A[…]: whether the march reached that layer at that node at all — 1 where it did, 0 where the
  // prediction ran out on the way and there is nothing honest to draw.
  A: Float32Array;
  right: Vec3;
  down: Vec3;
  // Kept for the card's footer; this fit measures itself against nothing, so it says nothing.
  off: number[];
  said: { chain: string; away: number }[];
  spread: { chain: string; sheet: number; sheets: number; used: number; of: number; moved: number }[];
  // The normal at the base's centre: the direction w grows in.
  normal: Vec3;
  looked: number;
  // Per fitted wrap: what held each of its nodes up, and how far it ended from that.
  why: Map<number, { why: Uint8Array; away: Float32Array }>;
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
 * How far one step of the march may be.  Short enough that a curving normal is resampled often,
 * long enough that a wrap is tens of samples and not thousands.
 */
const STEP_MOST = 3;
const STEP_LEAST = 0.4;
/*
 * And how much of a winding a step may cross, which is what actually sets the step.  There are `per`
 * samples to a winding, so a step of a twelfth crosses one sample every step and a half — enough for
 * the midpoint rule, which is second order, and no more.  Measured: at a twenty-fourth a piece took
 * 400 ms to build and a drag across the sheet lines froze for as long as that every third wrap.
 */
const STEP_OF_WRAP = 1 / 12;
// A march that has taken this many steps without crossing the wraps asked of it has gone wrong.
const STEP_LIMIT = 4000;

/**
 * Walks from `from` along the normal field, `dir` being which way, writing where it is every 1/`per`
 * of a winding into `P` until `K` whole windings have gone by.
 *
 * This is the whole of how one sheet becomes the next, and it is an integration rather than a
 * search.  `field.normal` gives the direction across the sheets; `field.density` gives how much of a
 * winding one voxel along that direction is worth.  So the next sheet is not looked for — it is
 * arrived at.  Where the prediction runs out the march stops, and every layer past that is left
 * empty, which is the honest thing to draw there.
 */
function march(
  field: LasagnaField,
  from: Vec3,
  dir: 1 | -1,
  reference: Vec3,
  K: number,
  per: number,
  P: Float32Array,
  A: Float32Array,
  count: number,
  node: number,
) {
  const wanted = K * per;
  let p: Vec3 = [from[0], from[1], from[2]];
  let ref: Vec3 = [reference[0], reference[1], reference[2]];
  let w = 0;
  let next = 1;
  for (let step = 0; next <= wanted && step < STEP_LIMIT; step++) {
    const n = normalAt(field, p, ref);
    if (n === null) break;
    const rho = field.density(p[0], p[1], p[2]);
    if (!(rho > 0)) break;
    ref = n;
    // Never past the sample being walked towards, so that no sample is missed by overshooting.
    const ds = Math.min(STEP_MOST, Math.max(STEP_LEAST, STEP_OF_WRAP / rho), Math.max(STEP_LEAST, (next / per - w) / rho));
    // Taken at the middle of the step, so that a normal that turns does not walk the march off the
    // sheet — the same reason a curve is integrated by its midpoint and not by its start.
    const half: Vec3 = [p[0] + (n[0] * dir * ds) / 2, p[1] + (n[1] * dir * ds) / 2, p[2] + (n[2] * dir * ds) / 2];
    // The direction at the middle of the step, which is what the step is taken along; how much of a
    // winding it is worth is taken from where the step began, since that changes far more slowly than
    // the direction does and costs as much to ask.
    const middle = normalAt(field, half, ref) ?? n;
    const density = rho;
    const was: Vec3 = [p[0], p[1], p[2]];
    const wWas = w;
    p = [p[0] + middle[0] * dir * ds, p[1] + middle[1] * dir * ds, p[2] + middle[2] * dir * ds];
    w += density * ds;
    // Every sample this step went past, put where the winding says it belongs along the step.
    while (next <= wanted && w >= next / per) {
      const t = w === wWas ? 1 : (next / per - wWas) / (w - wWas);
      const k = dir > 0 ? next : -next;
      const o = (k + K * per) * count + node;
      P[o * 3] = was[0] + (p[0] - was[0]) * t;
      P[o * 3 + 1] = was[1] + (p[1] - was[1]) * t;
      P[o * 3 + 2] = was[2] + (p[2] - was[2]) * t;
      A[o] = 1;
      next++;
    }
  }
  return next - 1;
}

/**
 * The piece around `seed`, `K` sheets each way, or undefined where the prediction has no normal there.
 *
 * `scan`, `spacing` and `chains` are taken and not used: the scan and the annotations belong to the
 * layers being built on top of this one, and the spacing is worked out from the field rather than
 * given.  They stay in the signature so that adding them back is a change to this file alone.
 */
export function buildPatch(
  field: LasagnaField,
  scan: ((z: number, y: number, x: number) => number) | undefined,
  seed: Vec3,
  towards: Vec3,
  grid: PatchGrid,
  K = 3,
  per = 8,
  spacing = 40,
  chains: ChainSaid[] = [],
): Patch | undefined {
  void scan;
  void spacing;
  void chains;
  // Where the person pressed, not the nearest sheet to it: moving the seed is already a decision
  // about which sheet they meant, and this fit makes no such decisions.
  const n0 = normalAt(field, seed, towards);
  if (n0 === null) return undefined;

  const { nu, nv } = grid;
  const count = nu * nv;
  const { X, right, down } = baseSurface(field, seed, n0, grid);
  const layers = 2 * K * per + 1;
  const P = new Float32Array(layers * count * 3).fill(NaN);
  const A = new Float32Array(layers * count);
  const at = (k: number, node: number) => (k + K * per) * count + node;

  for (let node = 0; node < count; node++) {
    const o = at(0, node);
    P[o * 3] = X[node * 3];
    P[o * 3 + 1] = X[node * 3 + 1];
    P[o * 3 + 2] = X[node * 3 + 2];
    A[o] = 1;
  }
  let reached = 0;
  for (let node = 0; node < count; node++) {
    const from: Vec3 = [X[node * 3], X[node * 3 + 1], X[node * 3 + 2]];
    for (const dir of [1, -1] as const) reached += march(field, from, dir, n0, K, per, P, A, count, node);
  }

  /*
   * And what holds each node of each whole wrap up, which under this fit is one of two things: the
   * prediction's normal field reached it, or it ran out on the way and nothing did.
   */
  const why = new Map<number, { why: Uint8Array; away: Float32Array }>();
  for (let k = -K; k <= K; k++) {
    const held = new Uint8Array(count);
    for (let node = 0; node < count; node++)
      held[node] = A[at(k * per, node)] >= 0.5 ? WHY_PREDICTION : WHY_NOTHING;
    why.set(k, { why: held, away: new Float32Array(count) });
  }
  void reached;

  return {
    ...grid,
    K,
    per,
    P,
    A,
    right,
    down,
    off: [],
    said: [],
    spread: [],
    normal: n0,
    looked: 0,
    why,
  };
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
    // What the prediction could not do, and the fit found by looking at the scan instead.
    looked: patch.looked,
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
/**
 * What held each node of the wrap nearest `w` up, and how far it ended from it — as COPIES.
 *
 * Copies because the caller sends them to the card, and sending an array to another thread hands the
 * memory over and leaves this side with nothing.  Handing over the piece's own arrays worked once and
 * then threw on every later send of the same wrap, which killed the drawing loop — so a card's line
 * moved once per wrap and stood still in between, and a drag across the sheet lines went in steps of
 * a whole wrap instead of following the hand.
 */
export function layerWhy(patch: Patch, w: number) {
  const count = patch.nu * patch.nv;
  const found = patch.why.get(Math.round(w));
  if (found === undefined) return { why: new Uint8Array(count), away: new Float32Array(count).fill(NaN) };
  return { why: found.why.slice(), away: found.away.slice() };
}

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

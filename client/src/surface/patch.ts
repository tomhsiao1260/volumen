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
  /*
   * How many places a person's annotations came to, once each chain's clicks were joined into a line,
   * and how far one of them reached.  Kept because they are the two numbers that say whether the fit
   * heard what was said and at what scale, and a reach that has collapsed to the width of a grid cell
   * makes a sheet that is a ridge along every line drawn — which draws on a slice as a lasso, and is
   * hard to read as anything else without the number in front of you.
   */
  said: { places: number; reach: number };
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
 * How far a thing said reaches, as a multiple of how close together the things said are, and the
 * least it may be in voxels.
 *
 * Decided by the annotations rather than fixed, and that is what makes drawing more of them work:
 * drawn close together they reach a short way, and the correction can then say something fine; drawn
 * far apart they reach further and the correction is broad and gentle.  A number fixed here would be
 * a ceiling on how fine a thing a person is allowed to say.
 *
 * It is the CLOSEST pair that sets it, not the middle one, and that matters twice over.  A bump much
 * wider than the gap between two places that say different things makes a system of two nearly equal
 * rows, whose answer is two huge heights that all but cancel — and away from the places, where they
 * stop cancelling, the field rings away to nothing like it.  Measured: two chains eighteen voxels
 * apart with a reach of forty moved the piece so far that not one of their own points was on it any
 * more.  And it is the shape a person asks for anyway: with the bump about as wide as the gap, the
 * field between two places said is as near a straight line between them as makes no difference.
 */
/*
 * How far one thing said reaches ACROSS the sheets, in sheets.
 *
 * The correction is a field over the piece in three directions, not two: where you are on the sheet,
 * and which sheet you are on.  This is the length of the third.  At nothing, every wrap would be
 * corrected on its own and a thing said about one would say nothing about its neighbour; at infinity,
 * every wrap moves together and two chains closer than a wrap could never be told apart.  Two sheets
 * leaves the next wrap most of what was said and the one after it half.
 *
 * It replaces a correction that was a straight line in the sheet number — one field for how far the
 * whole stack slid and one for how much a sheet was worth, which is to say two numbers to describe
 * every wrap at a place.  Two wraps fix a straight line exactly, so it looked right while there were
 * two chains; a third and a fourth have no reason to lie on it.  Measured, laying four chains along
 * the fit's OWN wraps and pushing them out by 0, 10, 0 and 10 voxels — a thing no straight line can
 * say — left them 1.5, 6.3, 3.2 and 5.9 voxels off, dragged the wrap spacing from 40 voxels down to
 * 27, and leaned the sheet up to 87° off its own normal, which a slice card draws as lassos.  The
 * same four chains pushed out all by the same amount, which IS a straight line, came out exact.
 */
const ACROSS_SHEETS = 2;
/*
 * And the one thing a person may not say: that two wraps are in the same place.  `worth` crushes the
 * space between the sheets wherever it is negative, and at minus one the sheets are on top of one
 * another — further still and they come out in the wrong order, the piece folded back through itself.
 *
 * So the space between two wraps is floored, in voxels, because that is the unit the thing being
 * prevented happens in.  Low: papyrus really does come to within a voxel or two of itself, and the
 * floor is a rail against the impossible, not an opinion about how close the sheets may get.  It
 * gives way softly — a hard clamp would leave a crease along the line where it started biting.
 *
 * The Vesuvius Challenge's own spiral fit carries the same rail (`model_gap_expander_min_gap`), for
 * the same reason: its gap is a field too, and a field that may go negative will.
 */
const GAP_LEAST = 2;
/*
 * How far apart two places a person clicked one after another may be and still be taken as a line
 * drawn between them, as a multiple of how far apart that chain's clicks usually are.
 *
 * A chain is an ordered list of places, and a run of them a few voxels apart is somebody tracing one
 * stretch of sheet: they mean the sheet between the clicks as much as they mean the clicks, and the
 * dashed line already drawn between them says so.  A jump ten times the usual is them going to look
 * somewhere else, and joining those two with a straight line would be asserting a shape across a
 * stretch nobody has looked at.
 */
const JOIN_FAR = 3;
/*
 * And how well a click is believed, in voxels.
 *
 * A hand placing a point on a slice is good to about a voxel and no better, so a fit held to pass
 * through every click exactly is being made to reproduce a shake.  Said as a tolerance instead, the
 * run of clicks along one stretch of sheet averages its own jitter down — which is why every point is
 * kept rather than thinned — and what is left is the undulation they all agree on.
 *
 * It is also what makes a line's worth of places solvable at all: a hundred of them a few voxels
 * apart ask very nearly the same question, and a system of very nearly equal rows has an answer of
 * enormous numbers that cancel, and rings between them where they stop cancelling.
 */
const HAND = 1;
/*
 * How far one thing said reaches sideways, off the line it was said on, as a multiple of the space
 * between two wraps.
 *
 * One number, from the papyrus itself, and not from how the annotations happen to be arranged — which
 * is the mistake this replaces.  Taking it from the closest pair of places said by different chains
 * read well on paper and was wrong on a real board, for a reason worth writing down: a person draws
 * a chain on ONE slice card, so all its points lie in one plane, and two chains drawn that way on two
 * different wraps lie on top of each other in the grid — a few voxels apart, since they are stacked
 * along the normal and not across the sheet.  Joining each chain's clicks into a line then puts a
 * place of one within six voxels of a place of the other, and the reach collapsed to the width of one
 * grid cell.  What came out was a sheet with a sharp ridge along every line drawn: measured, the
 * sheet leaned more than 58° off its own normal over a tenth of itself, and the curve it cut on a
 * slice card broke into lassos — 117 grid squares in two blotches where a sheet square to the cut
 * gives one band of about 55.
 *
 * It does not need to come from the annotations, because nothing is left for it to decide.  Along a
 * line, every grid cell of it is said, so no reach is needed; across to another wrap, `worth` holds
 * the two apart, not the kernel.  All that is left is how far a line's say carries into the parts
 * nobody has looked at, and the only length the piece has from the papyrus is how far apart its wraps
 * are.  Swept against both a real board and the synthetic pair: a sixth of a wrap gave the lassos
 * above; half a wrap fixed them; a whole wrap was better again on every measure (the far chain of the
 * synthetic pair 2.06 voxels off, then 1.07, then 0.42); and one and a half was no better than one.
 */
const REACH_OF_WRAP = 1;
/*
 * And how far apart two places have to be ACROSS the sheet to count as two places at all: one grid
 * cell, since a field held on the grid cannot tell apart anything closer.
 *
 * Two on the same line through the sheets — one on this wrap, one on the next — are the same place to
 * it, and they are not exactly on top of one another: walking eighteen voxels along a normal that is
 * not quite square to the grid moves a place a voxel across it.  Counted as neighbours they set the
 * reach to that voxel, the field is then finer than the grid it is held on, and what the grid makes
 * of it is noise — measured, a reach of 4 voxels where it should have been 23, the correction left
 * half undone and the sheet crumpled by 38 voxels.
 */
const sameplace = (grid: PatchGrid) => Math.min(grid.hu, grid.hv);
/*
 * The Matérn of five halves, at a distance already divided by how far it is meant to reach:
 *
 *     φ(r) = (1 + √5 r + 5r²/3) · e^(−√5 r)
 *
 * One at nothing, falling smoothly to nothing by about twice its reach.  Twice differentiable, which
 * is why a place said comes out as a rise and not as a spike — a first-order energy, which is what a
 * field smoothed on the grid would be, has a cusp at every point constraint, and a row of cusps is a
 * saw.  Positive definite, so the system it makes always has one answer.
 */
const bump = (r: number) => {
  const q = Math.sqrt(5) * Math.abs(r);
  return (1 + q + (q * q) / 3) * Math.exp(-q);
};

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
/*
 * The correction, kept as one field over the grid per sheet anything was said about.  What the whole
 * field says at a place on sheet w is the sum of them, each weighted by how near w is to its own
 * sheet (`ACROSS_SHEETS`).
 */
interface Shift {
  on: number[];
  field: Float64Array[];
}

interface Said {
  // The chain it came from: two things said by one chain are one line, two by different chains are not.
  chain: string;
  gi: number;
  gj: number;
  value: number;
  k: number;
}

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

  /*
   * Which sheet each chain is on.
   *
   * Two steps, and the second is the one that matters: a chain is first given the sheet most of its
   * own points are nearest to, and then every relative winding is read as what it says — that the
   * chains it runs through are DIFFERENT sheets, one after another in the order it crosses them.
   *
   * Without that second step the first one puts two chains that happen to lie less than half a sheet
   * apart on the same sheet, and the fit, being told to pass through both, does the only thing it can
   * and weaves up and down between them.  That is not the fit disobeying: it is the fit obeying two
   * things that cannot both be true, and only the relative winding knows which.
   */
  const onSheet = new Map<string, number>();
  for (const chain of chains) {
    const places = found.get(chain.id);
    if (places === undefined || places.length < 2 || chain.kind !== "same") continue;
    const settled = sheets.get(chain.id);
    if (settled !== undefined) {
      onSheet.set(chain.id, settled);
      continue;
    }
    const votes = new Map<number, number>();
    for (const one of places) votes.set(Math.round(one.w), (votes.get(Math.round(one.w)) ?? 0) + 1);
    let best = -1, sheet = 0;
    for (const [which, count] of votes) if (count > best) { best = count; sheet = which; }
    onSheet.set(chain.id, sheet);
  }

  // The chain a place of a relative winding is nearest to, where it is near one at all.
  const nearestChain = (one: { at: Vec3 }) => {
    let best: string | undefined, away = spacing * SAID_REACH;
    for (const [id, places] of found) {
      if (chains.find((each) => each.id === id)?.kind !== "same") continue;
      for (const place of places) {
        const d = Math.hypot(one.at[0] - place.at[0], one.at[1] - place.at[1], one.at[2] - place.at[2]);
        if (d < away) { away = d; best = id; }
      }
    }
    return best;
  };

  const free: Said[] = [];
  for (const chain of chains) {
    if (chain.kind !== "step") continue;
    const places = found.get(chain.id);
    if (places === undefined || places.length < 2) continue;
    // The chains it runs through, in the order it runs through them, each named once.
    const through: { id: string | undefined; w: number; place: (typeof places)[0] }[] = [];
    for (const place of places) {
      const id = nearestChain(place);
      if (id !== undefined && through.length > 0 && through[through.length - 1].id === id) continue;
      through.push({ id, w: place.w, place });
    }
    for (let k = 1; k < through.length; k++) {
      const [before, here] = [through[k - 1], through[k]];
      if (before.id === undefined || here.id === undefined) continue;
      const was = onSheet.get(before.id);
      if (was === undefined) continue;
      // One sheet further out, the way the piece already has them ordered.  How many sheets apart
      // they are is not something a relative winding says, and next door is what a person means by
      // drawing one: these two, and nothing between them.
      onSheet.set(here.id, was + (here.w >= before.w ? 1 : -1));
    }
    /*
     * And a place of a relative winding that is near no chain at all — the inside of a pit, say — is
     * still a thing said: it is not on the sheet the place before it is on.
     */
    for (let k = 0; k + 1 < through.length; k++) {
      const [a, b] = [through[k], through[k + 1]];
      if (a.id !== undefined && b.id !== undefined) continue;
      const [stay, move] = a.id !== undefined ? [a, b] : [b, a];
      const anchor = stay.id === undefined ? Math.round(stay.w) : (onSheet.get(stay.id) ?? Math.round(stay.w));
      const sheet = anchor + (move.w >= stay.w ? 1 : -1);
      free.push({ chain: chain.id, gi: move.place.gi, gj: move.place.gj, value: move.w - sheet, k: sheet });
    }
  }
  for (const [id, sheet] of onSheet) sheets.set(id, sheet);

  /*
   * And what each place asks of the winding: its own w less the sheet its chain is on.  Moving the
   * base OUT by one winding moves every wrap out with it, so a place measured against the piece reads
   * one LESS than it did — the correction is that way round and not the other.
   */
  const want: Said[] = [...free];
  for (const [id, places] of found) {
    const sheet = onSheet.get(id);
    if (sheet === undefined) continue;
    const asked = (one: (typeof places)[0]) => one.w - sheet;
    for (const one of places) want.push({ chain: id, gi: one.gi, gj: one.gj, value: asked(one), k: sheet });

    /*
     * And the line between each click and the next, said as well as the clicks themselves.
     *
     * This is the whole of the answer to a sheet shaped like a saw.  A correction that fades away
     * from the places it was said at is right — nothing should be claimed where nobody has looked —
     * but between two clicks twenty voxels apart on ONE chain there is no "away": a person tracing a
     * stretch of sheet has looked at all of it, and what they mean is the line, which the card has
     * been drawing dashed between the points all along.  Said only at the clicks, the correction
     * sagged back towards the walked surface in between and came up again at each one; measured on a
     * real board, the sheet sat 2 to 5 voxels off at the clicks and 5 to 15 between them.
     *
     * So the line is spelled out: a place every grid cell along it, asking for the same thing the two
     * ends ask for, in between.  There is nothing left for the correction to sag into.
     */
    const steps = places.slice(1).map((one, i) =>
      Math.hypot(one.at[0] - places[i].at[0], one.at[1] - places[i].at[1], one.at[2] - places[i].at[2]));
    const usual = [...steps].sort((a, b) => a - b)[steps.length >> 1] ?? 0;
    for (let i = 0; i + 1 < places.length; i++) {
      if (steps[i] > JOIN_FAR * usual) continue;
      const [a, b] = [places[i], places[i + 1]];
      const along = Math.hypot((b.gi - a.gi) * patch.hv, (b.gj - a.gj) * patch.hu);
      const cuts = Math.floor(along / sameplace(patch));
      for (let s = 1; s < cuts; s++) {
        const t = s / cuts;
        want.push({
          chain: id,
          gi: a.gi + t * (b.gi - a.gi),
          gj: a.gj + t * (b.gj - a.gj),
          value: asked(a) + t * (asked(b) - asked(a)),
          k: sheet,
        });
      }
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
function bend(grid: PatchGrid, want: Said[], reach: number, spacing: number) {
  const { nu, nv, hu, hv } = grid;
  const n = want.length;
  // In voxels, so that one reach means the same thing across and down a grid that is not square.
  const where = want.map((one) => [one.gj * hu, one.gi * hv]);
  const far = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  /*
   * One field, over the piece in three directions: where you are on the sheet, and WHICH sheet.
   *
   * A place said is a place on a sheet, and what it asks for is how far the winding there is out.
   * Two places at one spot on different sheets are then simply two places, far apart in the third
   * direction, and the field can give them different answers — which is what lets a relative winding
   * separate two chains closer together than one wrap.  Nothing is assumed about how the correction
   * runs from one sheet to the next except that it is smooth over ACROSS_SHEETS of them.
   *
   * The bump is the Matérn of five halves in each direction, multiplied:
   *
   *     φ(r) = (1 + √5 r + 5r²/3) · e^(−√5 r),   K = φ(d / reach) · φ(Δsheet / ACROSS_SHEETS)
   *
   * which is twice differentiable, so a place said is a smooth rise and not a spike; positive
   * definite in each direction and so in the product, so the heights always exist and are unique; and
   * falling away to nothing in both, so that where nobody has said anything the sheet is the
   * prediction's own and not an extrapolation of somebody's hand.
   */
  const M: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = new Array<number>(n + 1);
    for (let j = 0; j < n; j++)
      row[j] = bump(far(where[i], where[j]) / reach) * bump((want[i].k - want[j].k) / ACROSS_SHEETS);
    // How well a click is believed, as a tolerance on the diagonal: see HAND.  It is also what makes a
    // line's worth of places — each all but repeating its neighbour — a system with a sane answer.
    row[i] += (HAND / spacing) ** 2;
    row[n] = want[i].value;
    M.push(row);
  }
  for (let c = 0; c < n; c++) {
    let best = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[best][c])) best = r;
    [M[c], M[best]] = [M[best], M[c]];
    const pivot = M[c][c];
    if (Math.abs(pivot) < 1e-12) continue;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const factor = M[r][c] / pivot;
      if (factor === 0) continue;
      for (let k = c; k <= n; k++) M[r][k] -= factor * M[c][k];
    }
  }
  const height = new Float64Array(n);
  for (let c = 0; c < n; c++) height[c] = Math.abs(M[c][c]) < 1e-12 ? 0 : M[c][n] / M[c][c];

  /*
   * Kept as one field over the grid per sheet anything was said about, rather than evaluated afresh
   * at every layer of the table.  The bump is a product of one part across the sheet and one part
   * across the sheets, so the first part can be summed once per sheet said and the second applied
   * layer by layer — a few thousand multiplications instead of the tens of millions the same answer
   * costs written out.
   */
  const on = [...new Set(want.map((one) => one.k))].sort((a, b) => a - b);
  const slot = want.map((one) => on.indexOf(one.k));
  const field = on.map(() => new Float64Array(nu * nv));
  for (let i = 0; i < nv; i++)
    for (let j = 0; j < nu; j++) {
      const at = [j * hu, i * hv], node = i * nu + j;
      for (let c = 0; c < n; c++) field[slot[c]][node] += height[c] * bump(far(at, where[c]) / reach);
    }
  return { on, field };
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
  const table = (R: number, Q: { P: Float32Array; A: Float32Array }, shift?: Shift) => {
    const layers = 2 * K * per + 1;
    const P = new Float32Array(layers * count * 3).fill(NaN);
    const A = new Float32Array(layers * count);

    /*
     * Where each layer of each node's own walk is read from, once what was said has slid it.
     *
     * Worked out for the whole column of a node before any of it is read, because the one thing that
     * must hold of the answer cannot be stated layer by layer: the places read have to go up as the
     * layer does.  Where they do not, two wraps have swapped over and the piece is folded through
     * itself — which is a thing no correction may ever buy, however plainly it was asked for.
     */
    const read = new Float64Array(layers * count);
    for (let k = -K * per; k <= K * per; k++) {
      const layer = (k + K * per) * count;
      if (shift === undefined) {
        for (let node = 0; node < count; node++) read[layer + node] = k;
        continue;
      }
      const near = shift.on.map((sheet) => bump((k / per - sheet) / ACROSS_SHEETS));
      for (let node = 0; node < count; node++) {
        let c = 0;
        for (let s = 0; s < near.length; s++) c += shift.field[s][node] * near[s];
        read[layer + node] = k + c * per;
      }
    }
    /*
     * And the floor, in the one place it can honestly be put: two wraps may come to GAP_LEAST voxels
     * of each other and no closer.  Held outward from the piece's own sheet so that the wrap a person
     * is looking at does not move when a wrap three out is the one being held apart.
     *
     * The Vesuvius Challenge's spiral fit carries the same rail — `model_gap_expander_min_gap` — for
     * the same reason: its gap between windings is a field too, and a field that may go negative will.
     */
    const least = GAP_LEAST / apart;
    for (let node = 0; node < count; node++) {
      for (let k = 1; k <= K * per; k++) {
        const here = (k + K * per) * count + node, below = (k - 1 + K * per) * count + node;
        if (read[here] - read[below] < least) read[here] = read[below] + least;
      }
      for (let k = -1; k >= -K * per; k--) {
        const here = (k + K * per) * count + node, above = (k + 1 + K * per) * count + node;
        if (read[above] - read[here] < least) read[here] = read[above] - least;
      }
    }

    for (let k = -K * per; k <= K * per; k++)
      for (let node = 0; node < count; node++) {
        const at = read[(k + K * per) * count + node];
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

  const said = { places: 0, reach: 0 };
  const plain: Patch = { ...grid, K, per, ...table(reach, walked), right, down, normal: n0, said };
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
  said.places = want.length;
  said.reach = apart * REACH_OF_WRAP;
  const shift = bend(grid, want, said.reach, apart);
  return { ...grid, K, per, ...table(reach, walked, shift), right, down, normal: n0, said };
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
    // What a person said, and how far one thing said reached: see Patch.said.
    said: patch.said.places,
    reach: patch.said.reach,
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

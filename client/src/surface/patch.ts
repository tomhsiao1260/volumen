/**
 * @file A flattened piece of papyrus: a grid of points over one sheet, and the same grid over each of
 * the sheets either side of it.
 *
 * The result is a table P[k][i][j] of scan positions: row i and column j of the grid on layer
 * w = k / per, where whole w are sheets and the rest lie evenly between them.  Drawing a layer is
 * then looking positions up in the table and sampling the scan there (`render.ts`).
 *
 * Two things go into it and nothing else: the prediction's NORMAL field, which says which way is
 * across the sheets, and what a PERSON has said about which places are the same sheet.  Not the
 * phase, not the surface mask, not the winding density, and it never looks around for a nearby sheet
 * to snap to.  That is a decision, not an omission: measured on Scroll 1 over a box of 340x240 voxels
 * (`scratchpad/pup/explain.cjs`), the phase puts a sheet in the right place 51% of the time where 50%
 * is a coin, 55% of sheets have no predicted face within 10 voxels, and the winding density is out by
 * half; the normal is within 19° of the scan's own grain half the time, and is the only one worth
 * walking.
 *
 * So the piece is walked out of the normal field, and everything a person says is a correction to the
 * WINDING it walked — never a pull on the surface.  How far apart the sheets are is the one number
 * the normal cannot give, and it comes from a relative winding (`spacingSaid`).
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
 * Each node walks its own path through the same field, and two that start a few voxels apart drift
 * apart a little more with every step: a sheet slowly turning into a rumpled one.  A plain Laplacian
 * takes that out and leaves a real curve alone — over the cell and a half it reaches, a sheet bending
 * on a radius of five hundred voxels departs from the line between its neighbours by two hundredths
 * of a voxel.
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
 * How far one thing said reaches ACROSS the sheets, in sheets.
 *
 * The correction is a field in three directions, not two: where you are on the sheet, and which sheet
 * you are on.  This is the length of the third.  At nothing, a thing said about one wrap would say
 * nothing about its neighbour; at infinity, every wrap moves together and two chains closer than a
 * wrap could never be told apart.  Two sheets leaves the next wrap most of what was said and the one
 * after it half.
 *
 * Nothing is assumed about the shape it takes from sheet to sheet.  A correction that was a straight
 * line in the sheet number is exact for two wraps and has no reason to fit a third: measured, four
 * chains asking for 0, 10, 0 and 10 voxels came out 1.5, 6.3, 3.2 and 5.9 voxels off, dragged the
 * wrap spacing from 40 voxels to 27, and leaned the sheet 87° off its own normal.
 */
const ACROSS_SHEETS = 2;
/*
 * And the one thing a person may not say: that two wraps are in the same place.  Low, because papyrus
 * really does come to within a few µm of itself — a rail against the impossible, not an opinion about
 * how close the sheets may get.  The Vesuvius Challenge's spiral fit carries the same rail
 * (`model_gap_expander_min_gap`).
 */
const GAP_LEAST_UM = 5;
/*
 * How far apart two places a person clicked one after another may be and still be taken as a line
 * drawn between them, as a multiple of how far apart that chain's clicks usually are.
 *
 * A run of clicks a few voxels apart is somebody tracing one stretch of sheet: they mean the sheet
 * between the clicks as much as the clicks, and the dashed line already drawn between them says so.
 * A jump ten times the usual is them going to look somewhere else, and a straight line across that
 * would assert a shape nobody has looked at.
 */
const JOIN_FAR = 3;
/*
 * And how well a click is believed, in voxels.
 *
 * A hand placing a point on a slice is good to about a voxel, so a fit held to pass through every
 * click exactly is being made to reproduce a shake.  Said as a tolerance, a run of clicks along one
 * stretch averages its own jitter down — which is why every point is kept rather than thinned.  It is
 * also what makes a line's worth of places solvable at all: a hundred of them a few µm apart ask very
 * nearly the same question, and very nearly equal rows have an answer of enormous numbers that
 * cancel, and ring between them where they stop cancelling.
 */
const HAND_UM = 2.5;
/*
 * …but never better than a voxel, whatever a voxel is worth.  A hand places a point by eye on a
 * picture, so its reach is a pixel of that picture and not a length in the scroll: on a 7.9 µm scan
 * the µm figure above would be a third of a voxel, which claims a steadier hand than anyone has and
 * takes the tolerance back out of a system that needs it (see the paragraph above).
 */
const HAND_LEAST = 1;
/*
 * And how far apart the things said have to spread, as a fraction of the reach, before the plane is
 * allowed a tilt that way.  A quarter: closer together than that they are a line, not a patch, and a
 * line has no opinion about which way the ground slopes across it.
 */
const PLANE_SPREAD = 0.25;
/*
 * How far one thing said reaches sideways, off the line it was said on, as a multiple of the space
 * between two wraps.
 *
 * One number, from the papyrus itself, and not from how the annotations happen to be arranged.  That
 * was tried: a person draws a chain on ONE slice card, so two chains on two different wraps lie on
 * top of each other in the grid, and a reach taken from the closest pair of different chains
 * collapsed to the width of a grid cell — a sheet with a sharp ridge along every line drawn, leaning
 * 58° off its own normal, which a slice card draws as lassos.
 *
 * It does not need to come from the annotations, because nothing is left for it to decide: along a
 * line every grid cell of it is said, and across to another wrap `ACROSS_SHEETS` holds the two apart.
 * All that is left is how far a line's say carries into the parts nobody has looked at, and the only
 * length the piece has from the papyrus is how far apart its wraps are.
 */
const REACH_OF_WRAP = 2;
// And how far apart two places have to be ACROSS the sheet to count as two places at all: one grid
// cell, since a field held on the grid cannot tell apart anything closer.
const sameplace = (grid: PatchGrid) => Math.min(grid.hu, grid.hv);
/*
 * The Matérn of five halves, at a distance already divided by how far it is meant to reach:
 *
 *     φ(r) = (1 + √5 r + 5r²/3) · e^(−√5 r)
 *
 * One at nothing, falling smoothly to nothing by about twice its reach.  Twice differentiable, which
 * is why a place said comes out as a rise and not a spike — a field smoothed on the grid is a
 * first-order energy, which has a cusp at every point constraint, and a row of cusps is a saw.
 * Positive definite, so the system it makes always has one answer.
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

/**
 * Each node a quarter of the way towards the middle of its neighbours, so that the grid stays a sheet
 * as it marches — and the edge of it stays where it is.
 *
 * A node on the edge has a neighbour missing, and dropping it leaves the average of the rest sitting
 * inside the piece, so every pass pulls the edge in a little.  Seventy-two passes over a march, and
 * the outermost ring of cells comes out at half the width it was laid out at — which the card draws
 * at twice the size, a band of smeared papyrus all round the piece.  Measured: the outer ring at 0.47
 * of its spacing against 0.89 one ring in.
 *
 * So the missing neighbour is REFLECTED instead: taken as the node's own place carried the same
 * distance the other way.  On a straight edge that leaves the average exactly where the node already
 * is, so nothing is pulled anywhere; on a curved one it keeps the curve.
 */
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
        let o = y < 0 || x < 0 || y >= nv || x >= nu ? -1 : y * nu + x;
        if (o >= 0 && !alive[o]) o = -1;
        if (o >= 0) {
          sum[0] += was[o * 3];
          sum[1] += was[o * 3 + 1];
          sum[2] += was[o * 3 + 2];
          n++;
          continue;
        }
        // Nothing that way: the node's place carried the same distance back the other way, if there
        // is anything there to carry.
        const by = i - di, bx = j - dj;
        if (by < 0 || bx < 0 || by >= nv || bx >= nu) continue;
        const b = by * nu + bx;
        if (!alive[b]) continue;
        for (let c = 0; c < 3; c++) sum[c] += 2 * was[k * 3 + c] - was[b * 3 + c];
        n++;
      }
      if (n === 0) continue;
      for (let c = 0; c < 3; c++) at[k * 3 + c] += HOLD * (sum[c] / n - was[k * 3 + c]);
    }
}

/*
 * The correction, kept as one field over the grid per sheet anything was said about.  What the whole
 * field says at a place on sheet w is the sum of them, each weighted by how near w is to its own
 * sheet (`ACROSS_SHEETS`).
 */
interface Shift {
  on: number[];
  field: Float64Array[];
  // The plane under the bumps, which is the same on every sheet (see `bend`).
  flatAt: Float64Array;
}

interface Said {
  // The chain it came from: two things said by one chain are one line, two by different chains are not.
  chain: string;
  gi: number;
  gj: number;
  value: number;
  k: number;
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
function saidAbout(patch: Patch, chains: ChainSaid[], spacing: number) {
  const { nu, nv } = patch;
  const reach = spacing * SAID_REACH;
  const found = new Map<string, { gi: number; gj: number; w: number; at: Vec3 }[]>();
  for (const chain of chains) {
    const places = [];
    for (const point of chain.points) {
      const on = nearestOn(patch, point.at);
      if (on === undefined || on.away > reach) continue;
      /*
       * Kept where it really is, between the grid points, and never rounded to one — two places
       * rounded onto one node fight over its single value, and two rounded onto neighbouring nodes
       * leave a step between them, which is a crease in the sheet.
       *
       * And a place off the EDGE of the piece is dropped rather than pulled onto it: the nearest
       * place on the piece to a click past its edge is the edge, so holding them would pile every
       * such click onto the last row, each asking for something different.
       */
      const gi = Math.min(nv - 1, Math.max(0, on.gi));
      const gj = Math.min(nu - 1, Math.max(0, on.gj));
      if (Math.abs(gi - on.gi) > 0.5 || Math.abs(gj - on.gj) > 0.5) continue;
      places.push({ gi, gj, w: on.w, at: point.at });
    }
    /*
     * Every point kept, never thinned.  Thinning to one point every twenty voxels is what the
     * Vesuvius Challenge does and is right for a spiral across a whole scroll; here it would throw
     * away the small undulations this tool exists to show.  A hand's jitter is dealt with instead of
     * thrown away — it is not the same from one click to the next, so a run of them averages it down
     * while a real undulation survives (see HAND).
     */
    if (places.length > 0) found.set(chain.id, places);
  }

  /*
   * Which sheet each chain is on.
   *
   * Three steps.  A chain is first given the sheet most of its own points are nearest to; then every
   * relative winding is read as what it says — that the chains it runs through are DIFFERENT sheets,
   * one after another in the order it crosses them; and then, of the chains nobody has said anything
   * about, no two are left on one sheet.
   *
   * That last step is the default, and it is this way round on purpose: drawing a same winding
   * through a place already on one joins the two chains into one, so the app already has a way of
   * saying "these two runs of clicks are the same wrap".  Two chains are therefore two sheets until
   * somebody says otherwise, and a chain drawn on one slice card is no longer merged with one drawn
   * on another just because they pass within half a wrap.  Asked to go through both, the fit could
   * only weave between them — not disobeying, but obeying two things that cannot both be true.
   */
  const onSheet = new Map<string, number>();
  for (const chain of chains) {
    const places = found.get(chain.id);
    if (places === undefined || places.length < 2 || chain.kind !== "same") continue;
    const votes = new Map<number, number>();
    for (const one of places) votes.set(Math.round(one.w), (votes.get(Math.round(one.w)) ?? 0) + 1);
    let best = -1, sheet = 0;
    for (const [which, count] of votes) if (count > best) { best = count; sheet = which; }
    onSheet.set(chain.id, sheet);
  }
  // The chains a relative winding has spoken about, which the default below leaves alone.
  const told = new Set<string>();

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
      told.add(before.id);
      told.add(here.id);
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
  /*
   * And no two chains left on one sheet, taken in the order the piece itself has them: a chain that
   * would land on a sheet already spoken for is moved out to the next one.  A chain a relative winding
   * placed keeps its sheet whatever happens — that was said, and this is only what happens when
   * nothing was.
   */
  const middleOf = (id: string) => {
    const ws = (found.get(id) ?? []).map((one) => one.w).sort((a, b) => a - b);
    return ws.length === 0 ? 0 : ws[ws.length >> 1];
  };
  let last = -Infinity;
  for (const id of [...onSheet.keys()].sort((a, b) => middleOf(a) - middleOf(b))) {
    const sheet = onSheet.get(id) ?? 0;
    const next = told.has(id) || sheet > last ? sheet : last + 1;
    onSheet.set(id, next);
    last = Math.max(last, next);
  }

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
 * Those corrections spread over the grid: the smoothest field that passes through every place said.
 *
 * Through every one, because a line that misses the place a person put their finger is the one thing
 * an annotation must never be: this is a tool for saying something, seeing what it does, and saying
 * the next thing.  That does not have to be bought with a sheet shaped like a saw — the saw was never
 * the price of exactness but of asking for the FLATTEST field rather than the least bent one, which
 * on a grid means a Laplacian, whose answer to a point held at a value is a spike (its Green's
 * function is log r, which has no bottom).
 *
 * So the field is not solved on the grid at all.  It is a sum of one smooth `bump` per place said,
 * with the heights chosen so the sum reads what was said at every one — plus a PLANE under them.
 *
 * The field has three directions, not two: where you are on the sheet, and WHICH sheet.  Two places
 * at one spot on different sheets are then simply two places, far apart in the third direction, and
 * the field can give them different answers — which is what lets a relative winding separate two
 * chains closer together than one wrap.  So the bump is a product, φ(d / reach) · φ(Δsheet /
 * ACROSS_SHEETS): positive definite in each direction and so in the product, so the heights always
 * exist and are unique.
 *
 * The plane is a constant and a tilt across the sheet, held by the usual side conditions that the
 * bumps sum to nothing against each of them, so it takes whatever the places said agree about and
 * the bumps are left with the rest.  It is there because the bumps alone fall away to nothing, and
 * nothing is the WRONG answer far from what was said: a person working on the cut planes of a card
 * draws along one row and down one column, and every click may be saying the same simple thing —
 * this whole wrap is twelve voxels out.  Held on the cross and forgotten off it, that draws a cross
 * of right answer on a ground of wrong one; measured, the sheet moved 11.9 voxels on the cross, 6.2
 * a few cells away and 0.2 at the corners.  A plane is also the mildest thing that can carry: it
 * says "and more of the same, gently", where a thin plate spline's r² log r would tip the whole card
 * over.  What it cannot do is invent a shape nobody has described.
 *
 * Across the sheet only, and never between sheets.  A term in the sheet number is the same straight
 * line in k this fit was built to be rid of, and the side conditions would stop the bumps taking it
 * back: four chains asking for 0, 10, 0 and 10 voxels put a slope through themselves that dragged
 * the wrap spacing from 42 voxels to 52.  A constant moves every wrap alike, which changes no
 * spacing, and is the one thing a place said on one sheet can honestly carry to another.
 */
function bend(grid: PatchGrid, want: Said[], reach: number, spacing: number, micron: number) {
  const { nu, nv, hu, hv } = grid;
  const n = want.length;
  // In voxels, so that one reach means the same thing across and down a grid that is not square.
  const where = want.map((one) => [one.gj * hu, one.gi * hv]);
  const far = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

  const middle = [0, 1].map((c) => where.reduce((sum, one) => sum + one[c], 0) / (n || 1));
  /*
   * The plane's parts, scaled by the reach so that a tilt is about as big as the constant — and a
   * tilt only where the things said actually spread out that way.
   *
   * A chain drawn on one cut plane lies along a single row of the grid, so what it says about how the
   * correction should tilt ACROSS that row is nothing at all.  Left in, that column of the system is
   * near zero but not zero, its coefficient comes out enormous, and the tilt it stands for — tiny
   * where it was fitted, large everywhere else — runs away across the card.
   */
  const ways = [
    () => 1,
    (at: number[]) => (at[0] - middle[0]) / reach,
    (at: number[]) => (at[1] - middle[1]) / reach,
  ];
  const spread = (way: (at: number[]) => number) => {
    const vs = where.map(way);
    return Math.max(...vs) - Math.min(...vs);
  };
  const used = ways.filter((way, c) => c === 0 || spread(way) > PLANE_SPREAD);
  const flat = (at: number[]) => used.map((way) => way(at));
  const WIDE = used.length;

  const M: number[][] = [];
  for (let i = 0; i < n; i++) {
    const row = new Array<number>(n + WIDE + 1).fill(0);
    for (let j = 0; j < n; j++)
      row[j] = bump(far(where[i], where[j]) / reach) * bump((want[i].k - want[j].k) / ACROSS_SHEETS);
    // How well a click is believed, as a tolerance on the diagonal: see HAND.  It is also what makes a
    // line's worth of places — each all but repeating its neighbour — a system with a sane answer.
    row[i] += (Math.max(HAND_UM / micron, HAND_LEAST) / spacing) ** 2;
    const p = flat(where[i]);
    for (let c = 0; c < WIDE; c++) row[n + c] = p[c];
    row[n + WIDE] = want[i].value;
    M.push(row);
  }
  // And the side conditions: the bumps say nothing that the plane could have said.
  for (let c = 0; c < WIDE; c++) {
    const row = new Array<number>(n + WIDE + 1).fill(0);
    for (let i = 0; i < n; i++) row[i] = flat(where[i])[c];
    M.push(row);
  }

  const size = n + WIDE;
  for (let c = 0; c < size; c++) {
    let best = c;
    for (let r = c + 1; r < size; r++) if (Math.abs(M[r][c]) > Math.abs(M[best][c])) best = r;
    [M[c], M[best]] = [M[best], M[c]];
    const pivot = M[c][c];
    if (Math.abs(pivot) < 1e-12) continue;
    for (let r = 0; r < size; r++) {
      if (r === c) continue;
      const factor = M[r][c] / pivot;
      if (factor === 0) continue;
      for (let k = c; k <= size; k++) M[r][k] -= factor * M[c][k];
    }
  }
  const answer = new Float64Array(size);
  for (let c = 0; c < size; c++) answer[c] = Math.abs(M[c][c]) < 1e-12 ? 0 : M[c][size] / M[c][c];
  const height = answer.subarray(0, n);
  const plane = Array.from(answer.subarray(n));

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
  // The plane over the grid: the same on every sheet, so one number a node holds it.
  const flatAt = new Float64Array(nu * nv);
  for (let i = 0; i < nv; i++)
    for (let j = 0; j < nu; j++) {
      const at = [j * hu, i * hv], node = i * nu + j;
      for (let c = 0; c < n; c++) field[slot[c]][node] += height[c] * bump(far(at, where[c]) / reach);
      const p = flat(at);
      let sum = 0;
      for (let c = 0; c < WIDE; c++) sum += plane[c] * p[c];
      flatAt[node] = sum;
    }
  return { on, field, flatAt };
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
  /*
   * And how big a voxel is, in µm.
   *
   * Every length this fit uses is either a count of sheets or a multiple of how far apart the sheets
   * are — and that comes from a person's own relative winding — so the fit does not care what a voxel
   * is worth.  These three do: how close two wraps may come, how well a click is believed, and the
   * spacing to fall back on when nobody has said.  Said in µm they mean the same thing on a scan of
   * any resolution.
   */
  micron = 2.4,
): Patch | undefined {
  // Where the person pressed, not the nearest sheet to it: moving the seed is already a decision
  // about which sheet they meant, and this fit makes no such decisions.
  const n0 = normalAt(field, seed, towards);
  if (n0 === null) return undefined;

  const { nu, nv } = grid;
  const count = nu * nv;
  const apart = spacingSaid(field, chains, n0, spacing);
  const { X, right, down } = baseSurface(field, seed, n0, grid);

  const from = (start: Float64Array): Patch => {
  /*
   * Walked once, and further than the piece needs: the room either side is what a correction slides
   * into.
   */
  const reach = (K + MARGIN) * per;
  const walked = walk(field, start, n0, grid, reach, per, apart);
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
        let c = shift.flatAt[node];
        for (let s = 0; s < near.length; s++) c += shift.field[s][node] * near[s];
        read[layer + node] = k + c * per;
      }
    }
    // And the floor, in the one place it can honestly be put: two wraps may come to GAP_LEAST voxels
    // of each other and no closer.  Held outward from the piece's own sheet, so the wrap a person is
    // looking at does not move when a wrap three out is the one being held apart.
    const least = GAP_LEAST_UM / micron / apart;
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
   * And what a person has said, held EXACTLY — by sliding the WINDING, never by bending the sheet.
   *
   * This is the shape of the Vesuvius Challenge's spiral fit in the small: there a sheet is an integer
   * level set of one winding function and an annotation is a statement about that function.  Here the
   * winding function is already in hand — how far along its own path a node is IS its winding — so a
   * thing said is met by resampling each path at a shifted winding, which is exact and done once.
   * Moving the base and walking again instead only creeps: measured, 26 voxels out became 17, then
   * 18, 21, 24, 30.
   */
  const want = saidAbout(plain, chains, apart);
  if (want.length === 0) return plain;
  said.places = want.length;
  said.reach = apart * REACH_OF_WRAP;
  const shift = bend(grid, want, said.reach, apart, micron);
  return { ...grid, K, per, ...table(reach, walked, shift), right, down, normal: n0, said };
  };

  /*
   * Built twice, the second time from a base spread so that the sheet comes out evenly sampled.
   *
   * Moving a sheet inward through a curved stack really does make it smaller — that is geometry, not
   * a fault — and the nodes, each walking its own path, come along with it.  So where a correction
   * moves the sheet a long way the grid bunches up, and the card draws that patch of papyrus larger
   * than the rest: measured on a real board, neighbouring nodes came out at 0.63 of the spacing they
   * were laid out on, which is that stretch of papyrus drawn half as big again.
   *
   * Nothing can stop a sheet shrinking.  What can be fixed is WHERE the nodes sit on it: the first
   * piece says how the sheet came out, the base is re-spread so that the second comes out even, and
   * the outline is untouched because only the inside of each row and column is moved.
   */
  return from(X);
}


/**
 * How far apart this piece's wraps actually came out, in voxels: the middle of the distances from
 * each node of wrap 0 to the same node of wrap 1.
 *
 * Asked of the piece rather than of the prediction on purpose: it sets the card's scale, so it has to
 * describe the wraps that are drawn.  Measured on Scroll 1 the two differ by half.
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

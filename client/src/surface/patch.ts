/**
 * @file A flattened piece of papyrus: a grid over one sheet, and for every grid point where each
 * neighbouring sheet is, found by following the sheet normal through the Lasagna field.
 *
 * The result is a table P[k][i][j] of scan positions: row i and column j of the grid on layer
 * w = k / per, where whole w are sheets and halves the gaps between them.  Drawing a layer is then
 * looking positions up in the table and sampling the scan there (`render.ts`).  Built in four steps:
 *
 *   1. the base surface: a height field over the tangent plane at the seed whose slopes match the
 *      normals (least squares), so that the grid lies along the sheet;
 *   2. every grid point moved along its normal onto the nearest phase peak, i.e. onto the sheet;
 *   3. from every grid point, a streamline along the normal both ways, on which the phase's peaks
 *      are sheets (whole w) and its troughs gaps (half w);
 *   4. those peaks and troughs labelled consistently across the grid, from the centre outward, each
 *      taking the label of the nearest one on a labelled neighbour — so that a streamline that saw
 *      one sheet more or less than its neighbours does not tear the layer.
 *
 * Tried against Scrolls 1 and 3 before it was written here: where the sheets are distinct, the
 * whole layers land on papyrus 85–100% of the time; where they are crumpled, it fails.
 */

import type { LasagnaField, Vec3 } from "./field";

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

// Moves `p` along `n` onto the nearest phase peak within half a sheet spacing either way.
export function snapToSheet(field: LasagnaField, p: Vec3, n: Vec3) {
  const span = 0.5 / (field.density(p[0], p[1], p[2]) || 1 / 40);
  let best: { t: number; phase: number } | undefined;
  let before = -1, previous = -1;
  for (let t = -span - 1; t <= span + 1; t += 0.5) {
    const q = add(p, mul(n, t));
    const value = field.phase(q[0], q[1], q[2]);
    if (previous > before && previous >= value && previous > 0.5) {
      const at = t - 0.5;
      if (Math.abs(at) <= span && (best === undefined || Math.abs(at) < Math.abs(best.t))) {
        best = { t: at, phase: previous };
      }
    }
    before = previous;
    previous = value;
  }
  return best === undefined ? undefined : add(p, mul(n, best.t));
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
  // P[((k + K·per)·nv + i)·nu + j]·3: the position of grid point (i, j) on layer k / per; NaN where
  // it could not be followed that far.
  P: Float32Array;
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

// Moves every base point along its normal onto the nearest phase peak, the moves smoothed (median of
// 5×5) so that neighbours do not land on different sheets.
function snapBase(field: LasagnaField, grid: PatchGrid, X: Float64Array, N: Float64Array) {
  const { nu, nv } = grid;
  const offsets = new Float64Array(nu * nv);
  for (let k = 0; k < nu * nv; k++) {
    const p: Vec3 = [X[k * 3], X[k * 3 + 1], X[k * 3 + 2]];
    const n: Vec3 = [N[k * 3], N[k * 3 + 1], N[k * 3 + 2]];
    const span = 0.4 / (field.density(p[0], p[1], p[2]) || 1 / 40) / 1.5;
    let best = 0, bestValue = -1;
    for (let t = -span; t <= span; t += 0.5) {
      const value = field.phase(p[0] + n[0] * t, p[1] + n[1] * t, p[2] + n[2] * t) - 0.002 * Math.abs(t);
      if (value > bestValue) (bestValue = value), (best = t);
    }
    offsets[k] = best;
  }
  const around: number[] = [];
  for (let i = 0; i < nv; i++)
    for (let j = 0; j < nu; j++) {
      around.length = 0;
      for (let di = -2; di <= 2; di++)
        for (let dj = -2; dj <= 2; dj++) {
          const a = i + di, b = j + dj;
          if (a >= 0 && b >= 0 && a < nv && b < nu) around.push(offsets[a * nu + b]);
        }
      around.sort((p, q) => p - q);
      const t = around[around.length >> 1], k = (i * nu + j) * 3;
      X[k] += N[k] * t;
      X[k + 1] += N[k + 1] * t;
      X[k + 2] += N[k + 2] * t;
    }
}

interface Anchor {
  // Index on the line, and the sheet count the line itself found there (whole = sheet, half = gap).
  i: number;
  raw: number;
  label?: number;
}

interface Line {
  n: number;
  xs: Float64Array;
  wg: Float64Array;
  anchors: Anchor[];
  normal: Vec3;
}

const DS = 2; // streamline step, voxels
const HYSTERESIS = 0.1; // phase change that makes a peak or a trough
const MATCH = 0.3; // of a sheet spacing: how close two neighbours' anchors must be to be the same

// A streamline through base point `x0`, both ways as far as the density counts `sheets`, with the
// peaks and troughs of its phase.
function traceLine(field: LasagnaField, x0: Vec3, normal: Vec3, sheets: number): Line {
  const a = field.trace(x0, normal, -1, sheets, DS);
  const b = field.trace(x0, normal, 1, sheets, DS);
  const n = a.n + 1 + b.n, i0 = a.n;
  const xs = new Float64Array(n * 3), wg = new Float64Array(n), ph = new Float64Array(n);
  for (let i = 0; i < a.n; i++) {
    const j = a.n - 1 - i;
    xs.set(a.xs.subarray(j * 3, j * 3 + 3), i * 3);
    wg[i] = a.wg[j];
    ph[i] = a.ph[j];
  }
  xs.set(x0, i0 * 3);
  ph[i0] = field.phase(x0[0], x0[1], x0[2]);
  xs.set(b.xs.subarray(0, b.n * 3), (i0 + 1) * 3);
  wg.set(b.wg.subarray(0, b.n), i0 + 1);
  ph.set(b.ph.subarray(0, b.n), i0 + 1);
  // The phase smoothed over ±2 voxels, then walked out from the base, which sits on a peak.
  const smooth = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let d = -1; d <= 1; d++) if (i + d >= 0 && i + d < n) (s += ph[i + d]), c++;
    smooth[i] = s / c;
  }
  const anchors: Anchor[] = [{ i: i0, raw: 0 }];
  for (const dir of [1, -1]) {
    let wantPeak = false, extI = i0, extV = smooth[i0], raw = 0;
    for (let i = i0 + dir; i >= 0 && i < n; i += dir) {
      const v = smooth[i];
      const turned = wantPeak ? v < extV - HYSTERESIS : v > extV + HYSTERESIS;
      if (turned) {
        raw += 0.5 * dir;
        anchors.push({ i: extI, raw });
        wantPeak = !wantPeak;
        extV = v;
        extI = i;
      } else if (wantPeak ? v > extV : v < extV) {
        extV = v;
        extI = i;
      }
    }
  }
  anchors.sort((p, q) => p.i - q.i);
  return { n, xs, wg, anchors, normal };
}

/**
 * The patch over `grid` around `seed` (full-resolution voxels, z/y/x), `K` sheets each way, or
 * undefined where there is no sheet to build it on.  w grows in the direction of the normal that
 * agrees with `towards` — away from the scroll's axis, or the way a previous patch went.  The
 * streamlines are followed as far as the density counts `sheets`, which has to allow for it being
 * wrong.
 */
export function buildPatch(
  field: LasagnaField,
  seed: Vec3,
  towards: Vec3,
  grid: PatchGrid,
  K = 3,
  per = 8,
  sheets = (K + 0.5) * 1.6,
): Patch | undefined {
  const n00 = normalAt(field, seed, towards);
  if (n00 === null) return undefined;
  const p0 = snapToSheet(field, seed, n00);
  if (p0 === undefined) return undefined;
  const n0 = normalAt(field, p0, n00);
  if (n0 === null) return undefined;
  const { nu, nv } = grid;
  const { X, N, right, down } = baseSurface(field, p0, n0, grid);
  snapBase(field, grid, X, N);

  const lines: Line[] = [];
  for (let k = 0; k < nu * nv; k++) {
    lines.push(
      traceLine(
        field,
        [X[k * 3], X[k * 3 + 1], X[k * 3 + 2]],
        [N[k * 3], N[k * 3 + 1], N[k * 3 + 2]],
        sheets,
      ),
    );
  }

  // The sheet spacing, from the centre line.
  const centre = ((nv - 1) / 2) * nu + (nu - 1) / 2;
  const gaps = lines[centre].anchors.slice(1).map((a, i) => (a.i - lines[centre].anchors[i].i) * DS);
  gaps.sort((p, q) => p - q);
  const halfSpacing = gaps[gaps.length >> 1] ?? 20;

  // Labels, from the centre outward.
  for (const a of lines[centre].anchors) a.label = a.raw;
  const distance = (k: number) =>
    Math.hypot(Math.floor(k / nu) - (nv - 1) / 2, (k % nu) - (nu - 1) / 2);
  const order = [...Array(nu * nv).keys()].sort((p, q) => distance(p) - distance(q));
  const done = new Uint8Array(nu * nv);
  done[centre] = 1;
  for (const k of order) {
    if (done[k]) continue;
    const i = Math.floor(k / nu), j = k % nu, line = lines[k];
    const neighbours: Line[] = [];
    for (let di = -1; di <= 1; di++)
      for (let dj = -1; dj <= 1; dj++) {
        const a = i + di, b = j + dj;
        if ((di || dj) && a >= 0 && b >= 0 && a < nv && b < nu && done[a * nu + b]) {
          neighbours.push(lines[a * nu + b]);
        }
      }
    const [nz, ny, nx] = line.normal;
    for (const a of line.anchors) {
      const az = line.xs[a.i * 3], ay = line.xs[a.i * 3 + 1], ax = line.xs[a.i * 3 + 2];
      const whole = Number.isInteger(a.raw);
      const votes = new Map<number, number>();
      for (const other of neighbours)
        for (const b of other.anchors) {
          if (b.label === undefined || Number.isInteger(b.label) !== whole) continue;
          const d = Math.abs(
            (az - other.xs[b.i * 3]) * nz + (ay - other.xs[b.i * 3 + 1]) * ny + (ax - other.xs[b.i * 3 + 2]) * nx,
          );
          if (d < MATCH * 2 * halfSpacing) votes.set(b.label, (votes.get(b.label) ?? 0) + 1 / (1 + d));
        }
      let best: number | undefined, bestVotes = 0;
      for (const [label, value] of votes) if (value > bestVotes) (bestVotes = value), (best = label);
      a.label = best;
    }
    // Only labels that increase along the line are kept.
    const kept: Anchor[] = [];
    for (const a of line.anchors) {
      if (a.label === undefined) continue;
      while (kept.length && kept[kept.length - 1].label! >= a.label) kept.pop();
      kept.push(a);
    }
    line.anchors = kept;
    done[k] = 1;
  }

  // w along every line — the density's share between two labelled anchors, the density scaled by
  // the line's own sheet spacing beyond them — and where it crosses each k / per.
  const L = 2 * K * per + 1;
  const P = new Float32Array(L * nu * nv * 3).fill(NaN);
  for (let node = 0; node < nu * nv; node++) {
    const { n, xs, wg, anchors } = lines[node];
    if (anchors.length === 0) continue;
    const w = new Float64Array(n);
    for (let a = 0; a + 1 < anchors.length; a++) {
      const A = anchors[a], B = anchors[a + 1];
      const span = wg[B.i] - wg[A.i] || 1;
      for (let i = A.i; i <= B.i; i++) w[i] = A.label! + ((wg[i] - wg[A.i]) / span) * (B.label! - A.label!);
    }
    const first = anchors[0], last = anchors[anchors.length - 1];
    const scale =
      anchors.length >= 2
        ? Math.max(0.4, Math.min(1.5, (last.label! - first.label!) / (wg[last.i] - wg[first.i] || 1)))
        : 1;
    for (let i = 0; i < first.i; i++) w[i] = first.label! + (wg[i] - wg[first.i]) * scale;
    for (let i = last.i; i < n; i++) w[i] = last.label! + (wg[i] - wg[last.i]) * scale;
    for (let i = 1; i < n; i++) {
      const w0 = w[i - 1], w1 = w[i];
      if (w1 <= w0) continue;
      for (let k = Math.max(Math.ceil(w0 * per), -K * per); k / per <= w1 && k <= K * per; k++) {
        const t = (k / per - w0) / (w1 - w0);
        const o = ((K * per + k) * nu * nv + node) * 3;
        for (let c = 0; c < 3; c++) P[o + c] = xs[(i - 1) * 3 + c] + (xs[i * 3 + c] - xs[(i - 1) * 3 + c]) * t;
      }
    }
  }
  return { ...grid, K, per, P, right, down, normal: n0 };
}

/**
 * The grid of layer `w` (sheets from the base, fractional): positions (flat z, y, x, row by row),
 * NaN where the table has nothing, linear between the table's layers.
 */
export function layerGrid(patch: Patch, w: number) {
  const { nu, nv, K, per, P } = patch;
  const count = nu * nv;
  const out = new Float32Array(count * 3).fill(NaN);
  const at = Math.min(Math.max((w + K) * per, 0), 2 * K * per);
  const k0 = Math.min(Math.floor(at), 2 * K * per - 1), t = at - k0;
  for (let node = 0; node < count; node++) {
    const a = (k0 * count + node) * 3, b = ((k0 + 1) * count + node) * 3;
    for (let c = 0; c < 3; c++) {
      out[node * 3 + c] = t === 0 ? P[a + c] : t === 1 ? P[b + c] : P[a + c] * (1 - t) + P[b + c] * t;
    }
  }
  return out;
}

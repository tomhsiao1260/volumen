/**
 * @file Which pages of the atlas a view needs, worked out on this thread from its geometry.
 *
 * A page is a 64³ block of one scale (`atlas.ts`).  A cross-section is a rectangle in the scroll —
 * a middle, an axis to the right and an axis down, all in full-resolution voxels — and the pages it
 * cuts are a matter of arithmetic: every page whose box the rectangle passes through.  Knowing them
 * here, before a frame is drawn, is what lets a chunk that has just arrived go up as pages in the
 * same tick, and a view that has just moved have its pages before its first frame — rather than a
 * frame being drawn with holes, the holes read back from the GPU, and the pages written a frame or
 * two later (`sample.ts`, `scan.ts`), which is the path left for geometry only a worker knows.
 *
 * Nothing here assumes the rectangle is aligned with the axes.  An oblique cut, or a face of a box
 * somebody has pulled out of shape, is the same arithmetic — which is the point, since a board of
 * many such boxes is where this is going.
 */
import { PAGE } from "#src/gpu/atlas.js";
import type { Looking, Scale } from "#src/gpu/slice.js";

/** A page's place in its scale's grid of pages, packed as the atlas keys it: x, then y, then z. */
export const packPage = (x: number, y: number, z: number) => x | (y << 10) | (z << 20);
export const unpackPage = (packed: number): [number, number, number] => [
  packed & 1023,
  (packed >> 10) & 1023,
  (packed >> 20) & 1023,
];

/** What a view needs of one scale: the pages it cuts now, and the ones a step along its normal reaches. */
export interface Order {
  cut: number[];
  near: number[];
}

const HALF = PAGE / 2;

/**
 * The pages of `scale` that the rectangle `looking` cuts, `halfWidth` and `halfHeight` pixels either
 * side of its middle, nearest the middle first — and, in `near`, the pages one page further along
 * the rectangle's normal either way, which is where a hand stepping through the slices is going.
 */
export function pagesCut(
  looking: Looking,
  halfWidth: number,
  halfHeight: number,
  scale: Scale,
): Order {
  const { factor, upper } = scale;
  // The rectangle in this scale's own texels, where a page is `PAGE` of them (see `sample.ts`).
  const c = looking.at.map((v) => (v + 0.5) / factor - 0.5);
  const r = looking.right.map((v) => (v * halfWidth) / factor);
  const d = looking.down.map((v) => (v * halfHeight) / factor);
  const er = Math.hypot(r[0], r[1], r[2]);
  const ed = Math.hypot(d[0], d[1], d[2]);
  const order: Order = { cut: [], near: [] };
  if (er === 0 || ed === 0) return order;
  const ur = r.map((v) => v / er);
  const ud = d.map((v) => v / ed);
  // The normal, and how far a page's box reaches along each of the three directions: half its side
  // times the direction's taxicab length, which is the box's extent projected onto a line.
  let n = [ur[1] * ud[2] - ur[2] * ud[1], ur[2] * ud[0] - ur[0] * ud[2], ur[0] * ud[1] - ur[1] * ud[0]];
  const ln = Math.hypot(n[0], n[1], n[2]);
  if (ln === 0) return order;
  n = n.map((v) => v / ln);
  const reach = (u: number[]) => HALF * (Math.abs(u[0]) + Math.abs(u[1]) + Math.abs(u[2]));
  const reachN = reach(n), reachR = reach(ur), reachD = reach(ud);

  // Pages worth looking at: those under the rectangle's box, widened by a page along the normal.
  const lo = [0, 0, 0], hi = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const span = Math.abs(r[i]) + Math.abs(d[i]) + PAGE * Math.abs(n[i]) + 1e-3;
    const last = Math.floor((upper[i] - 1) / PAGE);
    lo[i] = Math.max(0, Math.floor((c[i] - span) / PAGE));
    hi[i] = Math.min(last, Math.floor((c[i] + span) / PAGE));
  }
  const cut: { packed: number; away: number }[] = [];
  const near: { packed: number; away: number }[] = [];
  for (let z = lo[2]; z <= hi[2]; z++)
    for (let y = lo[1]; y <= hi[1]; y++)
      for (let x = lo[0]; x <= hi[0]; x++) {
        // The page's middle, relative to the rectangle's.
        const dx = x * PAGE + HALF - 0.5 - c[0];
        const dy = y * PAGE + HALF - 0.5 - c[1];
        const dz = z * PAGE + HALF - 0.5 - c[2];
        // Within the rectangle's own extent, give or take the page's reach.
        if (Math.abs(ur[0] * dx + ur[1] * dy + ur[2] * dz) > er + reachR) continue;
        if (Math.abs(ud[0] * dx + ud[1] * dy + ud[2] * dz) > ed + reachD) continue;
        const along = Math.abs(n[0] * dx + n[1] * dy + n[2] * dz);
        const packed = packPage(x, y, z);
        const away = dx * dx + dy * dy + dz * dz;
        if (along <= reachN + 1e-3) cut.push({ packed, away });
        else if (along <= reachN + PAGE + 1e-3) near.push({ packed, away });
      }
  cut.sort((a, b) => a.away - b.away);
  near.sort((a, b) => a.away - b.away);
  order.cut = cut.map((p) => p.packed);
  order.near = near.map((p) => p.packed);
  return order;
}

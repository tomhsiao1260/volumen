/**
 * @file Where a plane of a piece of sheet falls in the scan: the geometry of the three surface
 * planes, and nothing that draws.
 *
 * The pixels are the card's own business now — it holds the march as a texture and works each one
 * out on the GPU (`gpu/field.ts`, `viewer/render/surface_layer.ts`).  What is left here is what only
 * this side knows: how a pixel maps to a point of the piece, how far across the sheets a cut
 * reaches and how that is spread, and which chunks of the scan a plane lands in.
 *
 * The three planes are the sheet's own, as XY, XZ and YZ are the scan's:
 *
 *   UV  the sheet itself, laid flat: u across it, v down the scroll
 *   UW  across the sheets along u: each sheet a band, straight where the flattening is right
 *   VW  across the sheets along v
 *
 * In UW and VW the sheet the card is on is in the middle, so a correct piece shows its sheets as
 * level bands however the papyrus curves — and the way across them is spread by DISTANCE and not by
 * winding (`acrossSheets`), so that the papyrus is drawn at one scale all the way across.
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
  width: number,
  height: number,
  // Where each equal step across the picture falls, in sheets (`acrossSheets`).
  spread: number[],
  /*
   * Where along the axis a cut does NOT show it is taken, 0 to 1 across the grid.
   *
   * A cut along u is one row of the grid and a cut along v one column, and until there was a way to
   * say which, it was always the middle one: the card could be moved through the stack, which it
   * already shows the whole of, and never along the papyrus, which it cannot show at all.
   */
  pin = 0.5,
) {
  const lastU = patch.nu - 1, lastV = patch.nv - 1;
  const alongU = (c: number) => ((c + 0.5) / width) * lastU;
  const alongV = (r: number) => ((r + 0.5) / height) * lastV;
  const sheetAt = (f: number) => {
    if (spread.length < 2) return w;
    const at = Math.min(spread.length - 1, Math.max(0, f * (spread.length - 1)));
    const i = Math.min(spread.length - 2, Math.floor(at));
    return spread[i] + (at - i) * (spread[i + 1] - spread[i]);
  };
  /*
   * On a cut the sheets always stack DOWNWARDS, whichever way the cut runs along the papyrus.
   *
   * They used to stack downwards on one cut and out to the right on the other, which kept u and v
   * each on the axis they have on the flat card — tidy on paper, and wrong in the hand: the same
   * movement through the stack was an up-and-down pull on one card and a sideways one on the other.
   * The axis through the papyrus is the one a person is travelling along, so it is the one that gets
   * the screen's own direction of travel, on both.
   */
  const acrossRow = (r: number) => sheetAt((r + 0.5) / height);
  if (plane === "uw") return (r: number, c: number) => [acrossRow(r), pin * lastV, alongU(c)];
  if (plane === "vw")
    return (r: number, c: number) => [acrossRow(r), ((c + 0.5) / width) * lastV, pin * lastU];
  return (r: number, c: number) => [w, alongV(r), alongU(c)];
}

// How many steps the across-the-sheets map is held at.  Two a sheet over ten sheets is finer than the
// table it is measured from, and the map between them is smooth.
const ACROSS_STEPS = 64;

/**
 * The whole table walked once, down the middle of the piece: how far through the papyrus each sheet
 * is, from one end of the table to the other.
 *
 * A cut gives every sheet the same width of card, and a sheet is not the same thickness everywhere:
 * the march converges where the papyrus is concave, so measured down the middle of one real piece a
 * half-wrap ran from 8.7 voxels to 31.3, three and a half times over.  Drawn by winding, the thin
 * part is magnified three and a half times against the thick part — one band of the picture pulled
 * wide and smeared while the rest is sharp, which is what this is for.
 *
 * Measured once down the middle of the piece rather than per pixel, so the map is the same for every
 * row of the card: a sheet stays a straight band, and only the spacing between bands changes.
 */
export function acrossWalk(patch: Patch) {
  const gi = (patch.nv - 1) / 2, gj = (patch.nu - 1) / 2;
  const out = new Float64Array(3);
  const sheets: number[] = [], walked: number[] = [];
  let last: number[] | undefined;
  let total = 0;
  for (let k = -patch.K * ACROSS_STEPS; k <= patch.K * ACROSS_STEPS; k++) {
    const sheet = k / ACROSS_STEPS;
    const here = positionAt(patch, sheet, gi, gj, out) ? [out[0], out[1], out[2]] : undefined;
    if (sheets.length > 0)
      // Where the piece has nothing the winding's own step stands in, so the walk keeps going.
      total +=
        here === undefined || last === undefined
          ? 30 / ACROSS_STEPS
          : Math.hypot(here[0] - last[0], here[1] - last[1], here[2] - last[2]);
    if (here !== undefined) last = here;
    sheets.push(sheet);
    walked.push(total);
  }
  return { sheets, walked };
}

/**
 * And the map for one card: where each equal step across the cut falls, in sheets, reaching `wanted`
 * voxels of papyrus either side of the sheet shown.
 *
 * A lookup in the walk and nothing else.  It used to walk the table afresh every time it was asked,
 * which is every frame of a slide and — worse — once for every annotation point the card is asked
 * about: a hundred points came to sixty thousand lookups into the table on every change.
 */
export type Walked = { sheets: number[]; walked: number[] };

// How far through the papyrus a sheet is, in voxels, along the walk.
export function farOf(walk: Walked, sheet: number) {
  const { sheets, walked } = walk;
  const n = sheets.length;
  const at = Math.min(n - 1, Math.max(0, (sheet - sheets[0]) * ACROSS_STEPS));
  const i = Math.min(n - 2, Math.floor(at));
  return walked[i] + (at - i) * (walked[i + 1] - walked[i]);
}

/**
 * And the sheet at a distance along it.
 *
 * Past the ends the walk is carried on at the rate it finished at, rather than held at the last
 * sheet.  Held, the picture would repeat that sheet down the rest of the card — a smeared band
 * exactly where the point is to have none; carried on, those places are off the piece and draw as
 * nothing, which says plainly that the table does not reach that far.
 */
export function sheetOf(walk: Walked, far: number) {
  const { sheets, walked } = walk;
  const n = sheets.length;
  const edge = (lo: number, hi: number) => {
    const run = walked[hi] - walked[lo];
    return sheets[hi] + (run > 0 ? (far - walked[hi]) / run : 0) * (sheets[hi] - sheets[lo]);
  };
  if (far <= walked[0]) return edge(1, 0);
  if (far >= walked[n - 1]) return edge(n - 2, n - 1);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (walked[mid] <= far) lo = mid;
    else hi = mid;
  }
  const run = walked[hi] - walked[lo];
  return sheets[lo] + (run > 0 ? (far - walked[lo]) / run : 0) * (sheets[hi] - sheets[lo]);
}

export function acrossSheets(walk: Walked, w: number, wanted: number) {
  const { sheets, walked } = walk;
  const n = sheets.length;
  if (n < 2) return [w];
  const here = farOf(walk, w);
  const reach = Math.min(wanted, Math.max(here - walked[0], walked[n - 1] - here));
  if (!(reach > 0)) return [w];
  const even: number[] = [];
  for (let t = 0; t <= ACROSS_STEPS; t++)
    even.push(sheetOf(walk, here + ((2 * reach * t) / ACROSS_STEPS - reach)));
  return even;
}

/**
 * How many sheets either side of its own a cut should show, so that it is drawn at the same scale
 * both ways: a square of papyrus as a square, and the grain of it running true.
 *
 * One axis of a cut runs along the sheet, and how much of the scan that covers is decided — it is
 * the piece's own width or height.  The other runs across the sheets, and nothing decides it, so it
 * is decided here: enough wraps that a pixel of it is worth the same as a pixel of the other.  Held
 * under what the table actually holds, so that a cut never asks for a sheet that was never walked;
 * where that bites, the picture is still stretched, and the only cure for that is a deeper table.
 */
export function acrossWanted(patch: Patch, plane: SurfacePlane, width: number, height: number) {
  if (plane === "uv" || !(width > 0) || !(height > 0)) return Infinity;
  // The voxels one pixel of the along-the-sheet axis is worth, and the pixels the other axis has.
  // Both cuts run their own axis across the card and the sheets down it, so both measure the same way.
  const along = (plane === "uw" ? (patch.nu - 1) * patch.hu : (patch.nv - 1) * patch.hv) / width;
  return (height * along) / 2;
}

/**
 * Where a point of a drawn frame sits in the piece — `fx` and `fy` being 0 to 1 across and down it,
 * `w` the sheet the card is on.  It is `mapping` asked about one point instead of every pixel, for
 * turning a place pointed at on the card into a place in the scan.
 */
export function pieceAt(
  patch: Patch,
  plane: SurfacePlane,
  w: number,
  fx: number,
  fy: number,
  // The same map the frame was drawn with, or the answer is about another picture.
  spread: number[],
) {
  const [sheet, gi, gj] = mapping(patch, plane, w, 1, 1, spread)(fy - 0.5, fx - 0.5);
  return { w: sheet, gi, gj };
}

/**
 * A cut of the piece as one picture: the papyrus along the sheet by the distance through it, at a
 * voxel a sample, for the whole of the walk.
 *
 * This is what a cut card shows, and the whole of what it shows.  A cut along u is drawn at the
 * middle row of the grid and a cut along v at the middle column (`mapping`), so neither of them
 * needs a volume — each is one picture, and asking for another sheet only moves the window on it.
 * Three hundred and thirty-eight by four hundred and eighty is a hundred and sixty kilobytes, which
 * is small enough to resample in a moment, hold in the page, and hand to `drawImage` as a source
 * rectangle: a pull is then a picture being panned, which is a thing browsers already do perfectly.
 *
 * The distance axis is uniform in VOXELS, not in windings — the papyrus is not the same thickness
 * everywhere, and a picture uniform in windings would be pre-stretched by exactly the amount
 * `acrossSheets` exists to undo.
 */
/*
 * How many points across the image the chunks are worked out from.  At least as many as the piece has
 * points across it: a coarser net than the piece's own can step over a run of sheet between two of
 * its points, and a pixel drawn from a chunk nobody asked for is drawn from a coarser level for ever,
 * which leaves the card saying it is still loading with nothing left to come.
 */
const LATTICE = 33;
const latticeFor = (patch: Patch) => Math.min(129, Math.max(LATTICE, patch.nu, patch.nv));

/**
 * The chunks of `level` that drawing this plane reads: the bounding box of every cell of a lattice
 * over the image, with a voxel to spare for interpolation.
 */
export function planeChunks(
  patch: Patch,
  plane: SurfacePlane,
  w: number,
  width: number,
  height: number,
  level: ZarrLevel,
  // Where each equal step across the picture falls, in sheets (`acrossSheets`).
  spread: number[],
  // Where along the axis the cut does not show it is taken (`mapping`).
  pin = 0.5,
): Chunk[] {
  const where = mapping(patch, plane, w, width, height, spread, pin);
  const point = new Float64Array(3);
  const lattice = latticeFor(patch);
  const positions = new Float32Array(lattice * lattice * 3).fill(NaN);
  for (let i = 0; i < lattice; i++)
    for (let j = 0; j < lattice; j++) {
      const [sheet, gi, gj] = where(
        (i / (lattice - 1)) * (height - 1),
        (j / (lattice - 1)) * (width - 1),
      );
      if (coverageAt(patch, sheet, gi, gj) > 0 && positionAt(patch, sheet, gi, gj, point)) {
        positions.set(point, (i * lattice + j) * 3);
      }
    }
  const f = level.factor;
  const keys = new Map<string, Chunk>();
  const lo = [0, 0, 0], hi = [0, 0, 0];
  for (let i = 0; i + 1 < lattice; i++)
    for (let j = 0; j + 1 < lattice; j++) {
      lo.fill(Infinity);
      hi.fill(-Infinity);
      // Whichever corners of the cell the piece reaches: a cell beside a hole has some, and the
      // pixels there are drawn like any other, so their chunks are needed like any other.
      let corners = 0;
      for (const k of [i * lattice + j, i * lattice + j + 1, (i + 1) * lattice + j, (i + 1) * lattice + j + 1]) {
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

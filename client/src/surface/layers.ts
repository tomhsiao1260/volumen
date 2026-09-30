/**
 * @file Where each surface card's sheet is, for the slice cards to draw.
 *
 * A surface card shows one sheet of papyrus, and that sheet cuts every slice of the same scan along a
 * curve.  Drawing that curve on the slice cards is the plainest check there is of whether the
 * flattening is right: the line should ride along the papyrus, and turning the wheel should walk it
 * from one sheet to the next.  Where it cuts across the grain instead, the piece is wrong there, and
 * no number says it half as clearly.
 */

import type { PieceSpot } from "./types";

export interface Sheet {
  // The surface card showing it, and the scan it belongs to.
  cardId: string;
  sourceId: string;
  // Which sheet, counted from the one the card was opened on.
  w: number;
  // Points across and down the grid, and their positions (z, y, x each), NaN where the piece has no
  // sheet.
  nu: number;
  nv: number;
  grid: Float32Array;
  // What holds each point of it up: the answer to "why is the line here".
  why: Uint8Array;
  // The way w grows (z, y, x), and how many voxels apart the sheets are: what turns a drag across
  // the line into sheets.
  normal: [number, number, number];
  spacing: number;
}

const sheets = new Map<string, Sheet>();
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) listener();
}

export function setSheet(sheet: Sheet) {
  sheets.set(sheet.cardId, sheet);
  changed();
}

export function forgetSheet(cardId: string) {
  if (sheets.delete(cardId)) changed();
}

// The one a card is showing, for the card itself to ask what holds its wrap up.
export function sheetOf(cardId: string) {
  return sheets.get(cardId);
}

// The sheets shown of one scan, which are the ones a slice card of that scan can draw.
export function sheetsOf(sourceId: string | null) {
  if (sourceId === null) return [];
  return [...sheets.values()].filter((sheet) => sheet.sourceId === sourceId);
}

/*
 * Where each winding point falls on a card's piece: the answers the card asked the worker for, one
 * point at a time.  The card draws from these, and they are kept here too so the question the
 * drawing answers by fading — is every point of this chain on one and the same sheet? — can also be
 * asked in numbers rather than only seen.
 */
const spots = new Map<string, Map<string, PieceSpot>>();

export function setSpots(cardId: string, found: Map<string, PieceSpot>) {
  spots.set(cardId, new Map(found));
}

export function spotsOf(cardId: string) {
  return spots.get(cardId) ?? new Map<string, PieceSpot>();
}

/*
 * And which of them the card last drew.  A point is drawn when it is on the piece, inside the card,
 * and near enough to the sheet the card is turned to; so this list, read at a known sheet, is the
 * answer to "are all of these on this one sheet" in the same terms the eye gets it in.
 */
export interface DrawnDot {
  chain: string;
  point: string;
  x: number;
  y: number;
  // How strongly it was drawn: 1 on the wrap it belongs to, faint elsewhere.  It is what says whether
  // a point is on the wrap being looked at, now that a point off it is shown rather than hidden.
  near: number;
}

const drawn = new Map<string, DrawnDot[]>();

export function setDrawnDots(cardId: string, dots: DrawnDot[]) {
  drawn.set(cardId, dots);
}

export function drawnDotsOf(cardId: string) {
  return drawn.get(cardId) ?? [];
}

export function watchSheets(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Where the sheet crosses the plane `axis` = `value` (axis 0 is z, 1 is y, 2 is x): the crossings of
 * every square of the grid, as segments of two points, each (z, y, x).  Squares with a corner the
 * piece never reached are left out, so a hole in the sheet is a gap in the line.
 */
export function crossSection(sheet: Sheet, axis: number, value: number) {
  const { nu, nv, grid } = sheet;
  const segments: number[][] = [];
  const at = (i: number, j: number) => (i * nu + j) * 3;
  const corner = [0, 0, 0, 0];
  const points: number[][] = [];
  for (let i = 0; i + 1 < nv; i++)
    for (let j = 0; j + 1 < nu; j++) {
      const around = [at(i, j), at(i, j + 1), at(i + 1, j + 1), at(i + 1, j)];
      let whole = true;
      for (let k = 0; k < 4; k++) {
        const o = around[k];
        if (Number.isNaN(grid[o])) whole = false;
        corner[k] = grid[o + axis] - value;
      }
      if (!whole) continue;
      points.length = 0;
      for (let k = 0; k < 4; k++) {
        const a = corner[k], b = corner[(k + 1) % 4];
        if ((a > 0 && b > 0) || (a < 0 && b < 0) || (a === 0 && b === 0)) continue;
        const t = a === b ? 0 : a / (a - b);
        const from = around[k], to = around[(k + 1) % 4];
        points.push([
          grid[from] + (grid[to] - grid[from]) * t,
          grid[from + 1] + (grid[to + 1] - grid[from + 1]) * t,
          grid[from + 2] + (grid[to + 2] - grid[from + 2]) * t,
        ]);
      }
      // Two crossings is a segment through the square; four is a saddle, drawn as both of its pairs.
      for (let k = 0; k + 1 < points.length; k += 2) {
        segments.push([...points[k], ...points[k + 1]]);
      }
    }
  return segments;
}

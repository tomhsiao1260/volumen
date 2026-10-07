/**
 * @file What the page and the surface worker say to each other (`engine.ts`, `worker.ts`).
 */

import type { Lasagna } from "../api/lasagna";
import type { SurfacePlane } from "./render";

export type { SurfacePlane };

/*
 * The most and the least a cut may show, in sheets either side of its own.
 *
 * How many it actually shows is worked out per card from how big it is drawn (`spanFor` in
 * `render.ts`), so that a square of papyrus comes out square: the across-the-sheet axis of a cut is
 * set by the card's width and the across-the-SHEETS axis by nothing at all, and a fixed number of
 * wraps stretched over the card's height is a picture squeezed in one direction.  Measured on a real
 * board the w axis was magnified 1.6 times against the other, and on a 7.9 µm scroll six times,
 * which is the smear a cut card used to show.
 *
 * The most is what the table holds; the least keeps a cut from showing almost nothing of the stack
 * when the card is small or the wraps are far apart.
 */
export const SPAN_LEAST = 0.6;

/*
 * A winding chain as the worker needs it: where its points are and which wrap each was counted as.
 * The rest of what a chain is — who said it, when, whether it is switched on — stays in the page
 * (`surface/windings.ts`); switched-off chains are simply not sent.
 */
export interface ChainSaid {
  id: string;
  rev: number;
  kind: "same" | "step";
  /*
   * (z, y, x) in the order they were placed, and — on a relative winding — the chain each point was
   * put down on, when it was put on a place already there.  Two chains named by one relative winding
   * have been said to be different wraps, and that is the only thing said that the fit cannot work out
   * for itself.
   */
  points: { at: [number, number, number]; turn: number | null; of?: { chain: string; point: string } }[];
}

/*
 * A place on a piece: which sheet, and how far along u and across v it is, 0 to 1 — fractions of the
 * piece rather than grid points, so that a card can put it in its frame knowing only its own plane
 * and the sheet it is on.
 */
export interface PieceSpot {
  w: number;
  fu: number;
  fv: number;
}

// Opens a surface card: finds the sheet at `seed` and builds the piece of it the card covers, with
// the sheets either side of it.
export interface OpenRequest {
  type: "open";
  id: string;
  // The scan's source, how big one of its voxels is in µm, and its Lasagna prediction where it has
  // one — most scans have none (see `normals`).
  scanSourceId: string;
  micron: number;
  lasagna: Lasagna | null;
  // What a person has said about the sheets of this scan, which the fit is told before it guesses.
  chains: ChainSaid[];
  /*
   * Where the sheet normal comes from.
   *
   * The prediction where there is one — but of the twenty-three scans in the app only five have a
   * Lasagna prediction, and every one of those is a 2.4 µm scan, so every 1.1 µm scan, every 7.9 to
   * 9.4 µm one and every overview has none.  Worked out from the scan itself there is no such limit,
   * and the page says which it wants rather than the worker guessing.
   */
  normals: "prediction" | "scan";
  // Whether a march already walked may be read back from the server (`chart.ts`).  Off with
  // `?charts=no`, which is how the fit is held against itself: the same board drawn both ways has
  // to come out the same, or a chart is not the march it claims to be.
  charts: boolean;
  // Whether the card draws on the GPU (`?gpu=yes`).  While the two paths are held against each
  // other both are built; the CPU one is what every number so far was measured on.
  gpu: boolean;
  // The voxel the card was opened on, in voxels of the full-resolution scan.
  seed: { x: number; y: number; z: number };
  // The sheet to show: sheets from the one at `seed`, fractional, positive outward.
  w: number;
  // Which of the sheet's own planes to draw.
  plane: SurfacePlane;
  // Full-resolution voxels per pixel of the card's layout, how many pixels it is drawn with per one
  // of those, and the size of its data in the pixels it is drawn with.
  zoom: number;
  density: number;
  width: number;
  height: number;
}

/*
 * Asks where a voxel sits on this card's piece — answered with a `place` — or, the other way round,
 * which voxel a point of the card's frame is, `fx` and `fy` being 0 to 1 across and down it.  It is
 * what lets one place pointed at on any card be shown on all the others.
 */
export interface PointRequest {
  type: "point";
  id: string;
  at: [number, number, number];
  /*
   * Said back with the answer.  A card asks about the voxel its group has marked and about every
   * winding point of its scan, and the answers come back one at a time with nothing else to tell
   * them apart — an answer taken for the wrong question moves the card, or the board.
   */
  token?: string;
}

export interface WhereRequest {
  type: "where";
  id: string;
  fx: number;
  fy: number;
  token?: string;
  /*
   * Answer even where the piece has a hole.  Asking where a point of the card is, to put a winding
   * annotation there, is most worth doing exactly where the fit has gone wrong — and where the fit
   * has gone wrong is where it says it has no papyrus.
   */
  loose?: boolean;
}

// Shows another sheet, or another of the sheet's planes.
export interface ShowRequest {
  type: "show";
  id: string;
  w: number;
  plane: SurfacePlane;
}

export interface CloseRequest {
  type: "close";
  id: string;
}

export type SurfaceRequest = OpenRequest | ShowRequest | PointRequest | WhereRequest | CloseRequest;

export type SurfaceStatus = "loading" | "ready" | "no-sheet" | "too-coarse" | "failed";

// What the card found, which is all it shows for now: nothing is drawn yet.
/**
 * A cut of the piece as one picture, sent to the card and kept there (`flatCut` in `render.ts`).
 *
 * This is the whole of what a cut card shows, for every sheet it could show: asking for another one
 * only moves the window on it.  So a hand pulling the sheets is answered on the page's own thread by
 * a `drawImage` with a different source rectangle — no worker, no scan, and no drawing at all.
 */
export interface CutEvent {
  type: "cut";
  id: string;
  plane: SurfacePlane;
  // RGBA, `wide` × `tall`, a voxel of the scan a sample.
  pixels: ArrayBuffer;
  wide: number;
  tall: number;
  // Whether more of it is still being filled in.
  loading: boolean;
  // The distance along the walk at the first and last sample across the sheets, in voxels, and how
  // much papyrus the other axis covers.
  lo: number;
  hi: number;
  along: number;
  // The walk itself, in the card's own windings: enough to turn a winding into a distance and back.
  sheets: ArrayBuffer;
  walked: ArrayBuffer;
}

/**
 * The march, packed for the GPU, and the chunks the sheet lands in.
 *
 * Sent once a piece is built and again when a winding is taken in — never per frame.  After this the
 * card draws every sheet of the piece from what it holds, and the worker is out of the loop
 * entirely: moving the window is two uniforms (`viewer`'s `SurfaceView.show`).
 */
export interface FieldEvent {
  type: "field";
  id: string;
  nu: number;
  nv: number;
  layers: number;
  per: number;
  K: number;
  // The sheet the piece was based on, in the card's own windings: the card counts from where it was
  // opened and the field counts from the piece's own base, and this is the difference.
  baseW: number;
  data: ArrayBuffer;
  walk: ArrayBuffer;
  lo: number;
  hi: number;
  // How much papyrus the grid covers each way, in voxels: what a pixel of the card is worth, and so
  // how much of the stack a cut shows.
  alongU: number;
  alongV: number;
  // The walk the other way round — the distance at each winding — so the card can turn the sheet it
  // is asked for into the place the window starts at, without asking anybody.
  sheets: ArrayBuffer;
  walked: ArrayBuffer;
}

/** Which chunks of which scale the sheet lands in, worked out where the march lives. */
export interface WantEvent {
  type: "want";
  id: string;
  wanted: { level: number; factor: number; chunks: ArrayBuffer }[];
}

export interface SurfaceFacts {
  // How far apart the wraps came out, and the grid the piece was built on.
  spacing: number;
  across: number;
  down: number;
  step: number;
  // How long it took to read the prediction, and to walk the piece out of it.
  read: number;
  built: number;
  // Whether the march was read back from a chart instead of walked (`chart.ts`).
  kept: boolean;
  // How many places the annotations came to once each chain's clicks were joined into a line, and how
  // far one of them reached sideways, in voxels.
  said: number;
  reach: number;
  // Per wrap: how much of it the prediction ran out on, how much of the grid is stretched past the
  // shape it was laid out in, how far apart one wrap and the next are, and the spread of the
  // stretching.  All of it the piece describing itself.
  holes: string;
  torn: string;
  apart: string;
  stretch: string;
}

export interface StatusEvent {
  type: "status";
  id: string;
  status: SurfaceStatus;
  facts?: SurfaceFacts;
  message?: string;
}

// The sheet, drawn.  Sent again as finer data arrives.
export interface FrameEvent {
  type: "frame";
  id: string;
  // The sheet and plane drawn; the sheet is the one asked for unless the sheets could not be
  // followed that far, which `limited` says.
  w: number;
  plane: SurfacePlane;
  limited: boolean;
  // The card's own size in pixels, which the canvas keeps whatever size a frame arrives at.
  width: number;
  height: number;
  /*
   * How much smaller the frame was drawn than the card: 1 is the whole thing, more is the quick look
   * that is sent while a hand is still moving.  It is scaled up smoothly rather than drawn in blocks,
   * which reads as an out-of-focus picture instead of a pattern of its own.
   */
  scale: number;
  // RGBA, ⌈width / scale⌉ × ⌈height / scale⌉; transparent where there is no sheet or nothing yet.
  pixels: ArrayBuffer;
  // Whether finer data is still on its way.
  loading: boolean;
  // How long the drawing took.
  drew: number;
  // And where each equal step across a cut falls, in sheets: the picture is spread by distance and
  // not by winding (`acrossSheets`), so the card must use the same map to put a place in the frame.
  spread: number[];
}

/**
 * Where the sheet being shown is, for the slice cards to draw its line.  Sent when the card moves to
 * another sheet, not with every frame: the picture is redrawn as chunks arrive, but the sheet itself
 * does not move while they do.
 */
export interface SheetEvent {
  type: "sheet";
  id: string;
  w: number;
  // Points across and down the grid, and their positions (z, y, x each), NaN where there is no sheet.
  nu: number;
  nv: number;
  grid: ArrayBuffer;
  // The way w grows, and how many voxels a sheet is from the next.
  normal: [number, number, number];
  spacing: number;
}

/*
 * The answer to a `point`: where the voxel is on the piece, or null when the piece does not reach
 * it — the place is somewhere else in the scroll, and this card has nothing to show for it.  The
 * answer to a `where` carries the voxel instead.
 */
export interface PlaceEvent {
  type: "place";
  id: string;
  spot: PieceSpot | null;
  voxel: [number, number, number] | null;
  token?: string;
}

export type SurfaceEvent = StatusEvent | FrameEvent | SheetEvent | PlaceEvent
  | CutEvent
  | FieldEvent
  | WantEvent;

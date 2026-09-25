/**
 * @file What the page and the surface worker say to each other (`engine.ts`, `worker.ts`).
 */

import type { Lasagna } from "../api/lasagna";
import type { SurfacePlane } from "./render";

export type { SurfacePlane };

/*
 * How many sheets either side of its own a cut shows.  Here rather than in the worker because the
 * card works out where a marked place falls in its frame, which is the same mapping the other way
 * round (`mapping` in `render.ts`).
 */
export const SPAN = 2;

/*
 * A winding chain as the worker needs it: where its points are and which wrap each was counted as.
 * The rest of what a chain is — who said it, when, whether it is switched on — stays in the page
 * (`surface/windings.ts`); switched-off chains are simply not sent.
 */
export interface ChainSaid {
  id: string;
  rev: number;
  kind: "same" | "step";
  // (z, y, x) and the wrap, in the order they were placed.
  points: { at: [number, number, number]; turn: number | null }[];
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
  // The scan's source, and its Lasagna prediction.
  scanSourceId: string;
  lasagna: Lasagna;
  // What a person has said about the sheets of this scan, which the fit is told before it guesses.
  chains: ChainSaid[];
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
}

export interface WhereRequest {
  type: "where";
  id: string;
  fx: number;
  fy: number;
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

export type SurfaceStatus = "loading" | "ready" | "no-sheet" | "failed";

// What the card found, which is all it shows for now: nothing is drawn yet.
export interface SurfaceFacts {
  // How far the fit ended from the prediction's bands, in voxels: mean and worst over the sheets.
  off: string;
  // How many places a person held the sheets to, and how far the worst of them ended up.
  said: string;
  // Sheets are this many voxels apart at the seed, as the prediction has it.
  spacing: number;
  // Points across and down the piece of sheet, and their spacing in voxels.
  across: number;
  down: number;
  step: number;
  // Reading the prediction, and building the sheet, in milliseconds.
  read: number;
  built: number;
  // How the fit came out, for a debug page: per sheet, how much of it is missing and how much is
  // torn; how far apart the sheets ended up; and how far the grid's edges are from the length they
  // were laid out with, which is the card's scale.
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
  // The way w grows, and how many voxels a sheet is from the next: enough to turn a drag across the
  // line on a slice card into sheets.
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
}

export type SurfaceEvent = StatusEvent | FrameEvent | SheetEvent | PlaceEvent;

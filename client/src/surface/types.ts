/**
 * @file What the page and the surface worker say to each other (`engine.ts`, `worker.ts`).
 */

import type { Lasagna } from "../api/lasagna";
import type { SurfacePlane } from "./render";

export type { SurfacePlane };

// Opens a surface card: finds the sheet at `seed` and builds the piece of it the card covers, with
// the sheets either side of it.
export interface OpenRequest {
  type: "open";
  id: string;
  // The scan's source, and its Lasagna prediction.
  scanSourceId: string;
  lasagna: Lasagna;
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

export type SurfaceRequest = OpenRequest | ShowRequest | CloseRequest;

export type SurfaceStatus = "loading" | "ready" | "no-sheet" | "failed";

// What the card found, which is all it shows for now: nothing is drawn yet.
export interface SurfaceFacts {
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
  width: number;
  height: number;
  // RGBA, width × height; transparent where the sheet could not be followed or nothing has arrived.
  pixels: ArrayBuffer;
  // Whether finer data is still on its way.
  loading: boolean;
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

export type SurfaceEvent = StatusEvent | FrameEvent | SheetEvent;

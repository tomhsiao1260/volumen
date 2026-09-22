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
  // Full-resolution voxels per pixel, and the size of the card's data in pixels.
  zoom: number;
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

export type SurfaceEvent = StatusEvent | FrameEvent;

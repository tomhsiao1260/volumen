/**
 * @file The page's side of the surface worker: one worker for all surface cards, so that they share
 * the chunks they read.  A card opens itself with its parameters and hears back how it is doing.
 */

import { forgetSheet, setSheet } from "./layers";
import type { OpenRequest, SurfaceEvent, SurfacePlane, SurfaceRequest } from "./types";

class SurfaceEngine {
  private worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
  });
  private listeners = new Map<string, (event: SurfaceEvent) => void>();
  // The scan each card is on, which the sheet it shows is drawn on, and the plane it is showing, so
  // that something other than the card itself — a drag on a slice card's line — can ask for a sheet.
  private scans = new Map<string, string>();
  private planes = new Map<string, SurfacePlane>();

  constructor() {
    this.worker.onmessage = (message: MessageEvent<SurfaceEvent>) => {
      const event = message.data;
      if (event.type === "sheet") {
        const sourceId = this.scans.get(event.id);
        if (sourceId !== undefined) {
          setSheet({
            cardId: event.id,
            sourceId,
            w: event.w,
            nu: event.nu,
            nv: event.nv,
            grid: new Float32Array(event.grid),
            normal: event.normal,
            spacing: event.spacing,
          });
        }
        return;
      }
      this.listeners.get(event.id)?.(event);
    };
    this.worker.onerror = (error) => console.error("Surface worker failed:", error);
  }

  private post(request: SurfaceRequest) {
    this.worker.postMessage(request);
  }

  open(request: Omit<OpenRequest, "type">, listener: (event: SurfaceEvent) => void) {
    this.listeners.set(request.id, listener);
    this.scans.set(request.id, request.scanSourceId);
    this.planes.set(request.id, request.plane);
    this.post({ type: "open", ...request });
  }

  show(id: string, w: number, plane: SurfacePlane) {
    this.planes.set(id, plane);
    this.post({ type: "show", id, w, plane });
  }

  // Another sheet of a card, without saying which plane: whatever it is showing.
  showLayer(id: string, w: number) {
    const plane = this.planes.get(id);
    if (plane !== undefined) this.post({ type: "show", id, w, plane });
  }

  close(id: string) {
    this.listeners.delete(id);
    this.scans.delete(id);
    this.planes.delete(id);
    forgetSheet(id);
    this.post({ type: "close", id });
  }
}

let engine: SurfaceEngine | undefined;

// The worker, started when the first surface card opens.
export function surfaceEngine() {
  return (engine ??= new SurfaceEngine());
}

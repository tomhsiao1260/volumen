/**
 * @file The page's side of the surface worker: one worker for all surface cards, so that they share
 * the chunks they read.  A card opens itself with its parameters and hears back how it is doing.
 */

import type { OpenRequest, SurfaceEvent, SurfacePlane, SurfaceRequest } from "./types";

class SurfaceEngine {
  private worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
  });
  private listeners = new Map<string, (event: SurfaceEvent) => void>();

  constructor() {
    this.worker.onmessage = (message: MessageEvent<SurfaceEvent>) => {
      this.listeners.get(message.data.id)?.(message.data);
    };
    this.worker.onerror = (error) => console.error("Surface worker failed:", error);
  }

  private post(request: SurfaceRequest) {
    this.worker.postMessage(request);
  }

  open(request: Omit<OpenRequest, "type">, listener: (event: SurfaceEvent) => void) {
    this.listeners.set(request.id, listener);
    this.post({ type: "open", ...request });
  }

  show(id: string, w: number, plane: SurfacePlane) {
    this.post({ type: "show", id, w, plane });
  }

  close(id: string) {
    this.listeners.delete(id);
    this.post({ type: "close", id });
  }
}

let engine: SurfaceEngine | undefined;

// The worker, started when the first surface card opens.
export function surfaceEngine() {
  return (engine ??= new SurfaceEngine());
}

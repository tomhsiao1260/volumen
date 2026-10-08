/**
 * @file The viewer package: shows zarr volumes in cross-section views.  See `viewer.ts` for how to
 * use it.
 */

export { NavigationGroup, Viewer } from "#src/viewer.js";
export type {
  MissingChunk,
  MissingChunkHandler,
  Point,
  View,
  ViewerOptions,
  ViewOptions,
  ViewOrientation,
  Volume,
  VolumeOptions,
} from "#src/viewer.js";
export type { SurfaceField, SurfaceWindow } from "#src/render/surface_layer.js";
import type { SurfaceField, SurfaceWindow } from "#src/render/surface_layer.js";
export type { SurfaceView, SurfaceWant } from "#src/render/surface_view.js";
import type { SurfaceWant } from "#src/render/surface_view.js";
export type { ZarrStoreSpec } from "#src/datasource/zarr/store.js";
// The renderer being built to replace the one above.
export type { Looking, Scale } from "#src/gpu/slice.js";
export { TELL } from "#src/gpu/surface.js";
export type { Window as FlatWindow } from "#src/gpu/surface.js";
import type { Window as FlatWindow } from "#src/gpu/surface.js";

/**
 * What a card showing papyrus laid flat needs, whichever renderer draws it.
 *
 * Three things are pushed in from the page's own worker, because only it knows them: the march, the
 * window on it, and which chunks the sheet lands in.  Both renderers answer to this, so the page
 * does not know which one it has.
 */
export interface Flat {
  take(field: SurfaceField): void;
  // Two shapes while the two renderers stand side by side: the old one says which of three planes,
  // the new one says an affine window on the flattening, of which those three are special cases.
  show(window: SurfaceWindow | FlatWindow): void;
  want(wanted: SurfaceWant[]): void;
  onSettled: ((settled: boolean) => void) | undefined;
  dispose(): void;
}

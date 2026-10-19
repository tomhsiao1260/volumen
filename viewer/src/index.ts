/**
 * @file The viewer package: shows zarr volumes in cross-section views, and papyrus laid flat, on
 * WebGPU.  See `viewer.ts` for how to use it.
 */

export { NavigationGroup, Viewer } from "#src/viewer.js";
export type {
  Flat,
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
export type { ZarrStoreSpec } from "#src/datasource/zarr/store.js";
export type { Looking, Scale } from "#src/gpu/slice.js";
export type { Cell, Corners } from "#src/gpu/cell.js";
export type { Cells, CellsOptions, Space as CellsSpace } from "#src/gpu/cells.js";
export type { CardView as SceneCard } from "#src/gpu/card.js";
export type { Said as SurfaceField } from "#src/gpu/field.js";
export type { Wanted as SurfaceWant } from "#src/gpu/wanting.js";
export { TELL } from "#src/gpu/surface.js";
export type { Window as FlatWindow } from "#src/gpu/surface.js";

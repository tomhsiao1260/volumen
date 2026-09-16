/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * @file Shared by the main thread and the worker: a panel's projection (`ProjectionParameters`), the
 * chunk grid of a scale in view coordinates (`ChunkLayout`), which scales of a volume to show for
 * the current zoom level (`filterVisibleSources`), and which chunks of a scale intersect the
 * cross-section plane (`forEachPlaneIntersectingVolumetricChunk`).
 */

import type {
  WatchableValueChangeInterface,
  WatchableValueInterface,
} from "#src/state/trackable_value.js";
import { arraysEqual } from "#src/util/array.js";
import type { DataType } from "#src/util/data_type.js";
import type { Disposable } from "#src/util/disposable.js";
import {
  isAABBIntersectingPlane,
  kOneVec,
  mat4,
  transformVectorByMat4,
  vec3,
} from "#src/util/geom.js";
import { kEmptyFloat32Vec } from "#src/util/vector.js";
import { SharedObject } from "#src/worker/worker_rpc.js";

const tempMat4 = mat4.create();

export const PROJECTION_PARAMETERS_RPC_ID = "SharedProjectionParameters";
export const PROJECTION_PARAMETERS_CHANGED_RPC_METHOD_ID =
  "SharedProjectionParameters.changed";

// The size of a panel, in screen pixels.
export class RenderViewport {
  width = 0;
  height = 0;
  /**
   * Screen pixels per pixel of the panel's own layout, above 1 when a CSS transform on an ancestor
   * magnifies the panel (a board of panels that zooms).  The panel then shows the same data in more
   * pixels rather than more data, so the zoom of its navigation state is divided by this.
   */
  pixelScale = 1;
}

export function renderViewportsEqual(a: RenderViewport, b: RenderViewport) {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.pixelScale === b.pixelScale
  );
}

/**
 * A panel's viewport and camera: `invViewMatrix` places the view (in screen pixels, centered on the
 * panel) in voxel coordinates, and `projectionMat` maps it to clip coordinates.  The worker receives
 * a copy to choose chunks.
 */
export class ProjectionParameters extends RenderViewport {
  // Position of the center of the view, in voxels; empty until the volume has loaded.
  globalPosition: Float32Array = kEmptyFloat32Vec;

  // Transform from view coordinates to clip coordinates.
  projectionMat: mat4 = mat4.create();

  // Transform from voxel coordinates to view coordinates.
  viewMatrix: mat4 = mat4.create();

  // Inverse of `viewMatrix`.
  invViewMatrix: mat4 = mat4.create();

  // Transform from voxel coordinates to clip coordinates: `projectionMat * viewMatrix`.
  viewProjectionMat: mat4 = mat4.create();

  // Normal of the cross-section plane, in voxel coordinates.
  viewportNormalInGlobalCoordinates = vec3.create();

  centerDataPosition = vec3.create();

  // Size of a screen pixel, in voxels of the full-resolution scale.
  pixelSize = 0;
}

export function projectionParametersEqual(
  a: ProjectionParameters,
  b: ProjectionParameters,
) {
  return (
    renderViewportsEqual(a, b) &&
    arraysEqual(a.globalPosition, b.globalPosition) &&
    arraysEqual(a.projectionMat, b.projectionMat) &&
    arraysEqual(a.viewMatrix, b.viewMatrix)
  );
}

/**
 * Regular grid of chunks: every chunk has size `size` in chunk coordinates, and `transform` maps
 * chunk coordinates to global voxel coordinates.
 */
export class ChunkLayout {
  // Size of a chunk, in chunk coordinates.
  size: vec3;

  // Chunk coordinates (voxels of this scale) to global voxel coordinates, and back.
  transform: mat4;
  invTransform: mat4;

  // Size of one voxel of this scale in global voxels, which decides the zoom levels at which the
  // scale is shown (see `filterVisibleSources`).  Exact only for transforms that scale and permute
  // the axes, which is what a multiscale zarr volume has.
  effectiveVoxelSize: vec3;

  constructor(size: vec3, transform: mat4) {
    this.size = vec3.clone(size);
    this.transform = mat4.clone(transform);
    const invTransform = mat4.create();
    if (mat4.invert(invTransform, transform) === null) {
      throw new Error("Transform is singular");
    }
    this.invTransform = invTransform;
    this.effectiveVoxelSize = this.localSpatialVectorToGlobal(
      vec3.create(),
      /*baseVoxelSize=*/ kOneVec,
    );
  }

  toObject() {
    return {
      size: this.size,
      transform: this.transform,
    };
  }

  static fromObject(msg: any) {
    return new ChunkLayout(msg.size, msg.transform);
  }

  globalToLocalSpatial(out: vec3, globalSpatial: vec3): vec3 {
    return vec3.transformMat4(out, globalSpatial, this.invTransform);
  }

  localSpatialVectorToGlobal(out: vec3, localVector: vec3): vec3 {
    return transformVectorByMat4(out, localVector, this.transform);
  }
}

/**
 * One scale of a volume, together with how its chunk grid sits in the view.  The bounds of the grid
 * and the voxel size are not repeated here: they come from `source.spec` and `chunkLayout`, which
 * both threads have.
 */
export interface TransformedSource<
  Source extends SliceViewChunkSource = SliceViewChunkSource,
> {
  source: Source;

  chunkLayout: ChunkLayout;

  // While `forEachPlaneIntersectingVolumetricChunk` calls its callback, the position of the chunk in
  // the chunk grid.
  curPositionInChunks: Float32Array;
}

function visibleSourcesInvalidated(
  oldValue: ProjectionParameters,
  newValue: ProjectionParameters,
) {
  if (oldValue.pixelSize !== newValue.pixelSize) return true;
  const { viewMatrix: oldViewMatrix } = oldValue;
  const { viewMatrix: newViewMatrix } = newValue;
  for (let i = 0; i < 12; ++i) {
    if (oldViewMatrix[i] !== newViewMatrix[i]) return true;
  }
  return false;
}

/**
 * What both sides of a cross-section view keep: the scales of the volume placed in the view, and
 * the scales currently shown.
 */
export class SliceViewBase<
  Source extends SliceViewChunkSource = SliceViewChunkSource,
> extends SharedObject {
  // One transformed source per scale, finest first; empty until the volume has loaded.
  sources: TransformedSource<Source>[] = [];
  // Scales to draw and to load, ordered from finest to coarsest.
  visibleSources: TransformedSource<Source>[] = [];
  // Preferred voxel size of the shown scales, in screen pixels; set together with `sources`.
  renderScaleTarget: WatchableValueInterface<number> | undefined;
  visibleSourcesStale = true;

  constructor(
    public projectionParameters: WatchableValueChangeInterface<ProjectionParameters>,
  ) {
    super();
    this.registerDisposer(
      projectionParameters.changed.add((oldValue, newValue) => {
        if (visibleSourcesInvalidated(oldValue, newValue)) {
          this.invalidateVisibleSources();
        }
        this.invalidateVisibleChunks();
      }),
    );
  }

  invalidateVisibleSources() {
    this.visibleSourcesStale = true;
  }

  invalidateVisibleChunks() {}

  // Chooses the scales to show for the current pixel size (see `filterVisibleSources`).
  updateVisibleSources() {
    if (!this.visibleSourcesStale) {
      return;
    }
    this.visibleSourcesStale = false;
    const { sources, visibleSources, renderScaleTarget } = this;
    visibleSources.length = 0;
    if (sources.length === 0 || renderScaleTarget === undefined) {
      return;
    }
    for (const source of filterVisibleSources(
      this.projectionParameters.value.pixelSize,
      renderScaleTarget.value,
      sources,
    )) {
      visibleSources.push(source);
    }
    // `filterVisibleSources` yields the coarsest scale first; list the finest first.
    visibleSources.reverse();
  }
}

/**
 * The chunk grid of one scale, in its chunk space (x, y, z voxels): chunks of `chunkDataSize` voxels
 * covering `[lowerVoxelBound, upperVoxelBound)`.
 */
export interface VolumeChunkSpecification {
  rank: number;
  // Size of a chunk, in voxels.
  chunkDataSize: Uint32Array;
  // All chunks are in the range [lowerChunkBound, upperChunkBound), in chunks.
  lowerChunkBound: Float32Array;
  upperChunkBound: Float32Array;
  lowerVoxelBound: Float32Array;
  upperVoxelBound: Float32Array;
  dataType: DataType;
  // Value of the voxels of a chunk that is missing from the store.
  fillValue: number;
}

// Returns the grid of chunks of `chunkDataSize` voxels covering `[0, upperVoxelBound)`.
export function makeVolumeChunkSpecification(options: {
  rank: number;
  dataType: DataType;
  chunkDataSize: Uint32Array;
  upperVoxelBound: Float32Array;
  fillValue: number;
}): VolumeChunkSpecification {
  const { rank, dataType, chunkDataSize, upperVoxelBound, fillValue } = options;
  const lowerVoxelBound = new Float32Array(rank);
  const lowerChunkBound = new Float32Array(rank);
  const upperChunkBound = new Float32Array(rank);
  for (let i = 0; i < rank; ++i) {
    lowerChunkBound[i] = Math.floor(lowerVoxelBound[i] / chunkDataSize[i]);
    upperChunkBound[i] = Math.floor(
      (upperVoxelBound[i] - 1) / chunkDataSize[i] + 1,
    );
  }
  return {
    rank,
    chunkDataSize,
    lowerChunkBound,
    upperChunkBound,
    lowerVoxelBound,
    upperVoxelBound,
    dataType,
    fillValue,
  };
}

/**
 * Yields the scales to draw, from coarsest to finest: starts at the coarsest scale and keeps adding
 * finer scales while they get closer to the on-screen pixel size.  Finer scales are drawn on top,
 * and coarser ones fill in wherever finer chunks are not loaded yet.
 */
export function* filterVisibleSources<T extends TransformedSource<any>>(
  pixelSize: number,
  renderScaleTarget: number,
  sources: readonly T[],
): Iterable<T> {
  // Increase pixel size by a small margin.
  pixelSize *= 1.1;
  // The voxel size of the finest scale is the base voxel size.
  const smallestVoxelSize = sources[0].chunkLayout.effectiveVoxelSize;

  // Whether a finer scale than one with `voxelSize` is worth looking for.
  const canImproveOnVoxelSize = (voxelSize: vec3) => {
    const targetSize = pixelSize * renderScaleTarget;
    for (let i = 0; i < 3; ++i) {
      const size = voxelSize[i];
      // If size <= pixelSize, no need for improvement.
      // If size === smallestVoxelSize, also no need for improvement.
      if (size > targetSize && size > 1.01 * smallestVoxelSize[i]) {
        return true;
      }
    }
    return false;
  };

  const improvesOnPrevVoxelSize = (voxelSize: vec3, prevVoxelSize: vec3) => {
    const targetSize = pixelSize * renderScaleTarget;
    for (let i = 0; i < 3; ++i) {
      const size = voxelSize[i];
      const prevSize = prevVoxelSize[i];
      if (
        Math.abs(targetSize - size) < Math.abs(targetSize - prevSize) &&
        size < 1.01 * prevSize
      ) {
        return true;
      }
    }
    return false;
  };
  let scaleIndex = sources.length - 1;
  let prevVoxelSize: vec3 | undefined;
  while (true) {
    const transformedSource = sources[scaleIndex];
    const { effectiveVoxelSize } = transformedSource.chunkLayout;
    if (
      prevVoxelSize !== undefined &&
      !improvesOnPrevVoxelSize(effectiveVoxelSize, prevVoxelSize)
    ) {
      break;
    }
    yield transformedSource;

    if (scaleIndex === 0 || !canImproveOnVoxelSize(effectiveVoxelSize)) {
      break;
    }
    prevVoxelSize = effectiveVoxelSize;
    --scaleIndex;
  }
}

// What both threads' chunk sources (`VolumeChunkSource` in `frontend.ts` and `backend.ts`) have.
export interface SliceViewChunkSource extends Disposable {
  spec: VolumeChunkSpecification;
}

export const SLICEVIEW_RPC_ID = "SliceView";
export const SLICEVIEW_RENDERLAYER_RPC_ID = "sliceview/RenderLayer";
// Sends the render layer and its sources from a view to the view's worker counterpart.
export const SLICEVIEW_SET_LAYER_RPC_ID = "SliceView.setLayer";

const tempVisibleVolumetricChunkLower = new Float32Array(3);
const tempVisibleVolumetricChunkUpper = new Float32Array(3);
const tempVisibleVolumetricModelViewProjection = mat4.create();
const tempVisibleVolumetricClippingPlanes = new Float32Array(24);

// Recursively splits the chunk range `[lower, upper)` in half along its longest dimension, pruning
// halves that `predicate` rejects, and calls `callback` for each single chunk that remains.
function forEachVolumetricChunkWithinFrustrum(
  clippingPlanes: Float32Array,
  transformedSource: TransformedSource<any>,
  callback: (positionInChunks: vec3, clippingPlanes: Float32Array) => void,
  predicate: (
    xLower: number,
    yLower: number,
    zLower: number,
    xUpper: number,
    yUpper: number,
    zUpper: number,
    clippingPlanes: Float32Array,
  ) => boolean,
) {
  const lower = tempVisibleVolumetricChunkLower;
  const upper = tempVisibleVolumetricChunkUpper;
  const { lowerChunkBound, upperChunkBound } = transformedSource.source.spec;
  for (let i = 0; i < 3; ++i) {
    lower[i] = Math.max(lower[i], lowerChunkBound[i]);
    upper[i] = Math.min(upper[i], upperChunkBound[i]);
  }
  const { curPositionInChunks } = transformedSource;

  function recurse() {
    if (
      !predicate(
        lower[0],
        lower[1],
        lower[2],
        upper[0],
        upper[1],
        upper[2],
        clippingPlanes,
      )
    ) {
      return;
    }

    let splitDim = 0;
    let splitSize = Math.max(0, upper[0] - lower[0]);
    let volume = splitSize;
    for (let i = 1; i < 3; ++i) {
      const size = Math.max(0, upper[i] - lower[i]);
      volume *= size;
      if (size > splitSize) {
        splitSize = size;
        splitDim = i;
      }
    }
    if (volume === 0) return;
    if (volume === 1) {
      curPositionInChunks.set(lower);
      callback(lower as vec3, clippingPlanes);
      return;
    }
    const prevLower = lower[splitDim];
    const prevUpper = upper[splitDim];
    const splitPoint = Math.floor(0.5 * (prevLower + prevUpper));
    upper[splitDim] = splitPoint;
    recurse();
    upper[splitDim] = prevUpper;
    lower[splitDim] = splitPoint;
    recurse();
    lower[splitDim] = prevLower;
  }
  recurse();
}

/**
 * Calls `callback` for each chunk of `transformedSource` intersected by the cross-section plane
 * within the viewport.  `transformedSource.curPositionInChunks` holds the chunk position during the
 * call.
 */
export function forEachPlaneIntersectingVolumetricChunk(
  projectionParameters: ProjectionParameters,
  transformedSource: TransformedSource<any>,
  callback: (positionInChunks: vec3) => void,
) {
  const { chunkLayout } = transformedSource;
  const { size: chunkSize } = chunkLayout;
  const modelViewProjection = mat4.multiply(
    tempVisibleVolumetricModelViewProjection,
    projectionParameters.viewProjectionMat,
    chunkLayout.transform,
  );
  for (let i = 0; i < 3; ++i) {
    const s = chunkSize[i];
    for (let j = 0; j < 4; ++j) {
      modelViewProjection[4 * i + j] *= s;
    }
  }

  const invModelViewProjection = tempMat4;
  mat4.invert(invModelViewProjection, modelViewProjection);
  const lower = tempVisibleVolumetricChunkLower;
  const upper = tempVisibleVolumetricChunkUpper;
  const { upperChunkBound } = transformedSource.source.spec;
  const BIAS_EPSILON = 1e-4;
  const BOUND_EPSILON = 1e-3;
  for (let i = 0; i < 3; ++i) {
    // Bias towards the higher coordinate if the center is very close to a chunk boundary.
    const c = invModelViewProjection[12 + i] + BIAS_EPSILON / chunkSize[i];
    const xCoeff = Math.abs(invModelViewProjection[i]);
    const yCoeff = Math.abs(invModelViewProjection[4 + i]);
    const bound = upperChunkBound[i];
    let lowerValue = c - xCoeff - yCoeff;
    if (lowerValue >= bound && lowerValue < bound + BOUND_EPSILON) {
      // The lower edge of the viewport landed a hair past the last chunk, which would leave the
      // range empty.  Keep showing the last chunk instead of going blank at the far face of the
      // volume.
      lowerValue = bound - 1;
    } else {
      lowerValue = Math.floor(lowerValue);
    }
    lower[i] = lowerValue;
    upper[i] = Math.floor(c + xCoeff + yCoeff + 1);
  }

  const clippingPlanes = tempVisibleVolumetricClippingPlanes;
  for (let i = 0; i < 3; ++i) {
    const xCoeff = modelViewProjection[4 * i];
    const yCoeff = modelViewProjection[4 * i + 1];
    const zCoeff = modelViewProjection[4 * i + 2];
    clippingPlanes[i] = xCoeff;
    clippingPlanes[4 + i] = -xCoeff;
    clippingPlanes[8 + i] = +yCoeff;
    clippingPlanes[12 + i] = -yCoeff;
    clippingPlanes[16 + i] = +zCoeff;
    clippingPlanes[20 + i] = -zCoeff;
  }
  {
    const i = 3;
    const xCoeff = modelViewProjection[4 * i];
    const yCoeff = modelViewProjection[4 * i + 1];
    const zCoeff = modelViewProjection[4 * i + 2];
    clippingPlanes[i] = 1 + xCoeff;
    clippingPlanes[4 + i] = 1 - xCoeff;
    clippingPlanes[8 + i] = 1 + yCoeff;
    clippingPlanes[12 + i] = 1 - yCoeff;
    clippingPlanes[16 + i] = zCoeff;
    clippingPlanes[20 + i] = -zCoeff;
  }
  forEachVolumetricChunkWithinFrustrum(
    clippingPlanes,
    transformedSource,
    callback,
    isAABBIntersectingPlane,
  );
}

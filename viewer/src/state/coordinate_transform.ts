/** @license Copyright 2019 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * @file The viewer's coordinate space: the bounds of the volume in (z, y, x) voxel coordinates of the
 * full-resolution scale, and rounding a coordinate to a voxel center within them.
 */

import { WatchableValue } from "#src/state/trackable_value.js";

export interface CoordinateSpaceBounds {
  lowerBounds: Float64Array;
  upperBounds: Float64Array;
  // For each dimension, whether voxel centers are at integer (otherwise half-integer) coordinates.
  voxelCenterAtIntegerCoordinates: boolean[];
}

export interface CoordinateSpace {
  // `false` until the volume has loaded.
  readonly valid: boolean;
  readonly bounds: CoordinateSpaceBounds;
}

const emptyInvalidCoordinateSpace: CoordinateSpace = {
  valid: false,
  bounds: {
    lowerBounds: new Float64Array(0),
    upperBounds: new Float64Array(0),
    voxelCenterAtIntegerCoordinates: [],
  },
};

export class TrackableCoordinateSpace extends WatchableValue<CoordinateSpace> {
  constructor() {
    super(emptyInvalidCoordinateSpace);
  }
}

const INTEGER_BOUNDS_EPSILON = 1e-3;

/**
 * Returns the coordinate space spanning `[lowerBounds, upperBounds]` in each dimension.  Bounds that
 * are both within 0.001 of an integer, or both within 0.001 of a half-integer, are snapped to it.
 * Voxel centers are at integer coordinates when the bounds are half-integers: with the half-voxel
 * offset of OME-Zarr, a volume of shape `n` spans `[-0.5, n - 0.5]`.
 */
export function makeCoordinateSpace(
  lowerBounds: ArrayLike<number>,
  upperBounds: ArrayLike<number>,
): CoordinateSpace {
  const rank = lowerBounds.length;
  const bounds: CoordinateSpaceBounds = {
    lowerBounds: new Float64Array(rank),
    upperBounds: new Float64Array(rank),
    voxelCenterAtIntegerCoordinates: new Array<boolean>(rank),
  };
  for (let i = 0; i < rank; ++i) {
    let lower = lowerBounds[i];
    let upper = upperBounds[i];
    const nearInteger = (x: number) =>
      Math.abs(x - Math.round(x)) < INTEGER_BOUNDS_EPSILON;
    const nearHalfInteger = (x: number) =>
      Math.abs(x - Math.floor(x) - 0.5) < INTEGER_BOUNDS_EPSILON;
    let halfInteger = false;
    if (nearInteger(lower) && nearInteger(upper)) {
      lower = Math.round(lower);
      upper = Math.round(upper);
    } else if (nearHalfInteger(lower) && nearHalfInteger(upper)) {
      lower = Math.floor(lower) + 0.5;
      upper = Math.floor(upper) + 0.5;
      halfInteger = true;
    }
    bounds.lowerBounds[i] = lower;
    bounds.upperBounds[i] = upper;
    bounds.voxelCenterAtIntegerCoordinates[i] = halfInteger;
  }
  return { valid: true, bounds };
}

/**
 * Clamps `coordinate` along dimension `dim` to `[lower, upper - 1]`, then rounds it to the nearest
 * voxel center.
 */
export function clampAndRoundToVoxelCenter(
  bounds: CoordinateSpaceBounds,
  dim: number,
  coordinate: number,
): number {
  coordinate = Math.min(coordinate, bounds.upperBounds[dim] - 1);
  coordinate = Math.max(coordinate, bounds.lowerBounds[dim]);
  return bounds.voxelCenterAtIntegerCoordinates[dim]
    ? Math.round(coordinate)
    : Math.floor(coordinate) + 0.5;
}

/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * @file Where a view looks: a position and a zoom, which views may share (see `NavigationGroup` in
 * `viewer.ts`), and the orientation of each view.
 */

import type { CoordinateSpace } from "#src/state/coordinate_transform.js";
import { clampAndRoundToVoxelCenter } from "#src/state/coordinate_transform.js";
import type { WatchableValueInterface } from "#src/state/trackable_value.js";
import type { Owned } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import type { quat } from "#src/util/geom.js";
import { mat4, vec3 } from "#src/util/geom.js";
import { NullarySignal } from "#src/util/signal.js";

const tempVec3 = vec3.create();

/**
 * A position in the viewer's (z, y, x) voxel coordinates.  It starts at the center of the volume, as
 * soon as the coordinate space is valid (the volume has loaded).
 */
export class Position extends RefCounted {
  readonly value = new Float32Array(3);
  changed = new NullarySignal();

  constructor(
    public coordinateSpace: WatchableValueInterface<CoordinateSpace>,
  ) {
    super();
    this.registerDisposer(
      coordinateSpace.changed.add(() => {
        this.handleCoordinateSpaceChanged();
      }),
    );
    // A position made for a volume that has already loaded gets no change to react to, and would
    // otherwise stay at the origin, which is a corner of the volume.
    this.handleCoordinateSpaceChanged();
  }

  get valid() {
    return this.coordinateSpace.value.valid;
  }

  private handleCoordinateSpaceChanged() {
    const coordinateSpace = this.coordinateSpace.value;
    if (!coordinateSpace.valid) return;
    const { bounds } = coordinateSpace;
    const { lowerBounds, upperBounds } = bounds;
    for (let i = 0; i < 3; ++i) {
      // The center of the volume, moved to the nearest voxel center, so that each view shows a
      // single layer of voxels rather than the boundary between two.
      this.value[i] = clampAndRoundToVoxelCenter(
        bounds,
        i,
        (lowerBounds[i] + upperBounds[i]) / 2,
      );
    }
    this.changed.dispatch();
  }
}

// Size of a screen pixel, in voxels.
export class TrackableZoom extends RefCounted {
  readonly changed = new NullarySignal();
  private value_ = 1;

  get value() {
    return this.value_;
  }

  set value(value: number) {
    if (Object.is(value, this.value_)) {
      return;
    }
    this.value_ = value;
    this.changed.dispatch();
  }
}

export class NavigationState extends RefCounted {
  changed = new NullarySignal();

  constructor(
    public position: Owned<Position>,
    public zoomFactor: Owned<TrackableZoom>,
    // Rotation from view axes to the viewer's (z, y, x) axes.
    public orientation: quat,
  ) {
    super();
    this.registerDisposer(position);
    this.registerDisposer(zoomFactor);
    this.registerDisposer(position.changed.add(this.changed.dispatch));
    this.registerDisposer(zoomFactor.changed.add(this.changed.dispatch));
  }

  get valid() {
    return this.position.valid && !Number.isNaN(this.zoomFactor.value);
  }

  zoomBy(factor: number) {
    this.zoomFactor.value *= factor;
  }

  /**
   * Sets `mat` to the transform from view coordinates (in screen pixels) to voxel coordinates.
   * `pixelScale` above 1 means the view is magnified on screen (see `RenderViewport`), so a screen
   * pixel covers fewer voxels.
   */
  toMat4(mat: mat4, pixelScale = 1) {
    mat4.fromQuat(mat, this.orientation);
    const { value } = this.position;
    const scale = this.zoomFactor.value / pixelScale;
    for (let i = 0; i < 3; ++i) {
      mat[i] *= scale;
      mat[4 + i] *= scale;
      mat[8 + i] *= scale;
      mat[12 + i] = value[i] || 0;
    }
  }

  // Calls `update` with a copy of the position, which then becomes the new position.
  updateDisplayPosition(update: (pos: vec3) => void) {
    const { value } = this.position;
    vec3.copy(tempVec3, value);
    update(tempVec3);
    value.set(tempVec3);
    this.position.changed.dispatch();
  }

  // Moves by `translation`, given along the view axes, keeping each changed coordinate on a voxel
  // center inside the volume.
  translateVoxelsRelative(translation: vec3) {
    if (!this.valid) {
      return;
    }
    const delta = vec3.transformQuat(tempVec3, translation, this.orientation);
    const { value } = this.position;
    const { bounds } = this.position.coordinateSpace.value;
    for (let i = 0; i < 3; ++i) {
      if (delta[i] === 0) continue;
      value[i] = clampAndRoundToVoxelCenter(bounds, i, value[i] + delta[i]);
    }
    this.position.changed.dispatch();
  }
}

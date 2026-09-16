/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * @file The viewer: zarr volumes shown in any number of cross-section views.
 *
 *   const viewer = new Viewer({ container });
 *   const volume = viewer.addVolume(store);
 *   const navigation = new NavigationGroup(volume);
 *   const view = viewer.addView(element, { volume, orientation: "xy", navigation });
 *   await volume.loaded;
 *   navigation.setPosition({ x: 100, y: 200, z: 300 });
 *   navigation.onViewChanged(() => console.log(navigation.position, navigation.zoom));
 *   viewer.onPointerMove((point, view) => console.log(point));
 *   view.dispose();
 *
 * Each view draws into a canvas of its own inside its element, which must lie inside `container`, so
 * views can be laid out with any CSS, moved, resized, stacked and clipped.  A view that is moved
 * without being resized has to be reported with `invalidateBounds`, and a CSS transform that
 * magnifies a view shows the same data larger rather than more data.
 *
 * A view shows one volume for its whole life and looks through one `NavigationGroup`: views sharing
 * a group show the same place and move together.
 *
 * Points are in voxels of the full-resolution scale, with `x`, `y` and `z` along the last, middle and
 * first dimensions of the zarr array.  Voxel `(i, j, k)` is centered on `{ x: i, y: j, z: k }` and
 * extends half a voxel around it, so rounding a point gives the voxel that contains it.
 */

import {
  ChunkManager,
  ChunkQueueManager,
} from "#src/chunk_manager/frontend.js";
import { loadZarrVolume } from "#src/datasource/zarr/frontend.js";
import type { ZarrStoreSpec } from "#src/datasource/zarr/store.js";
import { DisplayContext, SliceViewPanel } from "#src/render/panel.js";
import { ImageRenderLayer } from "#src/render/renderlayer.js";
import {
  makeCoordinateSpace,
  TrackableCoordinateSpace,
} from "#src/state/coordinate_transform.js";
import {
  NavigationState,
  Position,
  TrackableZoom,
} from "#src/state/navigation_state.js";
import type { WatchableValueInterface } from "#src/state/trackable_value.js";
import { WatchableValue } from "#src/state/trackable_value.js";
import type { Borrowed } from "#src/util/disposable.js";
import { RefCounted } from "#src/util/disposable.js";
import { mat3, quat, vec3 } from "#src/util/geom.js";
import { Signal } from "#src/util/signal.js";
import { RPC } from "#src/worker/worker_rpc.js";

export interface Point {
  x: number;
  y: number;
  z: number;
}

export interface MissingChunk {
  // Path of the chunk's file within the store, e.g. `0/52/24/18`.
  key: string;
}

/**
 * Called for each chunk whose file is not in the store, at most once per chunk while the volume is
 * open.  Return (or resolve to) `true` once the file has been added to the store, to load the chunk
 * again; otherwise the chunk is shown as empty.
 */
export type MissingChunkHandler = (
  chunk: MissingChunk,
) => boolean | void | Promise<boolean | void>;

/**
 * The plane a view shows, named by the two volume axes on screen.
 */
export type ViewOrientation = "xy" | "xz" | "yz";

// The volume axes, in the viewer's (z, y, x) coordinates.
const axisZ = vec3.fromValues(1, 0, 0);
const axisY = vec3.fromValues(0, 1, 0);
const axisX = vec3.fromValues(0, 0, 1);

/**
 * The rotation of a view that shows `right` to the right and `down` downward.  The direction it
 * looks along follows from those two.
 */
function viewRotation(right: vec3, down: vec3) {
  const into = vec3.cross(vec3.create(), right, down);
  // The view axes are the columns of the rotation, which `mat3` holds one after another.
  const axes = mat3.create();
  for (let i = 0; i < 3; ++i) {
    axes[i] = right[i];
    axes[3 + i] = down[i];
    axes[6 + i] = into[i];
  }
  return quat.fromMat3(quat.create(), axes);
}

/**
 * Rotation of the view for each orientation.  Each axis points the same way wherever it is shown —
 * x to the right, y downward, z to the right or downward — so that views of different planes, and
 * especially views sharing a position, move together rather than against each other.
 */
const viewRotations: Record<ViewOrientation, () => quat> = {
  xy: () => viewRotation(axisX, axisY),
  xz: () => viewRotation(axisX, axisZ),
  yz: () => viewRotation(axisZ, axisY),
};

// Converts the viewer's (z, y, x) coordinates to a point.
function toPoint(coordinates: ArrayLike<number>): Point {
  return { x: coordinates[2], y: coordinates[1], z: coordinates[0] };
}

export interface VolumeOptions {
  // What to do about chunks of this volume missing from the store; by default they are shown empty.
  onMissingChunk?: MissingChunkHandler;
}

/**
 * One zarr volume loaded into a viewer.  Any number of views can show it, and they then share its
 * chunks: one download and one texture per chunk, whatever the layout.  Dispose it once no view
 * shows it any more; loading it again is a fresh download.
 */
export class Volume extends RefCounted {
  // Resolves once the volume has loaded; rejects if it could not be loaded.
  readonly loaded: Promise<void>;
  // The bounds of the volume, in its own (z, y, x) voxel coordinates.  A navigation group takes its
  // coordinates from the volume it is created with.
  readonly coordinateSpace = new TrackableCoordinateSpace();
  // The layer that draws the volume; `undefined` until it has loaded.
  readonly renderLayer = new WatchableValue<ImageRenderLayer | undefined>(
    undefined,
  );

  constructor(
    chunkManager: Borrowed<ChunkManager>,
    renderScaleTarget: WatchableValueInterface<number>,
    store: ZarrStoreSpec,
    onMissingChunk: MissingChunkHandler | undefined,
  ) {
    super();
    this.loaded = this.load(
      chunkManager,
      renderScaleTarget,
      store,
      onMissingChunk,
    );
  }

  // Lowest and highest corner of the volume in voxels, or `undefined` until it has loaded.
  get bounds(): { lower: Point; upper: Point } | undefined {
    const { valid, bounds } = this.coordinateSpace.value;
    if (!valid) return undefined;
    return {
      lower: toPoint(bounds.lowerBounds),
      upper: toPoint(bounds.upperBounds),
    };
  }

  // Reads the metadata of every scale, sets the coordinate space from the volume bounds and creates
  // the render layer that draws it.
  private async load(
    chunkManager: Borrowed<ChunkManager>,
    renderScaleTarget: WatchableValueInterface<number>,
    store: ZarrStoreSpec,
    onMissingChunk: MissingChunkHandler | undefined,
  ) {
    const volume = await loadZarrVolume(chunkManager, store);
    if (this.wasDisposed) return;

    if (onMissingChunk !== undefined) {
      // Keys already passed to `onMissingChunk`.  A chunk reloaded after the handler returned `true`
      // but still missing is not passed again, so a handler cannot cause endless reloads.
      const reportedKeys = new Set<string>();
      volume.missingChunk.add((key, reload) => {
        if (reportedKeys.has(key)) return;
        reportedKeys.add(key);
        Promise.resolve(onMissingChunk({ key })).then(
          (added) => {
            if (added === true) reload();
          },
          (error) => {
            console.error(`Missing chunk handler failed for ${key}:`, error);
          },
        );
      });
    }

    this.coordinateSpace.value = makeCoordinateSpace(
      volume.lowerBounds,
      volume.upperBounds,
    );

    const layer = new ImageRenderLayer(volume, { renderScaleTarget });
    // The views that draw it hold their own references, so it outlives this volume only while one
    // of them is still being disposed.
    this.registerDisposer(layer);
    this.renderLayer.value = layer;
  }
}

/**
 * The position and zoom of one or more views.  Views given the same group show the same place and
 * move together (three views of one volume, or a linked set of cards on a board); a view of its own
 * gets a group of its own.
 *
 * The volume the group is created with fixes its coordinates: the position starts at the center of
 * that volume and is kept on its voxel centers.  A view of another volume may join the group and is
 * then shown at the same (z, y, x) voxel coordinates, which is only meaningful for volumes on the
 * same grid.
 */
export class NavigationGroup extends RefCounted {
  private position_: Position;
  private zoom_ = this.registerDisposer(new TrackableZoom());

  constructor(volume: Borrowed<Volume>) {
    super();
    this.position_ = this.registerDisposer(
      new Position(volume.coordinateSpace),
    );
  }

  // Center of the views, or `undefined` until the volume has loaded.
  get position(): Point | undefined {
    if (!this.position_.valid) return undefined;
    return toPoint(this.position_.value);
  }

  // Centers the views on `point`.  Before the volume has loaded, the position is replaced by the
  // center of the volume once it loads.
  setPosition({ x, y, z }: Point) {
    this.position_.value.set([z, y, x]);
    this.position_.changed.dispatch();
  }

  // Size of a screen pixel, in voxels; larger values show more of the volume.
  get zoom() {
    return this.zoom_.value;
  }

  setZoom(zoom: number) {
    this.zoom_.value = zoom;
  }

  // Calls `callback` whenever the position or zoom changes.  Returns a function that stops the calls.
  onViewChanged(callback: () => void) {
    const removePositionListener = this.position_.changed.add(callback);
    const removeZoomListener = this.zoom_.changed.add(callback);
    return () => {
      removePositionListener();
      removeZoomListener();
    };
  }

  // The state one view looks through: this group's position and zoom, and the view's orientation.
  makeNavigationState(orientation: quat) {
    return new NavigationState(
      this.position_.addRef(),
      this.zoom_.addRef(),
      orientation,
    );
  }
}

// One cross-section view, as returned by `Viewer.addView`.
export type View = SliceViewPanel;

export interface ViewerOptions {
  // Element the viewer draws in.  View elements must lie inside it.
  container: HTMLElement;
}

export interface ViewOptions {
  // The volume the view shows, for its whole life: to show another one, dispose the view and add a
  // new one on the same element, which costs no downloads while the volume holds its chunks.
  volume: Borrowed<Volume>;
  // The plane it shows.
  orientation: ViewOrientation;
  // Where it looks, shared with the other views of the same group.
  navigation: Borrowed<NavigationGroup>;
}

export class Viewer extends RefCounted {
  display: DisplayContext;
  chunkManager: ChunkManager;

  // Decides which chunks to load, and reads and decodes them.
  private worker: Worker;
  // Preferred size of a voxel of the chosen scale, in screen pixels (1: pick the scale whose voxels
  // are closest to one pixel).  It is shared with the worker by each render layer.
  private renderScaleTarget = new WatchableValue(1);
  // The pointer's last position over a view, if it is over one.
  private pointer:
    | { view: View; clientX: number; clientY: number }
    | undefined;
  private pointerMoved = new Signal<
    (point: Point | undefined, view: View) => void
  >();

  constructor({ container }: ViewerOptions) {
    super();
    this.display = this.registerDisposer(new DisplayContext(container));

    this.worker = new Worker(
      new URL("./worker/chunk_worker.bundle.js", import.meta.url),
      { type: "module" },
    );
    const rpc = new RPC(this.worker, true);
    const chunkQueueManager = this.registerDisposer(
      new ChunkQueueManager(rpc, this.display.gl, {
        gpuMemory: { itemLimit: 1e6, sizeLimit: 1e9 },
        systemMemory: { itemLimit: 1e7, sizeLimit: 2e9 },
        download: { itemLimit: 100, sizeLimit: Number.POSITIVE_INFINITY },
      }),
    );
    chunkQueueManager.registerDisposer(() => this.worker.terminate());
    this.chunkManager = this.registerDisposer(
      new ChunkManager(chunkQueueManager),
    );

    this.registerDisposer(
      this.display.updateStarted.add(() => {
        chunkQueueManager.chunkUpdateDeadline = null;
      }),
    );
  }

  /**
   * Starts loading the volume in `store`.  Views of it show nothing until `loaded` resolves.  Two
   * calls with the same store are two volumes, downloading everything twice, so the page keeps one
   * `Volume` per data source.
   */
  addVolume(store: ZarrStoreSpec, { onMissingChunk }: VolumeOptions = {}) {
    return new Volume(
      this.chunkManager,
      this.renderScaleTarget,
      store,
      onMissingChunk,
    );
  }

  /**
   * Shows a volume in `element`, on the plane named by `orientation`.  The view is drawn in a canvas
   * of its own inside the element, which must lie inside the container.  Call `dispose()` on the
   * returned view to remove it; the element itself is left in place.
   */
  addView(
    element: HTMLElement,
    { volume, orientation, navigation }: ViewOptions,
  ): View {
    const view = new SliceViewPanel(
      element,
      navigation.makeNavigationState(viewRotations[orientation]()),
      volume.renderLayer,
      this,
    );

    // While a view moves, chunk uploads to the GPU make way for drawing: after a change of the view
    // they may only start within the next 10 ms, and then wait until a frame has started.  A view
    // moving under a still pointer also changes the point under it.
    view.registerDisposer(
      view.navigationState.changed.add(() => {
        const { chunkQueueManager } = this.chunkManager;
        if (chunkQueueManager.chunkUpdateDeadline === null) {
          chunkQueueManager.chunkUpdateDeadline = Date.now() + 10;
        }
        if (this.pointer?.view === view) this.reportPointer();
      }),
    );

    const onPointerMove = (event: PointerEvent) => {
      this.pointer = { view, clientX: event.clientX, clientY: event.clientY };
      this.reportPointer();
    };
    const onPointerLeave = () => {
      if (this.pointer?.view !== view) return;
      this.pointer = undefined;
      this.pointerMoved.dispatch(undefined, view);
    };
    element.addEventListener("pointermove", onPointerMove);
    element.addEventListener("pointerleave", onPointerLeave);
    view.registerDisposer(() => {
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerleave", onPointerLeave);
      onPointerLeave();
    });
    return view;
  }

  /**
   * Measures the views again on the next frame.  A view is measured when it is added or resized, so
   * moving one — panning a board of views, scrolling the page — has to be reported with this.
   */
  invalidateBounds() {
    this.display.invalidateBounds();
  }

  /**
   * Calls `callback` with the point under the pointer whenever it changes: when the pointer moves
   * over a view, or the view moves under it.  The point is `undefined` when the pointer leaves the
   * view.  Returns a function that stops the calls.
   */
  onPointerMove(callback: (point: Point | undefined, view: View) => void) {
    return this.pointerMoved.add(callback);
  }

  /**
   * Whether every view that is drawn shows its data with nothing still loading (see
   * `SliceView.isReady`).  A viewer with no view is ready, and a view whose volume is still loading
   * is not.
   */
  isReady() {
    for (const panel of this.display.panels) {
      if (panel.visibility.value === Number.NEGATIVE_INFINITY) continue;
      panel.ensureBoundsUpdated();
      if (!panel.sliceView.isReady()) return false;
    }
    return true;
  }

  private reportPointer() {
    const { view, clientX, clientY } = this.pointer!;
    const coordinates = view.pointAt(clientX, clientY);
    this.pointerMoved.dispatch(
      coordinates === undefined ? undefined : toPoint(coordinates),
      view,
    );
  }
}

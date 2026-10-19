/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * @file The viewer: zarr volumes shown in any number of cross-section views, drawn with WebGPU.
 *
 *   const viewer = new Viewer({ container });
 *   if (!(await viewer.ready)) throw new Error("no WebGPU");
 *   const volume = viewer.addVolume(store);
 *   await volume.loaded;
 *   const navigation = new NavigationGroup(volume);
 *   const view = viewer.addView(element, { volume, orientation: "xy", navigation });
 *   navigation.setPosition({ x: 100, y: 200, z: 300 });
 *   navigation.onViewChanged(() => console.log(navigation.position, navigation.zoom));
 *   viewer.onPointerMove((point, view) => console.log(point));
 *   view.dispose();
 *
 * Each view draws into a canvas of its own inside its element, so views can be laid out with any
 * CSS, moved, resized, stacked and clipped.  A view that is moved without being resized has to be
 * reported with `invalidateBounds`, and a CSS transform that magnifies a view shows the same data
 * larger rather than more data.
 *
 * A view shows one volume for its whole life and looks through one `NavigationGroup`: views sharing
 * a group show the same place and move together.
 *
 * Points are in voxels of the full-resolution scale, with `x`, `y` and `z` along the last, middle and
 * first dimensions of the zarr array.  Voxel `(i, j, k)` is centered on `{ x: i, y: j, z: k }` and
 * extends half a voxel around it, so rounding a point gives the voxel that contains it.
 *
 * How it draws: one GPU device, one atlas every resident chunk is paged into, and a TSL function
 * per kind of card (`gpu/`).  The chunk machinery — the asking, the queueing, the dropping, the
 * zarr and the decoding — is Neuroglancer's, reduced, and none of it knows what a GPU is; the only
 * thing it tells the renderer is that a chunk has arrived or has gone (`render/frontend.ts`).
 */

import {
  ChunkManager,
  ChunkQueueManager,
} from "#src/chunk_manager/frontend.js";
import { loadZarrVolume } from "#src/datasource/zarr/frontend.js";
import type { ZarrStoreSpec } from "#src/datasource/zarr/store.js";
import { Atlas, BYTES as ATLAS_BYTES } from "#src/gpu/atlas.js";
import { CrossSection } from "#src/gpu/cross_section.js";
import { Device } from "#src/gpu/device.js";
import { FlatCard } from "#src/gpu/flat.js";
import { scanOf } from "#src/gpu/sample.js";
import { Scan } from "#src/gpu/scan.js";
import type { RenderLayer } from "#src/render/layer.js";
import { VolumeLayer } from "#src/render/layer.js";
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
import { NullarySignal, Signal } from "#src/util/signal.js";
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
 * again; otherwise the chunk is shown as the volume's fill value.
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
  // What to do about chunks of this volume missing from the store; by default they are shown as the
  // volume's fill value.
  onMissingChunk?: MissingChunkHandler;
}

/**
 * One zarr volume loaded into a viewer.  Any number of views can show it, and they then share its
 * chunks: one download and one set of pages per chunk, whatever the layout.  Dispose it once no view
 * shows it any more; loading it again is a fresh download.
 */
export class Volume extends RefCounted {
  // Resolves once the volume has loaded; rejects if it could not be loaded.
  readonly loaded: Promise<void>;
  // The bounds of the volume, in its own (z, y, x) voxel coordinates.  A navigation group takes its
  // coordinates from the volume it is created with.
  readonly coordinateSpace = new TrackableCoordinateSpace();
  // The layer that shows the volume; `undefined` until it has loaded.
  readonly renderLayer = new WatchableValue<RenderLayer | undefined>(
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
  // the layer that shows it.
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

    const layer = new VolumeLayer(volume, { renderScaleTarget });
    // The views that show it hold their own references, so it outlives this volume only while one
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
export type View = CrossSection;

// One card of papyrus laid flat, as returned by `Viewer.addSurfaceView`.
export type Flat = FlatCard;

export interface ViewerOptions {
  // Element the views are laid out in.  Resizing it measures them again.
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

/** The GPU side, once the device has come: one device, one atlas, one lookup, a scan per volume. */
interface Gpu {
  device: Device;
  atlas: Atlas;
  shader: ReturnType<typeof scanOf>;
  scans: Map<Volume, Scan>;
  // What the shader asked for on the last frame read back, for a measurement to look at: how many
  // pages of each source and scale, which pages (the first few), and how many could be answered.
  asked?: { by: Record<string, number>; pages: string[]; put: number };
  /*
   * Whether the last frame drawn is also the last word: nothing it asked for could be answered, and
   * no answer is on its way.  A chunk that has arrived is not yet a page the shader can find — the
   * shader asks for it, the ask is read back, the page is written, and the card is drawn again — so
   * a card whose chunks are all here is still a frame or two from showing them.
   */
  quiet(): boolean;
  // The same, in numbers, for a measurement to look at.
  frames(): { frames: number; answered: { frame: number; put: number } | undefined; reading: boolean };
}

export class Viewer extends RefCounted {
  chunkManager: ChunkManager;
  /**
   * Whether this browser can draw at all: resolves `true` once the GPU device has come, `false`
   * where there is no WebGPU.  Views can only be added after it has resolved `true`.
   */
  readonly ready: Promise<boolean>;

  // Decides which chunks to load, and reads and decodes them.
  private worker: Worker;
  private chunkQueueManager: ChunkQueueManager;
  // Preferred size of a voxel of the chosen scale, in screen pixels (1: pick the scale whose voxels
  // are closest to one pixel).  It is shared with the worker by each layer.
  private renderScaleTarget = new WatchableValue(1);
  // The pointer's last position over a view, if it is over one.
  private pointer:
    | { view: View; clientX: number; clientY: number }
    | undefined;
  private pointerMoved = new Signal<
    (point: Point | undefined, view: View) => void
  >();
  private lost = new NullarySignal();
  private gpu: Gpu | undefined;
  private views = new Set<View>();

  constructor({ container }: ViewerOptions) {
    super();
    this.worker = new Worker(
      new URL("./worker/chunk_worker.bundle.js", import.meta.url),
      { type: "module" },
    );
    const rpc = new RPC(this.worker, true);
    const chunkQueueManager = (this.chunkQueueManager = this.registerDisposer(
      new ChunkQueueManager(rpc, {
        /*
         * The GPU's share is the atlas's own size, because the atlas IS where chunks go.  Two
         * numbers here would be two opinions about how much room there is, and the one that lost
         * would be the card a person was looking at.  Chunks dropped from the GPU are still decoded
         * in system memory, so getting one back is a re-upload rather than a download.
         */
        gpuMemory: { itemLimit: 1e4, sizeLimit: ATLAS_BYTES },
        systemMemory: { itemLimit: 1e5, sizeLimit: 1.5e9 },
        download: { itemLimit: 100, sizeLimit: Number.POSITIVE_INFINITY },
      }),
    ));
    chunkQueueManager.registerDisposer(() => this.worker.terminate());
    this.chunkManager = this.registerDisposer(
      new ChunkManager(chunkQueueManager),
    );
    // The views are laid out in the container, so a container that changed size has views to
    // measure again.
    const resized = new ResizeObserver(() => this.invalidateBounds());
    resized.observe(container);
    this.registerDisposer(() => resized.disconnect());
    this.ready = this.start();
  }

  /** Starts the one GPU device, and everything that hangs off it. */
  private async start(): Promise<boolean> {
    const device = await Device.start();
    if (device === undefined) return false;
    if (this.wasDisposed) {
      device.dispose();
      return false;
    }
    const atlas = this.registerDisposer(new Atlas(device));
    this.registerDisposer(device);
    const scans = new Map<Volume, Scan>();
    // Frames drawn, and the frame the last readback answered for, with how much it could put.
    let frames = 0;
    let answered: { frame: number; put: number } | undefined;
    let reading = false;
    const gpu: Gpu = (this.gpu = {
      device,
      atlas,
      shader: scanOf(atlas),
      scans,
      quiet: () => !reading && answered !== undefined && answered.frame === frames && answered.put === 0,
      frames: () => ({ frames, answered, reading }),
    });
    const { chunkQueueManager } = this;

    // Everything on the device went with it; the page builds a new viewer.
    this.registerDisposer(
      device.lost.add(() => {
        chunkQueueManager.gone = true;
        this.lost.dispatch();
      }),
    );
    // Uploads make way for drawing: a deadline set after a view moved is cleared as the frame starts.
    this.registerDisposer(
      device.frameStarted.add(() => {
        chunkQueueManager.chunkUpdateDeadline = null;
      }),
    );
    /*
     * A chunk arriving is the only thing that changes a card without the card asking.  Pages that
     * could not be written yet are offered again at the same moment, which is the one place both
     * things are known to have happened.
     */
    this.registerDisposer(
      chunkQueueManager.visibleChunksChanged.add(() => device.redraw()),
    );
    /*
     * And after every frame, the pages the shader said it wanted and could not find.
     *
     * Reading a buffer back is not instant, so one is in flight at a time and the rest of the frame
     * does not wait for it: a page asked for now is written a frame or two later, which is the same
     * bargain every chunk arriving already makes.  Whatever was asked is then cleared, so a page
     * that is still missing has to be asked for again — which is what keeps this a statement about
     * the frame just drawn rather than a list that only grows.
     */
    device.drawn = () => {
      frames++;
      if (reading || this.gpu === undefined || device.gone) return;
      reading = true;
      const frame = frames;
      void (async () => {
        try {
          const got = await device.renderer.getArrayBufferAsync(gpu.shader.asked);
          if (this.wasDisposed) return;
          const asked = new Uint32Array(got);
          let put = 0;
          for (const scan of scans.values()) put += scan.answer(asked);
          answered = { frame, put };
          /*
           * What was asked for, kept where a measurement can see it.  A page that is never asked for
           * and a page that is asked for and cannot be answered look the same from outside — the
           * card is blank either way — and telling them apart is most of finding out why.
           */
          const by: Record<string, number> = {};
          const pages: string[] = [];
          for (let i = 0; i + 1 < asked.length; i += 2) {
            const lo = asked[i], hi = asked[i + 1];
            if (lo === 0 && hi === 0) continue;
            const name = `source ${hi & 255} level ${(hi >> 8) & 15}`;
            by[name] = (by[name] ?? 0) + 1;
            if (pages.length < 64) {
              pages.push(`${name} page ${lo & 1023},${(lo >> 10) & 1023},${(lo >> 20) & 1023}`);
            }
          }
          gpu.asked = { by, pages, put };
          atlas.asks.fill(0);
          gpu.shader.asked.needsUpdate = true;
          /*
           * Drawn again if a page went in — and if a frame was drawn while this one was being read.
           * That frame's misses were never read: one readback is in flight at a time, and the zeros
           * going up now overwrite them.  Without another frame they would be lost, and a card would
           * stay on a coarser scale with every chunk it needs resident, waiting for an ask that
           * nobody will make.
           */
          if (put > 0 || frames !== frame) device.redraw();
        } catch (error) {
          if (!device.gone) {
            console.warn("The pages the shader asked for could not be read back:", error);
          }
        } finally {
          reading = false;
        }
      })();
    };
    return true;
  }

  /** What is on the GPU, for a measurement to look at: the atlas's room and what the shader asked. */
  get measured() {
    const { gpu } = this;
    if (gpu === undefined) return undefined;
    return {
      room: gpu.atlas.room,
      kept: gpu.atlas.kept,
      pages: gpu.atlas.listing,
      asked: gpu.asked,
      ...gpu.frames(),
    };
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

  private started(): Gpu {
    const { gpu } = this;
    if (gpu === undefined) {
      throw new Error("The viewer has no GPU device yet: await `viewer.ready` first.");
    }
    return gpu;
  }

  /** This volume's chunks, pointed at the atlas.  One per volume; made on first use. */
  private scanOf(gpu: Gpu, volume: Volume): Scan {
    let scan = gpu.scans.get(volume);
    if (scan === undefined) {
      const layer = volume.renderLayer.value;
      if (layer === undefined) {
        throw new Error("A view can only be added once its volume has loaded: await `volume.loaded`.");
      }
      scan = this.registerDisposer(new Scan(gpu.atlas, gpu.scans.size, layer));
      gpu.scans.set(volume, scan);
    }
    return scan;
  }

  /**
   * Shows a volume in `element`, on the plane named by `orientation`.  The view is drawn in a canvas
   * of its own inside the element.  Call `dispose()` on the returned view to remove it; the element
   * itself is left in place.  Both `ready` and the volume's `loaded` must have resolved.
   */
  addView(
    element: HTMLElement,
    { volume, orientation, navigation }: ViewOptions,
  ): View {
    const gpu = this.started();
    const scan = this.scanOf(gpu, volume);
    const view = new CrossSection(
      element,
      gpu.device,
      this.chunkManager,
      volume.renderLayer,
      navigation.makeNavigationState(viewRotations[orientation]()),
      gpu.shader,
      scan,
    );
    this.views.add(view);
    view.registerDisposer(() => this.views.delete(view));

    // While a view moves, chunk uploads to the GPU make way for drawing: after a change of the view
    // they may only start within the next 10 ms, and then wait until a frame has started.  A view
    // moving under a still pointer also changes the point under it.
    view.registerDisposer(
      view.navigationState.changed.add(() => {
        const { chunkQueueManager } = this;
        if (chunkQueueManager.chunkUpdateDeadline === null) {
          chunkQueueManager.chunkUpdateDeadline = Date.now() + 10;
        }
        view.changed();
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
    this.registerDisposer(view);
    return view;
  }

  /**
   * A card showing a volume not in cross-section but laid flat: papyrus unrolled onto a grid worked
   * out elsewhere.  It draws from the same atlas as every cross-section, so a scan already on the
   * GPU for a slice card is not uploaded a second time.
   *
   * What it is NOT given is a navigation: a flattening has coordinates of its own, and where it is
   * looking is said with `show`.  See `gpu/flat.ts`.
   */
  addSurfaceView(element: HTMLElement, { volume }: { volume: Volume }): Flat {
    const gpu = this.started();
    const scan = this.scanOf(gpu, volume);
    const card = new FlatCard(
      element,
      gpu.device,
      this.chunkManager,
      volume.renderLayer,
      gpu.shader,
      scan,
    );
    this.registerDisposer(card);
    return card;
  }

  /**
   * Calls `callback` if the browser takes the GPU device away, which it does when too much of its
   * memory is asked for, or when the GPU itself goes.  Nothing is drawn after that; the page builds
   * a new viewer.  Returns a function that stops the calls.
   */
  onContextLost(callback: () => void) {
    return this.lost.add(callback);
  }

  /**
   * Measures the views again on the next frame.  A view is measured when it is added or resized, so
   * moving one — panning a board of views, scrolling the page — has to be reported with this.
   */
  invalidateBounds() {
    this.gpu?.device.resized();
  }

  /**
   * Takes the GPU device away, as the browser might.  For tests of what happens then, and nothing
   * else: `onContextLost` fires, and this viewer draws nothing more.
   */
  lose() {
    this.gpu?.device.gpu.destroy();
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
   * Whether every view that is drawn shows its data with nothing still loading: its chunks have
   * arrived (see `SliceView.isReady`) and the last frame found every page it asked for.  A viewer
   * with no view is ready, and a view whose volume is still loading is not.
   */
  isReady() {
    for (const view of this.views) {
      if (view.visibility.value === Number.NEGATIVE_INFINITY) continue;
      view.card.measure();
      if (!view.isReady()) return false;
    }
    return this.views.size === 0 || (this.gpu?.quiet() ?? false);
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

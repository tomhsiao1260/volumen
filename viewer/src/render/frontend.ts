/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

import { debounce } from "es-toolkit";
import { ChunkState } from "#src/chunk_manager/base.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { Chunk, ChunkSource } from "#src/chunk_manager/frontend.js";
import type { NavigationState } from "#src/state/navigation_state.js";
import type {
  WatchableValueChangeInterface,
  WatchableValueInterface,
} from "#src/state/trackable_value.js";
import type {
  TransformedSource,
  VolumeChunkSpecification,
} from "#src/render/base.js";
import {
  ChunkLayout,
  forEachPlaneIntersectingVolumetricChunk,
  PROJECTION_PARAMETERS_CHANGED_RPC_METHOD_ID,
  PROJECTION_PARAMETERS_RPC_ID,
  ProjectionParameters,
  projectionParametersEqual,
  RenderViewport,
  renderViewportsEqual,
  SLICEVIEW_RPC_ID,
  SLICEVIEW_SET_LAYER_RPC_ID,
  SliceViewBase,
} from "#src/render/base.js";
import {
  ChunkFormat,
  FillValueTexture,
  TextureLayout,
} from "#src/render/chunk_format.js";
import type { ImageRenderLayer } from "#src/render/renderlayer.js";
import type { TypedArray } from "#src/util/array.js";
import type { DataType } from "#src/util/data_type.js";
import type { Borrowed, Disposer, Owned } from "#src/util/disposable.js";
import { invokeDisposers, RefCounted } from "#src/util/disposable.js";
import { mat4, vec3 } from "#src/util/geom.js";
import { NullarySignal, Signal } from "#src/util/signal.js";
import { SharedWatchableValue } from "#src/worker/shared_watchable_value.js";
import { kEmptyFloat32Vec } from "#src/util/vector.js";
import type { GL } from "#src/webgl/context.js";
import type { RPC } from "#src/worker/worker_rpc.js";
import {
  registerSharedObjectOwner,
  SharedObject,
} from "#src/worker/worker_rpc.js";

/**
 * Projection parameters of a panel, recomputed (debounced) whenever the navigation state or the
 * viewport changes.  `changed` fires only if the result differs from the previous value.
 */
export class DerivedProjectionParameters
  extends RefCounted
  implements WatchableValueChangeInterface<ProjectionParameters>
{
  // Two objects are swapped on each change, so the previous value stays available to listeners.
  private oldValue_ = new ProjectionParameters();
  private value_ = new ProjectionParameters();
  private renderViewport = new RenderViewport();

  changed = new Signal<
    (oldValue: ProjectionParameters, newValue: ProjectionParameters) => void
  >();
  constructor(
    navigationState: Borrowed<NavigationState>,
    update: (out: ProjectionParameters, navigationState: NavigationState) => void,
  ) {
    super();
    const performUpdate = () => {
      const { oldValue_, value_ } = this;
      Object.assign(oldValue_, this.renderViewport);
      let { globalPosition } = oldValue_;
      // Until the volume has loaded, there is no position yet.  The worker's velocity estimator then
      // starts afresh at the first real position, instead of taking the jump from (0, 0, 0) to the
      // center of the volume for a fast motion.
      const newGlobalPosition = navigationState.position.valid
        ? navigationState.position.value
        : kEmptyFloat32Vec;
      const rank = newGlobalPosition.length;
      if (globalPosition.length !== rank) {
        oldValue_.globalPosition = globalPosition = new Float32Array(rank);
      }
      globalPosition.set(newGlobalPosition);
      update(oldValue_, navigationState);
      if (projectionParametersEqual(oldValue_, value_)) return;
      this.value_ = oldValue_;
      this.oldValue_ = value_;
      this.changed.dispatch(value_, oldValue_);
    };
    const debouncedUpdate = (this.update = this.registerCancellable(
      debounce(performUpdate, 0),
    ));
    this.registerDisposer(navigationState.changed.add(debouncedUpdate));
    performUpdate();
  }

  setViewport(viewport: RenderViewport) {
    if (renderViewportsEqual(viewport, this.renderViewport)) return;
    Object.assign(this.renderViewport, viewport);
    this.update();
  }

  get value() {
    this.update.flush();
    return this.value_;
  }

  readonly update: (() => void) & { flush(): void };
}

/**
 * Sends the projection parameters of a panel to the worker (`SharedProjectionParametersBackend` in
 * `backend.ts`), at most every `updateInterval` milliseconds.
 */
@registerSharedObjectOwner(PROJECTION_PARAMETERS_RPC_ID)
export class SharedProjectionParameters extends SharedObject {
  constructor(
    rpc: RPC,
    public base: WatchableValueChangeInterface<ProjectionParameters>,
    public updateInterval = 10,
  ) {
    super();
    this.initializeCounterpart(rpc, { value: base.value });
    this.registerDisposer(base.changed.add(this.update));
  }

  flush() {
    this.update.flush();
  }

  private update = this.registerCancellable(
    debounce((_oldValue: ProjectionParameters, newValue: ProjectionParameters) => {
      // Note: Because we are using debounce, we cannot rely on `_oldValue`, since
      // `DerivedProjectionParameters` reuses the objects.  A copy is sent, in case the message is
      // queued until the worker is ready.
      this.rpc!.invoke(PROJECTION_PARAMETERS_CHANGED_RPC_METHOD_ID, {
        id: this.rpcId,
        value: { ...newValue },
      });
    }, this.updateInterval),
  );
}

// The message for `deserializeTransformedSource` in `backend.ts`; adds a worker reference to the
// chunk source.
function serializeTransformedSource(
  tsource: TransformedSource<VolumeChunkSource>,
) {
  return {
    source: tsource.source.addCounterpartRef(),
    chunkLayout: tsource.chunkLayout.toObject(),
  };
}

/**
 * Main-thread side of one cross-section view.  Sends the volume's sources and the projection
 * parameters to its worker counterpart (`SliceViewBackend`), which requests the visible chunks,
 * and draws the chunks that have reached the GPU.
 */
@registerSharedObjectOwner(SLICEVIEW_RPC_ID)
export class SliceView extends SliceViewBase<VolumeChunkSource> {
  gl = this.chunkManager.gl;
  // Dispatched when the view needs to be drawn again.
  viewChanged = new NullarySignal();
  // The render layer being drawn, once `renderLayer` has a value.
  layer: ImageRenderLayer | undefined;
  private layerDisposers: Disposer[] = [];

  projectionParameters!: Owned<DerivedProjectionParameters>;

  sharedProjectionParameters: Owned<SharedProjectionParameters>;

  flushBackendProjectionParameters() {
    this.sharedProjectionParameters.flush();
  }

  constructor(
    public chunkManager: ChunkManager,
    // The render layer to draw; `undefined` until the volume has loaded.
    public renderLayer: WatchableValueInterface<ImageRenderLayer | undefined>,
    public navigationState: Owned<NavigationState>,
    // How much the view's chunks are worth loading (see `render/panel.ts`).
    visibility: WatchableValueInterface<number>,
  ) {
    super(
      new DerivedProjectionParameters(navigationState, (out, navigationState) => {
        const { invViewMatrix, centerDataPosition } = out;
        navigationState.toMat4(invViewMatrix, out.pixelScale);
        for (let i = 0; i < 3; ++i) {
          centerDataPosition[i] = invViewMatrix[12 + i];
        }
        const {
          width,
          height,
          projectionMat,
          viewMatrix,
          viewProjectionMat,
          viewportNormalInGlobalCoordinates,
        } = out;
        const relativeDepthRange = 10;
        mat4.ortho(
          projectionMat,
          -width / 2,
          width / 2,
          height / 2,
          -height / 2,
          -relativeDepthRange,
          relativeDepthRange,
        );
        mat4.invert(viewMatrix, invViewMatrix);
        mat4.multiply(viewProjectionMat, projectionMat, viewMatrix);
        for (let i = 0; i < 3; ++i) {
          viewportNormalInGlobalCoordinates[i] = viewMatrix[i * 4 + 2];
        }
        // Size of a screen pixel, in voxels: the length of a view axis in voxel coordinates.
        // `filterVisibleSources` compares it with the voxel size of each scale to choose the
        // scales to draw and to load.
        let pixelSize = 0;
        for (let i = 0; i < 3; ++i) {
          pixelSize += invViewMatrix[i] ** 2;
        }
        out.pixelSize = Math.sqrt(pixelSize);
      }),
    );
    const rpc = this.chunkManager.rpc!;
    const sharedProjectionParameters = (this.sharedProjectionParameters =
      this.registerDisposer(
        new SharedProjectionParameters(rpc, this.projectionParameters),
      ));
    this.initializeCounterpart(rpc, {
      chunkManager: chunkManager.rpcId,
      projectionParameters: sharedProjectionParameters.rpcId,
      visibility: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(rpc, visibility),
      ).rpcId,
    });
    this.registerDisposer(
      renderLayer.changed.add(() => {
        this.updateLayer();
      }),
    );

    this.registerDisposer(
      chunkManager.chunkQueueManager.visibleChunksChanged.add(
        this.viewChanged.dispatch,
      ),
    );
    this.registerDisposer(navigationState);
    this.updateLayer();
  }

  // Releases the render layer and the projection parameters, and stops listening to them.
  disposed() {
    const { layer } = this;
    if (layer !== undefined) {
      invokeDisposers(this.layerDisposers);
      layer.dispose();
      this.layer = undefined;
    }
    // The references `getSources` added, one per scale.  The worker keeps the chunks of a source
    // until it needs the memory, so a view added again on the same volume redraws without
    // downloading anything.
    for (const { source } of this.sources) source.dispose();
    this.sources = [];
    this.projectionParameters.dispose();
    super.disposed();
  }

  forEachVisibleChunk(
    tsource: TransformedSource,
    callback: (key: string) => void,
  ) {
    forEachPlaneIntersectingVolumetricChunk(
      this.projectionParameters.value,
      tsource,
      () => {
        callback(tsource.curPositionInChunks.join());
      },
    );
  }

  private updateLayer = this.registerCancellable(
    debounce(() => {
      this.updateLayerNow();
    }, 0),
  );

  invalidateVisibleSources() {
    super.invalidateVisibleSources();
    this.viewChanged.dispatch();
  }

  // Once the render layer exists, places the volume's scales in the view and sends them to the
  // worker.
  private updateLayerNow() {
    if (this.wasDisposed) {
      return;
    }
    const renderLayer = this.renderLayer.value;
    // A view shows one volume for its whole life, so the first layer it is given is the only one.
    if (renderLayer !== undefined && this.layer === undefined) {
      this.sources = getVolumetricTransformedSources(renderLayer.getSources());
      this.layer = renderLayer.addRef();
      this.renderScaleTarget = renderLayer.renderScaleTarget;
      this.layerDisposers.push(
        renderLayer.renderScaleTarget.changed.add(() =>
          this.invalidateVisibleSources(),
        ),
      );
      const sources = this.sources.map(serializeTransformedSource);
      this.flushBackendProjectionParameters();
      this.rpc!.invoke(SLICEVIEW_SET_LAYER_RPC_ID, {
        id: this.rpcId,
        layerId: renderLayer.rpcId,
        sources,
      });
      this.visibleSourcesStale = true;
    }
    this.viewChanged.dispatch();
  }

  invalidateVisibleChunks() {
    super.invalidateVisibleChunks();
    this.viewChanged.dispatch();
  }

  get valid() {
    return this.navigationState.valid;
  }

  /**
   * Whether the view's volume has loaded and every chunk the view would draw is already on the GPU,
   * i.e. it shows its data with nothing still loading.  Tests and screenshots poll it instead of
   * waiting a fixed time.  A chunk whose download failed never becomes ready.
   */
  isReady() {
    const { width, height } = this.projectionParameters.value;
    if (!this.valid || width === 0 || height === 0) return false;
    this.updateLayer.flush();
    // A view whose volume is still loading has nothing to show yet, and would otherwise count as
    // ready because it has no sources to check.
    if (this.layer === undefined) return false;
    this.updateVisibleSources();
    for (const tsource of this.visibleSources) {
      const { chunks } = tsource.source;
      let ready = true;
      this.forEachVisibleChunk(tsource, (key) => {
        if (chunks.get(key)?.state !== ChunkState.GPU_MEMORY) ready = false;
      });
      if (!ready) return false;
    }
    return true;
  }

  // Draws the slice into the current viewport, which the panel has set to its part of the canvas.
  draw() {
    const projectionParameters = this.projectionParameters.value;
    const { width, height } = projectionParameters;
    if (width === 0 || height === 0) {
      return;
    }
    this.updateLayer.flush();
    this.updateVisibleSources();

    const { gl } = this;
    // Pixels where no chunk is drawn are gray.
    gl.clearColor(0.5, 0.5, 0.5, 1);
    gl.clear(WebGL2RenderingContext.COLOR_BUFFER_BIT);
    const { layer } = this;
    if (layer !== undefined) {
      // The depth buffer keeps coarser scales from being drawn over finer ones (see
      // `renderlayer.ts`).
      gl.enable(WebGL2RenderingContext.DEPTH_TEST);
      gl.depthFunc(WebGL2RenderingContext.LESS);
      gl.clearDepth(1);
      gl.clear(WebGL2RenderingContext.DEPTH_BUFFER_BIT);
      gl.disable(WebGL2RenderingContext.BLEND);
      layer.draw({ sliceView: this, projectionParameters });
    }
    gl.disable(WebGL2RenderingContext.DEPTH_TEST);
  }
}

// One scale of the volume: its chunk source, and the homogeneous transform ((rank + 1) squared,
// column-major) from its chunk space (x, y, z voxels of the scale) to the viewer's coordinates.
export interface SliceViewSingleResolutionSource {
  chunkSource: VolumeChunkSource;
  chunkToMultiscaleTransform: Float32Array;
}

// Places every scale's chunk grid in the view.  Chunk dimension `i` is shown along view dimension
// `i`, so the chunk layout is the only thing each scale needs.
export function getVolumetricTransformedSources(
  scales: SliceViewSingleResolutionSource[],
): TransformedSource<VolumeChunkSource>[] {
  const rank = 3;

  const getTransformedSource = (
    singleResolutionSource: SliceViewSingleResolutionSource,
  ): TransformedSource<VolumeChunkSource> => {
    const { chunkSource: source, chunkToMultiscaleTransform } =
      singleResolutionSource;
    const { spec } = source;
    // Chunk-to-view transform: the first three rows of `chunkToMultiscaleTransform` (4x4,
    // column-major), with (0, 0, 0, 1) as the last row.
    const chunkToViewTransform = mat4.create();
    for (let col = 0; col < 4; ++col) {
      for (let row = 0; row < 3; ++row) {
        chunkToViewTransform[col * 4 + row] =
          chunkToMultiscaleTransform[col * 4 + row];
      }
    }
    // Size of a chunk in the chunk coordinate space, i.e. in voxels of this scale.
    const chunkSize = vec3.create();
    for (let i = 0; i < rank; ++i) {
      chunkSize[i] = spec.chunkDataSize[i];
    }
    return {
      source,
      chunkLayout: new ChunkLayout(chunkSize, chunkToViewTransform),
      curPositionInChunks: new Float32Array(rank),
    };
  };
  return scales.map(getTransformedSource);
}

/**
 * Main-thread side of the chunk source of one scale.  Its chunks arrive from the worker in
 * `Chunk.update` messages (see `chunk_manager/frontend.ts`) and are uploaded to textures of
 * `chunkFormat`.
 */
export class VolumeChunkSource extends ChunkSource {
  chunks!: Map<string, VolumeChunk>;
  spec: VolumeChunkSpecification;
  chunkFormat: ChunkFormat;
  // Layout of the texture of each chunk of this source.
  textureLayout: TextureLayout;
  fillValueTexture: FillValueTexture;

  constructor(
    chunkManager: ChunkManager,
    options: { spec: VolumeChunkSpecification },
  ) {
    super(chunkManager, options);
    this.spec = options.spec;
    const { gl } = chunkManager.chunkQueueManager;
    const { chunkDataSize, dataType, fillValue } = this.spec;
    this.chunkFormat = this.registerDisposer(ChunkFormat.get(gl, dataType));
    this.textureLayout = new TextureLayout(gl, chunkDataSize);
    this.fillValueTexture = this.registerDisposer(
      FillValueTexture.get(
        gl,
        this.chunkFormat,
        chunkDataSize.length,
        fillValue,
      ),
    );
  }

  initializeCounterpart(rpc: RPC, options: any) {
    options.spec = this.spec;
    super.initializeCounterpart(rpc, options);
  }

  getChunk(x: any): VolumeChunk {
    const chunk = new VolumeChunk(this, x);
    if (chunk.data === null) {
      chunk.texture = this.fillValueTexture.texture;
      chunk.textureLayout = this.fillValueTexture.textureLayout;
    }
    return chunk;
  }
}

// Main-thread copy of a volume chunk: its data lives in a texture while the chunk is in GPU memory.
// A chunk with no data uses the source's fill value texture instead.
export class VolumeChunk extends Chunk {
  source!: VolumeChunkSource;
  // Position of the chunk in the chunk grid.
  chunkGridPosition: vec3;
  data: TypedArray | null;
  texture: WebGLTexture | null = null;
  textureLayout: TextureLayout | null = null;

  constructor(source: VolumeChunkSource, x: any) {
    super(source);
    this.chunkGridPosition = x.chunkGridPosition;
    this.data = x.data;
  }

  copyToGPU(gl: GL) {
    super.copyToGPU(gl);
    if (this.data === null) return;
    const { chunkFormat, textureLayout } = this.source;
    const texture = (this.texture = gl.createTexture());
    gl.bindTexture(WebGL2RenderingContext.TEXTURE_3D, texture);
    this.textureLayout = textureLayout;
    chunkFormat.setTextureData(gl, textureLayout, this.data);
    gl.bindTexture(WebGL2RenderingContext.TEXTURE_3D, null);
  }

  freeGPUMemory(gl: GL) {
    super.freeGPUMemory(gl);
    if (this.data === null) return;
    gl.deleteTexture(this.texture);
    this.texture = null;
    this.textureLayout = null;
  }
}

// A volume stored at several scales (see `datasource/zarr/frontend.ts`).
export abstract class MultiscaleVolumeChunkSource {
  abstract dataType: DataType;

  // Returns the chunk source of each scale, finest first.
  abstract getSources(): SliceViewSingleResolutionSource[];

  constructor(public chunkManager: Borrowed<ChunkManager>) {}
}

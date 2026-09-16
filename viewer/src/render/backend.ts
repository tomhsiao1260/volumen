/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

import type { ChunkManager } from "#src/chunk_manager/backend.js";
import {
  Chunk,
  ChunkSource,
  getNextMarkGeneration,
} from "#src/chunk_manager/backend.js";
import { ChunkPriorityTier } from "#src/chunk_manager/base.js";
import type { SharedWatchableValue } from "#src/worker/shared_watchable_value.js";
import type {
  ProjectionParameters,
  TransformedSource,
  VolumeChunkSpecification,
} from "#src/render/base.js";
import {
  ChunkLayout,
  forEachPlaneIntersectingVolumetricChunk,
  PROJECTION_PARAMETERS_CHANGED_RPC_METHOD_ID,
  PROJECTION_PARAMETERS_RPC_ID,
  SLICEVIEW_RENDERLAYER_RPC_ID,
  SLICEVIEW_RPC_ID,
  SLICEVIEW_SET_LAYER_RPC_ID,
  SliceViewBase,
} from "#src/render/base.js";
import type { WatchableValueChangeInterface } from "#src/state/trackable_value.js";
import { erf } from "#src/util/erf.js";
import { vec3, vec3Key } from "#src/util/geom.js";
import { Signal } from "#src/util/signal.js";
import { VelocityEstimator } from "#src/util/velocity_estimation.js";
import type { RPC } from "#src/worker/worker_rpc.js";
import {
  registerRPC,
  registerSharedObject,
  SharedObjectCounterpart,
} from "#src/worker/worker_rpc.js";

/**
 * Worker copy of a panel's projection parameters, updated by `SharedProjectionParameters` in
 * `frontend.ts`.  `changed` fires after each update.
 */
@registerSharedObject(PROJECTION_PARAMETERS_RPC_ID)
export class SharedProjectionParametersBackend
  extends SharedObjectCounterpart
  implements WatchableValueChangeInterface<ProjectionParameters>
{
  value: ProjectionParameters;
  oldValue: ProjectionParameters;
  changed = new Signal<
    (oldValue: ProjectionParameters, newValue: ProjectionParameters) => void
  >();
  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.value = options.value;
    this.oldValue = Object.assign({}, this.value);
  }
}

registerRPC(PROJECTION_PARAMETERS_CHANGED_RPC_METHOD_ID, function (x) {
  const obj: SharedProjectionParametersBackend = this.get(x.id);
  const { value, oldValue } = obj;
  Object.assign(oldValue, value);
  Object.assign(value, x.value);
  obj.changed.dispatch(oldValue, value);
});

export const BASE_PRIORITY = -1e12;
export const SCALE_PRIORITY_MULTIPLIER = 1e9;

// Temporary values used by SliceView.updateVisibleChunk
const tempChunkPosition = vec3.create();
const tempCenter = vec3.create();
const tempChunkSize = vec3.create();

@registerSharedObject(SLICEVIEW_RPC_ID)
export class SliceViewBackend extends SliceViewBase<VolumeChunkSource> {
  // The chunk manager the view requests its chunks from.  No reference is added, because the main
  // thread's view holds one.
  chunkManager: ChunkManager;
  // The render layer whose sources are shown, once the main thread has sent it.
  layer: SliceViewRenderLayerBackend | undefined;
  // Estimates how the view position moves, to prefetch the chunks it is heading towards.
  velocityEstimator = new VelocityEstimator();
  // How much this view's chunks are worth loading (see `render/panel.ts`).
  visibility: SharedWatchableValue<number>;

  constructor(rpc: RPC, options: any) {
    super(rpc.get(options.projectionParameters));
    this.initializeSharedObject(rpc, options.id);
    this.chunkManager = rpc.get(options.chunkManager);
    this.visibility = rpc.get(options.visibility);
    this.registerDisposer(
      this.visibility.changed.add(() => {
        this.chunkManager.scheduleUpdateChunkPriorities();
      }),
    );
    this.registerDisposer(
      this.chunkManager.recomputeChunkPriorities.add(() => {
        this.updateVisibleChunks();
      }),
    );
    this.registerDisposer(
      this.projectionParameters.changed.add(() => {
        this.velocityEstimator.addSample(
          this.projectionParameters.value.globalPosition,
        );
      }),
    );
  }

  invalidateVisibleChunks() {
    super.invalidateVisibleChunks();
    this.chunkManager.scheduleUpdateChunkPriorities();
  }

  private handleRenderScaleTargetChanged = () => {
    this.invalidateVisibleSources();
  };

  updateVisibleChunks() {
    const projectionParameters = this.projectionParameters.value;
    // Nothing is shown, and the projection is not usable, until the volume has loaded (there is no
    // position yet, see `DerivedProjectionParameters`) and the panel has been measured (a zero width
    // or height makes the projection matrix singular).  Without this, the view would request an
    // arbitrary block of chunks.
    const { width, height, globalPosition } = projectionParameters;
    if (globalPosition.length === 0 || width === 0 || height === 0) {
      return;
    }
    // A view that is neither on screen nor near it requests nothing; one that is only near the
    // screen loads its chunks at the PREFETCH tier, so that it is ready once it is scrolled into
    // view but gives way to the views that are being looked at.
    const visibility = this.visibility.value;
    if (visibility === Number.NEGATIVE_INFINITY) {
      return;
    }
    const priorityTier =
      visibility === Number.POSITIVE_INFINITY
        ? ChunkPriorityTier.VISIBLE
        : ChunkPriorityTier.PREFETCH;
    const chunkManager = this.chunkManager;
    this.updateVisibleSources();
    const { centerDataPosition } = projectionParameters;
    // Requests every chunk the cross-section plane cuts through, and the chunks next to them that
    // the view is likely to reach soon, judging by how its position has been moving, as PREFETCH.
    // Within a tier, coarser scales (listed later) get higher priority, so that something is shown
    // quickly, and within a scale chunks closer to the center of the view come first.
    const basePriority = BASE_PRIORITY;

    const localCenter = tempCenter;

    const chunkSize = tempChunkSize;

    const curVisibleChunks: VolumeChunk[] = [];
    this.velocityEstimator.addSample(
      this.projectionParameters.value.globalPosition,
    );
    const { visibleSources } = this;
    for (let i = 0, numVisibleSources = visibleSources.length; i < numVisibleSources; ++i) {
      const tsource = visibleSources[i];
      const prefetchOffsets = chunkManager.queueManager.enablePrefetch.value
        ? getPrefetchChunkOffsets(this.velocityEstimator, tsource)
        : [];
      const { chunkLayout } = tsource;
      chunkLayout.globalToLocalSpatial(localCenter, centerDataPosition);
      vec3.copy(chunkSize, chunkLayout.size);
      const priorityIndex = i;
      const sourceBasePriority =
        basePriority + SCALE_PRIORITY_MULTIPLIER * priorityIndex;
      curVisibleChunks.length = 0;
      const curMarkGeneration = getNextMarkGeneration();
      forEachPlaneIntersectingVolumetricChunk(
        projectionParameters,
        tsource,
        (positionInChunks) => {
          vec3.multiply(tempChunkPosition, positionInChunks, chunkSize);
          const priority = -vec3.distance(localCenter, tempChunkPosition);
          const { curPositionInChunks } = tsource;
          const chunk = tsource.source.getChunk(curPositionInChunks);
          chunkManager.requestChunk(
            chunk,
            priorityTier,
            sourceBasePriority + priority,
          );
          curVisibleChunks.push(chunk);
          // Mark visible chunks to avoid duplicate work when prefetching.  Once we hit a
          // visible chunk, we don't continue prefetching in the same direction.
          chunk.markGeneration = curMarkGeneration;
        },
      );
      if (prefetchOffsets.length !== 0) {
        const { curPositionInChunks } = tsource;
        for (const visibleChunk of curVisibleChunks) {
          curPositionInChunks.set(visibleChunk.chunkGridPosition);
          for (let j = 0, length = prefetchOffsets.length; j < length; ) {
            const chunkDim = prefetchOffsets[j];
            const minChunk = prefetchOffsets[j + 2];
            const maxChunk = prefetchOffsets[j + 3];
            const newPriority = prefetchOffsets[j + 4];
            const jumpOffset = prefetchOffsets[j + 5];
            const oldIndex = curPositionInChunks[chunkDim];
            const newIndex = oldIndex + prefetchOffsets[j + 1];
            if (newIndex < minChunk || newIndex > maxChunk) {
              j = jumpOffset;
              continue;
            }
            curPositionInChunks[chunkDim] = newIndex;
            const chunk = tsource.source.getChunk(curPositionInChunks);
            curPositionInChunks[chunkDim] = oldIndex;
            if (chunk.markGeneration === curMarkGeneration) {
              j = jumpOffset;
              continue;
            }
            chunkManager.requestChunk(
              chunk,
              ChunkPriorityTier.PREFETCH,
              sourceBasePriority + newPriority,
            );
            j += PREFETCH_ENTRY_SIZE;
          }
        }
      }
    }
  }

  // Shows `sources`, the scales of `layer`, replacing any layer shown before.
  setLayer(
    layer: SliceViewRenderLayerBackend,
    sources: TransformedSource<VolumeChunkSource>[],
  ) {
    this.removeLayer();
    this.layer = layer;
    this.sources = sources;
    this.renderScaleTarget = layer.renderScaleTarget;
    layer.renderScaleTarget.changed.add(this.handleRenderScaleTargetChanged);
    this.invalidateVisibleSources();
  }

  private removeLayer() {
    const { layer } = this;
    if (layer === undefined) return;
    for (const tsource of this.sources) {
      tsource.source.dispose();
    }
    layer.renderScaleTarget.changed.remove(this.handleRenderScaleTargetChanged);
    this.layer = undefined;
    this.sources = [];
    this.visibleSources.length = 0;
    this.renderScaleTarget = undefined;
    this.invalidateVisibleSources();
  }

  disposed() {
    this.removeLayer();
    super.disposed();
  }

  invalidateVisibleSources() {
    super.invalidateVisibleSources();
    this.chunkManager.scheduleUpdateChunkPriorities();
  }
}

// Rebuilds a transformed source sent by `serializeTransformedSource` in `frontend.ts`, taking the
// reference to the chunk source that came with it.
function deserializeTransformedSource(
  rpc: RPC,
  serializedSource: any,
): TransformedSource<VolumeChunkSource> {
  const source = rpc.getRef<VolumeChunkSource>(serializedSource.source);
  return {
    source,
    chunkLayout: ChunkLayout.fromObject(serializedSource.chunkLayout),
    curPositionInChunks: new Float32Array(source.spec.rank),
  };
}

registerRPC(SLICEVIEW_SET_LAYER_RPC_ID, function (x) {
  const sliceView = <SliceViewBackend>this.get(x.id);
  const layer = <SliceViewRenderLayerBackend>this.get(x.layerId);
  const sources = (x.sources as any[]).map((serializedSource) =>
    deserializeTransformedSource(this, serializedSource),
  );
  sliceView.setLayer(layer, sources);
});

/**
 * Worker-side volume chunk.  `download` fills `data`; the data is transferred to the main thread
 * (and dropped here) when the chunk is serialized for an upload to the GPU.
 */
export class VolumeChunk extends Chunk {
  source: VolumeChunkSource | null = null;
  // Position of the chunk in the chunk grid.
  chunkGridPosition!: Float32Array;
  data!: ArrayBufferView | null;

  initializeVolumeChunk(key: string, chunkGridPosition: Float32Array) {
    super.initialize(key);
    this.chunkGridPosition = Float32Array.from(chunkGridPosition);
    this.data = null;
  }

  serialize(msg: any, transfers: any[]) {
    super.serialize(msg, transfers);
    msg.chunkGridPosition = this.chunkGridPosition;
    const data = (msg.data = this.data);
    if (data !== null) {
      transfers.push(data!.buffer);
    }
    this.data = null;
  }

  downloadSucceeded() {
    this.systemMemoryBytes = this.gpuMemoryBytes = this.data?.byteLength ?? 0;
    super.downloadSucceeded();
  }

  freeSystemMemory() {
    this.data = null;
  }

  toString() {
    return this.source!.toString() + ":" + vec3Key(this.chunkGridPosition);
  }
}

/**
 * Worker side of the chunk source of one scale.  Keeps its chunks by grid position and creates each
 * the first time it is requested; `download` is defined by the data source (see
 * `datasource/zarr/backend.ts`).
 */
export class VolumeChunkSource extends ChunkSource {
  spec: VolumeChunkSpecification;
  chunks!: Map<string, VolumeChunk>;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.spec = options.spec;
  }

  getChunk(chunkGridPosition: Float32Array) {
    const key = chunkGridPosition.join();
    let chunk = this.chunks.get(key);
    if (chunk === undefined) {
      chunk = this.getNewChunk_(VolumeChunk);
      chunk.initializeVolumeChunk(key, chunkGridPosition);
      this.addChunk(chunk);
    }
    return chunk;
  }
}

@registerSharedObject(SLICEVIEW_RENDERLAYER_RPC_ID)
export class SliceViewRenderLayerBackend extends SharedObjectCounterpart {
  rpcId!: number;
  renderScaleTarget: SharedWatchableValue<number>;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.renderScaleTarget = rpc.get(options.renderScaleTarget);
  }
}

// How far ahead to prefetch: chunks the view may reach within this time.
const PREFETCH_MS = 2000;
const MAX_PREFETCH_VELOCITY = 0.1; // voxels per millisecond
const MAX_SINGLE_DIRECTION_PREFETCH_CHUNKS = 32; // Maximum number of chunks to prefetch in a single direction.

// If the probability under the model of needing a chunk within `PREFETCH_MS` is less than this
// probability, skip prefetching it.
const PREFETCH_PROBABILITY_CUTOFF = 0.05;

const PREFETCH_ENTRY_SIZE = 6;

/**
 * Returns the chunks of `tsource` to prefetch around each of its visible chunks, as a flat list of
 * entries of `PREFETCH_ENTRY_SIZE` numbers: chunk dimension, offset (in chunks) along it, lowest and
 * highest chunk index along it, priority, and the index of the entry that follows the entry's group.
 *
 * The velocity of the view position along each dimension is modeled as a normal distribution, whose
 * mean and variance are estimated by `velocityEstimator` and converted to chunks of this scale.  The
 * chunk `i` chunks away is prefetched if the probability of reaching it within `PREFETCH_MS` is at
 * least `PREFETCH_PROBABILITY_CUTOFF`, and that probability is its priority.  Entries are grouped by
 * dimension and direction, nearest first: once a chunk of a group is visible or out of bounds, the
 * rest of the group, which lies beyond it, is skipped.
 */
function getPrefetchChunkOffsets(
  velocityEstimator: VelocityEstimator,
  tsource: TransformedSource<VolumeChunkSource>,
): number[] {
  const offsets: number[] = [];
  const globalRank = velocityEstimator.rank;
  // Maps a change of the global position (in viewer coordinates) to a change in chunk coordinates
  // (voxels of this scale): `invTransform[globalDim * 4 + chunkDim]`.
  const { invTransform } = tsource.chunkLayout;

  const {
    rank: chunkRank,
    chunkDataSize,
    lowerVoxelBound,
    upperVoxelBound,
  } = tsource.source.spec;
  const { mean: meanVec, variance: varianceVec } = velocityEstimator;
  for (let chunkDim = 0; chunkDim < chunkRank; ++chunkDim) {
    let mean = 0;
    let variance = 0;
    for (let globalDim = 0; globalDim < globalRank; ++globalDim) {
      const meanValue = meanVec[globalDim];
      const varianceValue = varianceVec[globalDim];
      const coeff = invTransform[globalDim * 4 + chunkDim];
      mean += coeff * meanValue;
      variance += coeff * coeff * varianceValue;
    }
    // Moving too fast for prefetching to keep up.  As in Neuroglancer, only a fast motion towards
    // higher chunk coordinates is skipped.
    if (mean > MAX_PREFETCH_VELOCITY) {
      continue;
    }
    const chunkSize = chunkDataSize[chunkDim];
    // Mean and standard deviation (times sqrt 2) of the distance travelled within `PREFETCH_MS`, in
    // chunks.
    const adjustedMean = (mean / chunkSize) * PREFETCH_MS;
    let adjustedStddevTimesSqrt2 =
      (Math.sqrt(2 * variance) / chunkSize) * PREFETCH_MS;
    if (Math.abs(adjustedMean) < 1e-3 && adjustedStddevTimesSqrt2 < 1e-3) {
      continue;
    }
    adjustedStddevTimesSqrt2 = Math.max(1e-6, adjustedStddevTimesSqrt2);
    // Probability of travelling less than `x` chunks.
    const cdf = (x: number) =>
      0.5 * (1 + erf((x - adjustedMean) / adjustedStddevTimesSqrt2));

    const minChunk = Math.floor(lowerVoxelBound[chunkDim] / chunkSize);
    const maxChunk = Math.ceil(upperVoxelBound[chunkDim] / chunkSize) - 1;
    let groupStart = offsets.length;
    for (let i = 1; i <= MAX_SINGLE_DIRECTION_PREFETCH_CHUNKS; ++i) {
      const probability = 1 - cdf(i);
      // Probability that chunk `curChunk + i` will be needed within `PREFETCH_MS`.
      if (probability < PREFETCH_PROBABILITY_CUTOFF) break;
      offsets.push(chunkDim, i, minChunk, maxChunk, probability, 0);
    }
    let newGroupStart = offsets.length;
    for (
      let i = groupStart, end = offsets.length;
      i < end;
      i += PREFETCH_ENTRY_SIZE
    ) {
      offsets[i + PREFETCH_ENTRY_SIZE - 1] = newGroupStart;
    }
    groupStart = newGroupStart;

    for (let i = 1; i <= MAX_SINGLE_DIRECTION_PREFETCH_CHUNKS; ++i) {
      const probability = cdf(-i + 1);
      // Probability that chunk `curChunk - i` will be needed within `PREFETCH_MS`.
      if (probability < PREFETCH_PROBABILITY_CUTOFF) break;
      offsets.push(chunkDim, -i, minChunk, maxChunk, probability, 0);
    }
    newGroupStart = offsets.length;
    for (
      let i = groupStart, end = offsets.length;
      i < end;
      i += PREFETCH_ENTRY_SIZE
    ) {
      offsets[i + PREFETCH_ENTRY_SIZE - 1] = newGroupStart;
    }
  }
  return offsets;
}

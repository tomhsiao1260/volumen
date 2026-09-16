/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * @file Worker side of chunk management.
 *
 * Every chunk has a priority tier (VISIBLE, PREFETCH or RECENT) and a priority within the tier.
 * Layers call `ChunkManager.requestChunk` for the chunks they need each time priorities are
 * recomputed; chunks that are no longer requested fall back to RECENT.  `ChunkQueueManager` then
 * moves the highest-priority chunks forward through the states
 *
 *   QUEUED -> DOWNLOADING -> SYSTEM_MEMORY_WORKER -> GPU_MEMORY
 *
 * within the download, system memory and GPU memory capacities, evicting lower-priority chunks when
 * a capacity is full.  State changes that concern the main thread are sent as `Chunk.update`
 * messages (see `chunk_manager/frontend.ts`).
 */

import type { Capacity } from "#src/chunk_manager/base.js";
import {
  CHUNK_MANAGER_RPC_ID,
  CHUNK_QUEUE_MANAGER_RPC_ID,
  CHUNK_RELOAD_RPC_ID,
  ChunkPriorityTier,
  ChunkState,
} from "#src/chunk_manager/base.js";
import type { SharedWatchableValue } from "#src/worker/shared_watchable_value.js";
import type { Borrowed, Disposable } from "#src/util/disposable.js";
import { LinkedList } from "#src/util/linked_list.js";
import type { ComparisonFunction } from "#src/util/pairing_heap.js";
import { PairingHeap } from "#src/util/pairing_heap.js";
import { NullarySignal } from "#src/util/signal.js";
import type { RPC } from "#src/worker/worker_rpc.js";
import {
  registerRPC,
  registerSharedObject,
  SharedObject,
  SharedObjectCounterpart,
} from "#src/worker/worker_rpc.js";

// Delay of the priority update that follows chunks moving to or from the GPU (see `ChunkManager`).
const GPU_MEMORY_PRIORITY_UPDATE_INTERVAL_MS = 200;

let nextMarkGeneration = 0;
export function getNextMarkGeneration() {
  return ++nextMarkGeneration;
}

export class Chunk implements Disposable {
  // Node properties used for eviction/promotion heaps and LRU linked lists.  A chunk can be in two
  // queues at once: one using the `0` fields and one using the `1` fields.
  child0: Chunk | null = null;
  next0: Chunk | null = null;
  prev0: Chunk | null = null;
  child1: Chunk | null = null;
  next1: Chunk | null = null;
  prev1: Chunk | null = null;

  source: ChunkSource | null = null;

  key: string | null = null;

  state = ChunkState.NEW;

  error: any = null;

  // Set to a value from `getNextMarkGeneration` by code that needs to mark chunks, e.g. to skip
  // visible chunks when prefetching.
  markGeneration = -1;

  // Priority within `priorityTier`; higher numbers come first.  Meaningless in the RECENT tier,
  // which is ordered by use instead.
  priority = 0;
  priorityTier = ChunkPriorityTier.RECENT;

  // The tier and priority requested in the round of priority updates being computed, which the
  // queues do not reflect until `updatePriorityProperties`.
  newPriority = 0;
  newPriorityTier = ChunkPriorityTier.RECENT;

  private systemMemoryBytes_ = 0;
  private gpuMemoryBytes_ = 0;

  // Whether a view is requesting this chunk.  Only requested chunks are copied to the GPU, which
  // is where views draw them from.
  requested = false;

  // Whether a view has requested it in the round of priority updates being computed.
  newRequested = false;

  // Aborts the pending download; set only while DOWNLOADING, and only used in this module.
  downloadAbortController: AbortController | undefined = undefined;

  initialize(key: string) {
    this.key = key;
    this.priority = Number.NEGATIVE_INFINITY;
    this.priorityTier = ChunkPriorityTier.RECENT;
    this.newPriority = Number.NEGATIVE_INFINITY;
    this.newPriorityTier = ChunkPriorityTier.RECENT;
    this.error = null;
    this.state = ChunkState.NEW;
    this.requested = false;
    this.newRequested = false;
  }

  // Takes the priority and request of the round just computed, and starts a new round.  The queues
  // are updated separately, by `performChunkPriorityUpdate`.
  updatePriorityProperties() {
    this.priorityTier = this.newPriorityTier;
    this.priority = this.newPriority;
    this.newPriorityTier = ChunkPriorityTier.RECENT;
    this.newPriority = Number.NEGATIVE_INFINITY;
    this.requested = this.newRequested;
    this.newRequested = false;
  }

  dispose() {
    this.source = null;
    this.error = null;
  }

  get chunkManager() {
    return (<ChunkSource>this.source).chunkManager;
  }

  get queueManager() {
    return (<ChunkSource>this.source).chunkManager.queueManager;
  }

  downloadFailed(error: any) {
    this.error = error;
    this.queueManager.updateChunkState(this, ChunkState.FAILED);
  }

  // The downloaded data stays in the worker until the chunk is copied to the GPU.
  downloadSucceeded() {
    this.queueManager.updateChunkState(this, ChunkState.SYSTEM_MEMORY_WORKER);
  }

  freeSystemMemory() {}

  serialize(msg: any, _transfers: any[]) {
    msg.id = this.key;
    msg.source = (<ChunkSource>this.source).rpcId;
    msg.new = true;
  }

  toString() {
    return this.key;
  }

  set systemMemoryBytes(bytes: number) {
    this.chunkManager.queueManager.adjustCapacitiesForChunk(this, false);
    this.systemMemoryBytes_ = bytes;
    this.chunkManager.queueManager.adjustCapacitiesForChunk(this, true);
    this.chunkManager.queueManager.scheduleUpdate();
  }

  get systemMemoryBytes() {
    return this.systemMemoryBytes_;
  }

  set gpuMemoryBytes(bytes: number) {
    this.chunkManager.queueManager.adjustCapacitiesForChunk(this, false);
    this.gpuMemoryBytes_ = bytes;
    this.chunkManager.queueManager.adjustCapacitiesForChunk(this, true);
    this.chunkManager.queueManager.scheduleUpdate();
  }

  get gpuMemoryBytes() {
    return this.gpuMemoryBytes_;
  }

  static priorityLess(a: Chunk, b: Chunk) {
    return a.priority < b.priority;
  }

  static priorityGreater(a: Chunk, b: Chunk) {
    return a.priority > b.priority;
  }
}

export interface ChunkConstructor<T extends Chunk> {
  new (): T;
}

/**
 * Worker counterpart of a frontend `ChunkSource`.  Holds the chunks of one source (e.g. one scale
 * of a volume) keyed by chunk key, and downloads them with `download`.
 */
// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export class ChunkSource extends SharedObject {
  chunks: Map<string, Chunk> = new Map<string, Chunk>();
  // Chunk objects removed from `chunks`, kept for reuse.
  freeChunks: Chunk[] = new Array<Chunk>();
  chunkManager: Borrowed<ChunkManager>;

  constructor(rpc: RPC, options: any) {
    super();
    // No need to add a reference, since the owner counterpart will hold a reference to the owner
    // counterpart of chunkManager.
    this.chunkManager = <ChunkManager>rpc.get(options.chunkManager);
    this.initializeSharedObject(rpc, options.id);
  }

  getNewChunk_<T extends Chunk>(chunkType: ChunkConstructor<T>): T {
    const freeChunks = this.freeChunks;
    const freeChunksLength = freeChunks.length;
    if (freeChunksLength > 0) {
      const chunk = <T>freeChunks[freeChunksLength - 1];
      freeChunks.length = freeChunksLength - 1;
      chunk.source = this;
      return chunk;
    }
    const chunk = new chunkType();
    chunk.source = this;
    return chunk;
  }

  // The source holds a reference to itself while it has chunks.
  addChunk(chunk: Chunk) {
    const { chunks } = this;
    if (chunks.size === 0) {
      this.addRef();
    }
    chunks.set(chunk.key!, chunk);
  }

  // Keeps the chunk object for reuse, and releases the source's own reference if it was the last.
  removeChunk(chunk: Chunk) {
    const { chunks, freeChunks } = this;
    chunks.delete(chunk.key!);
    chunk.dispose();
    freeChunks[freeChunks.length] = chunk;
    if (chunks.size === 0) {
      this.dispose();
    }
  }
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
export interface ChunkSource {
  /**
   * Defined by the data source: stores the chunk's decoded data in it, or rejects, which puts the
   * chunk in the FAILED state.  `abortSignal` is aborted when the chunk is evicted while
   * downloading; the download must then stop and leave `chunk` alone, since the chunk object may
   * already have been reused for another chunk.
   */
  download(chunk: Chunk, abortSignal: AbortSignal): Promise<void>;
}

function startChunkDownload(chunk: Chunk) {
  const abortController = (chunk.downloadAbortController =
    new AbortController());
  chunk.source!.download(chunk, abortController.signal).then(
    () => {
      if (chunk.downloadAbortController === abortController) {
        chunk.downloadAbortController = undefined;
        chunk.downloadSucceeded();
      }
    },
    (error: any) => {
      if (chunk.downloadAbortController === abortController) {
        chunk.downloadAbortController = undefined;
        chunk.downloadFailed(error);
        console.log(`Error retrieving chunk ${chunk}: ${error}`);
      }
    },
  );
}

// Aborts the chunk's download.  Whatever the download still produces is ignored, since the chunk no
// longer holds the same abort controller.
function cancelChunkDownload(chunk: Chunk) {
  const abortController = chunk.downloadAbortController!;
  chunk.downloadAbortController = undefined;
  abortController.abort();
}

/**
 * Chunks ordered by priority tier and priority: a pairing heap for each of the VISIBLE and PREFETCH
 * tiers, and a linked list (most recently added first) for the RECENT tier.
 */
class ChunkPriorityQueue {
  // Heap root of the VISIBLE and PREFETCH tiers.
  private heapRoots: (Chunk | null)[] = [null, null];

  // Head of the RECENT list, which is not a chunk itself.
  private recentHead = new Chunk();
  constructor(
    private heapOperations: PairingHeap<Chunk>,
    private linkedListOperations: LinkedList<Chunk>,
  ) {
    linkedListOperations.initializeHead(this.recentHead);
  }

  add(chunk: Chunk) {
    const priorityTier = chunk.priorityTier;
    if (priorityTier === ChunkPriorityTier.RECENT) {
      this.linkedListOperations.insertAfter(this.recentHead, chunk);
    } else {
      const { heapRoots } = this;
      heapRoots[priorityTier] = this.heapOperations.meld(
        heapRoots[priorityTier],
        chunk,
      );
    }
  }

  // Yields the chunks of one heap, lowest priority first for an eviction queue (whose heap is
  // ordered by `priorityLess`) and highest priority first for a promotion queue.
  private *heapChunks(tier: ChunkPriorityTier) {
    const { heapRoots } = this;
    while (true) {
      const root = heapRoots[tier];
      if (root == null) {
        break;
      }
      yield root;
    }
  }

  /**
   * Yields the chunks to give up first: those no longer requested, least recently used first, then
   * the prefetched ones and finally the visible ones, lowest priority first within each tier.
   */
  *evictionCandidates(): Iterator<Chunk> {
    const { linkedListOperations, recentHead } = this;
    while (true) {
      const chunk = linkedListOperations.back(recentHead);
      if (chunk == null) {
        break;
      }
      yield chunk;
    }
    yield* this.heapChunks(ChunkPriorityTier.PREFETCH);
    yield* this.heapChunks(ChunkPriorityTier.VISIBLE);
  }

  /**
   * Yields the chunks to move forward first: the visible ones, highest priority first, then the
   * prefetched ones, and last those no longer requested, most recently used first.
   */
  *promotionCandidates(): Iterator<Chunk> {
    yield* this.heapChunks(ChunkPriorityTier.VISIBLE);
    yield* this.heapChunks(ChunkPriorityTier.PREFETCH);
    const { linkedListOperations, recentHead } = this;
    while (true) {
      const chunk = linkedListOperations.front(recentHead);
      if (chunk == null) {
        break;
      }
      yield chunk;
    }
  }

  delete(chunk: Chunk) {
    const priorityTier = chunk.priorityTier;
    if (priorityTier === ChunkPriorityTier.RECENT) {
      this.linkedListOperations.pop(chunk);
    } else {
      const heapRoots = this.heapRoots;
      heapRoots[priorityTier] = this.heapOperations.remove(
        <Chunk>heapRoots[priorityTier],
        chunk,
      );
    }
  }
}

// A chunk can be in two queues at once: queues made by `makeChunkPriorityQueue0` link it through its
// `0` fields, and those made by `makeChunkPriorityQueue1` through its `1` fields.
function makeChunkPriorityQueue0(compare: ComparisonFunction<Chunk>) {
  return new ChunkPriorityQueue(
    new PairingHeap(compare, "child0", "next0", "prev0"),
    new LinkedList("next0", "prev0"),
  );
}

function makeChunkPriorityQueue1(compare: ComparisonFunction<Chunk>) {
  return new ChunkPriorityQueue(
    new PairingHeap(compare, "child1", "next1", "prev1"),
    new LinkedList("next1", "prev1"),
  );
}

// Evicts candidates until `capacity` has room for one item of `size` bytes.  Stops, and returns
// false, once the next candidate is not worth less than the chunk waiting to be promoted.
function tryToFreeCapacity(
  size: number,
  capacity: AvailableCapacity,
  priorityTier: ChunkPriorityTier,
  priority: number,
  evictionCandidates: Iterator<Chunk>,
  evict: (chunk: Chunk) => void,
) {
  while (capacity.availableItems < 1 || capacity.availableSize < size) {
    const evictionCandidate = evictionCandidates.next().value;
    if (evictionCandidate === undefined) {
      // No eviction candidates available, promotions are done.
      return false;
    }
    const evictionTier = evictionCandidate.priorityTier;
    if (
      evictionTier < priorityTier ||
      (evictionTier === priorityTier && evictionCandidate.priority >= priority)
    ) {
      return false;
    }
    evict(evictionCandidate);
  }
  return true;
}

// How much of one `Capacity` is still free.
class AvailableCapacity {
  currentSize = 0;
  currentItems = 0;

  constructor(readonly limits: Capacity) {}

  // Records that `items` chunks of `size` bytes in total have been added, or removed if negative.
  adjust(items: number, size: number) {
    this.currentItems += items;
    this.currentSize += size;
  }

  get availableSize() {
    return this.limits.sizeLimit - this.currentSize;
  }
  get availableItems() {
    return this.limits.itemLimit - this.currentItems;
  }
}

@registerSharedObject(CHUNK_QUEUE_MANAGER_RPC_ID)
export class ChunkQueueManager extends SharedObjectCounterpart {
  gpuMemoryCapacity: AvailableCapacity;
  systemMemoryCapacity: AvailableCapacity;
  downloadCapacity: AvailableCapacity;

  // Whether views request the chunks they are likely to need soon as PREFETCH.
  enablePrefetch: SharedWatchableValue<boolean>;
  // Whether `logCounts` runs after every update.
  logStatistics: SharedWatchableValue<boolean>;
  // Number of chunks in each state, kept up to date by `adjustCapacitiesForChunk`.
  private chunkCountByState = new Array<number>(ChunkState.EXPIRED + 1).fill(0);

  // Dispatched after an update that copied chunks to the GPU or freed them from it.
  gpuMemoryChanged = new NullarySignal();
  // Incremented whenever a chunk is copied to the GPU or freed from it.
  private gpuMemoryGeneration = 0;

  // Chunks waiting to be downloaded (QUEUED).
  private queuedDownloadPromotionQueue = makeChunkPriorityQueue1(
    Chunk.priorityGreater,
  );

  // Chunks being downloaded, whose downloads can be given up.
  private downloadEvictionQueue = makeChunkPriorityQueue1(Chunk.priorityLess);

  // Chunks that take up memory: DOWNLOADING, SYSTEM_MEMORY(_WORKER) or GPU_MEMORY.
  private systemMemoryEvictionQueue = makeChunkPriorityQueue0(
    Chunk.priorityLess,
  );

  // Requested chunks whose data is in memory, waiting to be copied to the GPU.
  private gpuMemoryPromotionQueue = makeChunkPriorityQueue1(
    Chunk.priorityGreater,
  );

  // Chunks on the GPU, which can be freed from it again.
  private gpuMemoryEvictionQueue = makeChunkPriorityQueue1(Chunk.priorityLess);

  // Should be `number|null`, but marked `any` to work around @types/node being pulled in.
  private updatePending: any = null;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.gpuMemoryCapacity = new AvailableCapacity(options.gpuMemoryCapacity);
    this.systemMemoryCapacity = new AvailableCapacity(
      options.systemMemoryCapacity,
    );
    this.downloadCapacity = new AvailableCapacity(options.downloadCapacity);
    this.enablePrefetch = rpc.get(options.enablePrefetch);
    this.logStatistics = rpc.get(options.logStatistics);
  }

  scheduleUpdate() {
    if (this.updatePending === null) {
      this.updatePending = setTimeout(this.process.bind(this), 0);
    }
  }

  *chunkQueuesForChunk(chunk: Chunk) {
    switch (chunk.state) {
      case ChunkState.QUEUED:
        yield this.queuedDownloadPromotionQueue;
        break;

      case ChunkState.DOWNLOADING:
        yield this.downloadEvictionQueue;
        yield this.systemMemoryEvictionQueue;
        break;

      case ChunkState.SYSTEM_MEMORY_WORKER:
      case ChunkState.SYSTEM_MEMORY:
        yield this.systemMemoryEvictionQueue;
        if (chunk.requested) {
          yield this.gpuMemoryPromotionQueue;
        }
        break;

      case ChunkState.GPU_MEMORY:
        yield this.systemMemoryEvictionQueue;
        yield this.gpuMemoryEvictionQueue;
        break;
    }
  }

  adjustCapacitiesForChunk(chunk: Chunk, add: boolean) {
    const factor = add ? 1 : -1;
    this.chunkCountByState[chunk.state] += factor;
    switch (chunk.state) {
      case ChunkState.DOWNLOADING:
        this.downloadCapacity.adjust(factor, factor * chunk.systemMemoryBytes);
        this.systemMemoryCapacity.adjust(
          factor,
          factor * chunk.systemMemoryBytes,
        );
        break;

      case ChunkState.SYSTEM_MEMORY:
      case ChunkState.SYSTEM_MEMORY_WORKER:
        this.systemMemoryCapacity.adjust(
          factor,
          factor * chunk.systemMemoryBytes,
        );
        break;

      case ChunkState.GPU_MEMORY:
        this.systemMemoryCapacity.adjust(
          factor,
          factor * chunk.systemMemoryBytes,
        );
        this.gpuMemoryCapacity.adjust(factor, factor * chunk.gpuMemoryBytes);
        break;
    }
  }

  private removeChunkFromQueues_(chunk: Chunk) {
    for (const queue of this.chunkQueuesForChunk(chunk)) {
      queue.delete(chunk);
    }
  }

  private addChunkToQueues_(chunk: Chunk) {
    if (
      chunk.state === ChunkState.QUEUED &&
      chunk.priorityTier === ChunkPriorityTier.RECENT
    ) {
      // Delete this chunk.
      const { source } = chunk;
      source!.removeChunk(chunk);
      this.adjustCapacitiesForChunk(chunk, false);
      return false;
    }
    for (const queue of this.chunkQueuesForChunk(chunk)) {
      queue.add(chunk);
    }
    return true;
  }

  performChunkPriorityUpdate(chunk: Chunk) {
    if (
      chunk.priorityTier === chunk.newPriorityTier &&
      chunk.priority === chunk.newPriority
    ) {
      chunk.newPriorityTier = ChunkPriorityTier.RECENT;
      chunk.newPriority = Number.NEGATIVE_INFINITY;
      return;
    }
    this.removeChunkFromQueues_(chunk);
    chunk.updatePriorityProperties();
    if (chunk.state === ChunkState.NEW) {
      chunk.state = ChunkState.QUEUED;
      this.adjustCapacitiesForChunk(chunk, true);
    }
    this.addChunkToQueues_(chunk);
  }

  updateChunkState(chunk: Chunk, newState: ChunkState) {
    if (newState === chunk.state) {
      return;
    }
    this.adjustCapacitiesForChunk(chunk, false);
    this.removeChunkFromQueues_(chunk);
    chunk.state = newState;
    this.adjustCapacitiesForChunk(chunk, true);
    this.addChunkToQueues_(chunk);
    this.scheduleUpdate();
  }

  // Copies the highest-priority chunks in system memory to the GPU, evicting lower-priority chunks
  // from the GPU as needed.
  private processGPUPromotions_() {
    const evictFromGPUMemory = (chunk: Chunk) => {
      this.freeChunkGPUMemory(chunk);
      this.updateChunkState(chunk, ChunkState.SYSTEM_MEMORY);
    };
    const promotionCandidates = this.gpuMemoryPromotionQueue.promotionCandidates();
    const evictionCandidates = this.gpuMemoryEvictionQueue.evictionCandidates();
    const capacity = this.gpuMemoryCapacity;
    while (true) {
      const promotionCandidate = promotionCandidates.next().value;
      if (promotionCandidate === undefined) {
        break;
      }
      const priorityTier = promotionCandidate.priorityTier;
      const priority = promotionCandidate.priority;
      if (
        !tryToFreeCapacity(
          promotionCandidate.gpuMemoryBytes,
          capacity,
          priorityTier,
          priority,
          evictionCandidates,
          evictFromGPUMemory,
        )
      ) {
        break;
      }
      this.copyChunkToGPU(promotionCandidate);
      this.updateChunkState(promotionCandidate, ChunkState.GPU_MEMORY);
    }
  }

  freeChunkGPUMemory(chunk: Chunk) {
    ++this.gpuMemoryGeneration;
    this.rpc!.invoke("Chunk.update", {
      id: chunk.key,
      state: ChunkState.SYSTEM_MEMORY,
      source: chunk.source!.rpcId,
    });
  }

  freeChunkSystemMemory(chunk: Chunk) {
    if (chunk.state === ChunkState.SYSTEM_MEMORY_WORKER) {
      chunk.freeSystemMemory();
    } else {
      this.rpc!.invoke("Chunk.update", {
        id: chunk.key,
        state: ChunkState.EXPIRED,
        source: chunk.source!.rpcId,
      });
    }
  }

  copyChunkToGPU(chunk: Chunk) {
    ++this.gpuMemoryGeneration;
    const rpc = this.rpc!;
    if (chunk.state === ChunkState.SYSTEM_MEMORY) {
      rpc.invoke("Chunk.update", {
        id: chunk.key,
        source: chunk.source!.rpcId,
        state: ChunkState.GPU_MEMORY,
      });
    } else {
      // The data is still in the worker: transfer it with the update.
      const msg: any = {};
      const transfers: any[] = [];
      chunk.serialize(msg, transfers);
      msg.state = ChunkState.GPU_MEMORY;
      rpc.invoke("Chunk.update", msg, transfers);
    }
  }

  // Frees the chunk's data wherever it is and puts the chunk back in the download queue, where it
  // is downloaded again if still requested, and deleted otherwise.
  evictChunk(chunk: Chunk) {
    switch (chunk.state) {
      case ChunkState.DOWNLOADING:
        cancelChunkDownload(chunk);
        break;
      case ChunkState.GPU_MEMORY:
        this.freeChunkGPUMemory(chunk);
        this.freeChunkSystemMemory(chunk);
        break;
      case ChunkState.SYSTEM_MEMORY_WORKER:
      case ChunkState.SYSTEM_MEMORY:
        this.freeChunkSystemMemory(chunk);
        break;
    }
    // Note: After calling this, chunk may no longer be valid.
    this.updateChunkState(chunk, ChunkState.QUEUED);
  }

  // Starts downloading the highest-priority queued chunks, evicting lower-priority chunks from the
  // download slots and from system memory as needed.
  private processQueuePromotions_() {
    const evict = (chunk: Chunk) => this.evictChunk(chunk);

    const promotionCandidates =
      this.queuedDownloadPromotionQueue.promotionCandidates();
    const evictionCandidates = this.downloadEvictionQueue.evictionCandidates();
    const systemMemoryEvictionCandidates =
      this.systemMemoryEvictionQueue.evictionCandidates();
    while (true) {
      const promotionCandidateResult = promotionCandidates.next();
      if (promotionCandidateResult.done) {
        return;
      }
      const promotionCandidate = promotionCandidateResult.value;
      const size = 0; /* unknown size, since it hasn't been downloaded yet. */
      const priorityTier = promotionCandidate.priorityTier;
      const priority = promotionCandidate.priority;
      if (
        !tryToFreeCapacity(
          size,
          this.downloadCapacity,
          priorityTier,
          priority,
          evictionCandidates,
          evict,
        )
      ) {
        return;
      }
      if (
        !tryToFreeCapacity(
          size,
          this.systemMemoryCapacity,
          priorityTier,
          priority,
          systemMemoryEvictionCandidates,
          evict,
        )
      ) {
        return;
      }
      this.updateChunkState(promotionCandidate, ChunkState.DOWNLOADING);
      startChunkDownload(promotionCandidate);
    }
  }

  private process() {
    this.updatePending = null;
    const gpuMemoryGeneration = this.gpuMemoryGeneration;
    this.processGPUPromotions_();
    this.processQueuePromotions_();
    if (this.gpuMemoryGeneration !== gpuMemoryGeneration) {
      this.gpuMemoryChanged.dispatch();
    }
    if (this.logStatistics.value) {
      this.logCounts();
    }
  }

  /**
   * Logs where the chunks are and how full the capacities are, e.g.
   *
   *   chunks: gpu_memory 74, downloading 4, queued 132 | downloads 4/100 |
   *   system 0.03/2.00 GB | gpu 0.02/1.00 GB
   *
   * Turn it on with `viewer.chunkManager.chunkQueueManager.logStatistics.value = true`.
   */
  private logCounts() {
    const counts = this.chunkCountByState
      .map((count, state) =>
        count === 0 ? "" : `${ChunkState[state].toLowerCase()} ${count}`,
      )
      .filter((text) => text !== "");
    const gb = (bytes: number) => (bytes / 1e9).toFixed(2);
    const { downloadCapacity, systemMemoryCapacity, gpuMemoryCapacity } = this;
    console.log(
      `chunks: ${counts.join(", ")} | ` +
        `downloads ${downloadCapacity.currentItems}/${downloadCapacity.limits.itemLimit} | ` +
        `system ${gb(systemMemoryCapacity.currentSize)}/${gb(systemMemoryCapacity.limits.sizeLimit)} GB | ` +
        `gpu ${gb(gpuMemoryCapacity.currentSize)}/${gb(gpuMemoryCapacity.limits.sizeLimit)} GB`,
    );
  }
}

@registerSharedObject(CHUNK_MANAGER_RPC_ID)
export class ChunkManager extends SharedObjectCounterpart {
  queueManager: ChunkQueueManager;

  // The chunks currently in the VISIBLE and PREFETCH tiers.
  private existingTierChunks: Chunk[][] = [[], []];

  // The chunks requested in the round being computed, not yet reflected in the queues.
  private newTierChunks: Chunk[] = [];

  // Should be `number|null`, but marked `any` to workaround `@types/node` being pulled in.
  private updatePending: any = null;

  // Dispatched when priorities are recomputed; listeners call `requestChunk` for the chunks they
  // need.
  recomputeChunkPriorities = new NullarySignal();

  // Pending priority update after chunks moved to or from the GPU, if any.
  private gpuMemoryUpdateTimer: any = null;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.queueManager = (<ChunkQueueManager>(
      rpc.get(options.chunkQueueManager)
    )).addRef();

    // While chunks keep arriving, priorities are also recomputed every
    // `GPU_MEMORY_PRIORITY_UPDATE_INTERVAL_MS`, not only when the view changes.  Each update gives
    // the views' velocity estimators a new sample, so once the view stops, the estimated velocity
    // decays and the chunks prefetched for the earlier motion are no longer requested.
    this.registerDisposer(
      this.queueManager.gpuMemoryChanged.add(() => {
        if (this.gpuMemoryUpdateTimer !== null) return;
        this.gpuMemoryUpdateTimer = setTimeout(() => {
          this.gpuMemoryUpdateTimer = null;
          this.scheduleUpdateChunkPriorities();
        }, GPU_MEMORY_PRIORITY_UPDATE_INTERVAL_MS);
      }),
    );
    this.registerDisposer(() => clearTimeout(this.gpuMemoryUpdateTimer));

  }

  scheduleUpdateChunkPriorities() {
    if (this.updatePending === null) {
      this.updatePending = setTimeout(
        this.recomputeChunkPriorities_.bind(this),
        0,
      );
    }
  }

  private recomputeChunkPriorities_() {
    this.updatePending = null;
    this.recomputeChunkPriorities.dispatch();
    this.updateQueueState();
  }

  // Requests `chunk` on the GPU for this round of priority updates, in `tier` (not RECENT, which
  // means "no longer requested") with `priority` within it.
  requestChunk(chunk: Chunk, tier: ChunkPriorityTier, priority: number) {
    if (Number.isNaN(priority)) {
      return;
    }
    if (tier === ChunkPriorityTier.RECENT) {
      throw new Error("Not going to request a chunk with the RECENT tier");
    }
    chunk.newRequested = true;
    if (chunk.newPriorityTier === ChunkPriorityTier.RECENT) {
      this.newTierChunks.push(chunk);
    }
    const newPriorityTier = chunk.newPriorityTier;
    if (
      tier < newPriorityTier ||
      (tier === newPriorityTier && priority > chunk.newPriority)
    ) {
      chunk.newPriorityTier = tier;
      chunk.newPriority = priority;
    }
  }

  // Updates the queues to the priorities just requested.  A chunk that is no longer requested moves
  // to the RECENT tier, and is removed if it had not started downloading.
  private updateQueueState() {
    const existingTierChunks = this.existingTierChunks;
    const queueManager = this.queueManager;
    for (const chunks of existingTierChunks) {
      for (const chunk of chunks) {
        if (chunk.newPriorityTier === ChunkPriorityTier.RECENT) {
          // Downgrade the priority of this chunk.
          queueManager.performChunkPriorityUpdate(chunk);
        }
      }
      chunks.length = 0;
    }
    const newTierChunks = this.newTierChunks;
    for (const chunk of newTierChunks) {
      queueManager.performChunkPriorityUpdate(chunk);
      existingTierChunks[chunk.priorityTier].push(chunk);
    }
    newTierChunks.length = 0;
    this.queueManager.scheduleUpdate();
  }
}


// Discards a chunk's data and downloads it again if it is still requested (see
// `ChunkSource.reloadChunk` in `chunk_manager/frontend.ts`).
registerRPC(CHUNK_RELOAD_RPC_ID, function (x) {
  const source = this.get(x.source) as ChunkSource | undefined;
  const chunk = source?.chunks.get(x.key);
  if (
    chunk === undefined ||
    chunk.state === ChunkState.NEW ||
    chunk.state === ChunkState.QUEUED
  ) {
    return;
  }
  source!.chunkManager.queueManager.evictChunk(chunk);
});

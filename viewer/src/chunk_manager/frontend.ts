/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * @file Main-thread side of chunk management.
 *
 * The worker decides which chunks to load and where they should live (see
 * `chunk_manager/backend.ts`).  It sends each change as a `Chunk.update` message, which is queued
 * here and applied in time slices: new chunks arrive with their data, are uploaded to the GPU,
 * freed from the GPU, or deleted once expired.
 */

import type { Capacity } from "#src/chunk_manager/base.js";
import {
  CHUNK_MANAGER_RPC_ID,
  CHUNK_QUEUE_MANAGER_RPC_ID,
  CHUNK_RELOAD_RPC_ID,
  ChunkState,
} from "#src/chunk_manager/base.js";
import { SharedWatchableValue } from "#src/worker/shared_watchable_value.js";
import { WatchableValue } from "#src/state/trackable_value.js";
import type { Borrowed } from "#src/util/disposable.js";
import { NullarySignal } from "#src/util/signal.js";
import type { GL } from "#src/webgl/context.js";
import type { RPC } from "#src/worker/worker_rpc.js";
import {
  registerRPC,
  registerSharedObjectOwner,
  SharedObject,
} from "#src/worker/worker_rpc.js";

// Time spent applying queued chunk updates before waiting `CHUNK_UPDATE_DELAY_MS` for the next
// batch, unless a change of the view has set an earlier deadline (see `chunkUpdateDeadline`).
const CHUNK_UPDATE_TIME_BUDGET_MS = 30;
const CHUNK_UPDATE_DELAY_MS = 30;

export class Chunk {
  state = ChunkState.SYSTEM_MEMORY;
  constructor(public source: ChunkSource) {}

  copyToGPU(_gl: GL) {
    this.state = ChunkState.GPU_MEMORY;
  }

  freeGPUMemory(_gl: GL) {
    this.state = ChunkState.SYSTEM_MEMORY;
  }
}

@registerSharedObjectOwner(CHUNK_QUEUE_MANAGER_RPC_ID)
export class ChunkQueueManager extends SharedObject {
  visibleChunksChanged = new NullarySignal();
  // Singly linked list (through `nextUpdate`) of `Chunk.update` messages not yet applied.
  pendingChunkUpdates: any = null;
  pendingChunkUpdatesTail: any = null;
  /**
   * If non-null, deadline in milliseconds since epoch after which chunk copies to the GPU may not
   * start (until the next frame).  The viewer sets it shortly after each change of the view, so that
   * uploads do not hold up the frame that shows the change, and clears it when a frame starts
   * drawing.
   */
  chunkUpdateDeadline: number | null = null;
  // Whether views also request the chunks they are likely to need soon (see `render/backend.ts`).
  enablePrefetch = new WatchableValue(true);
  // Whether the worker logs how many chunks are in each state after every update.
  logStatistics = new WatchableValue(false);

  constructor(
    rpc: RPC,
    public gl: GL,
    capacities: {
      gpuMemory: Capacity;
      systemMemory: Capacity;
      download: Capacity;
    },
  ) {
    super();
    this.initializeCounterpart(rpc, {
      gpuMemoryCapacity: capacities.gpuMemory,
      systemMemoryCapacity: capacities.systemMemory,
      downloadCapacity: capacities.download,
      enablePrefetch: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(rpc, this.enablePrefetch),
      ).rpcId,
      logStatistics: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(rpc, this.logStatistics),
      ).rpcId,
    });
  }

  scheduleChunkUpdate() {
    const deadline = this.chunkUpdateDeadline;
    const delay =
      deadline === null || Date.now() < deadline ? 0 : CHUNK_UPDATE_DELAY_MS;
    setTimeout(() => this.processPendingChunkUpdates(), delay);
  }

  processPendingChunkUpdates() {
    const deadline =
      this.chunkUpdateDeadline ?? Date.now() + CHUNK_UPDATE_TIME_BUDGET_MS;
    let visibleChunksChanged = false;
    while (true) {
      if (Date.now() > deadline) {
        // No time to perform chunk update now, we will wait some more.
        this.chunkUpdateDeadline = null;
        setTimeout(
          () => this.processPendingChunkUpdates(),
          CHUNK_UPDATE_DELAY_MS,
        );
        break;
      }
      const update = this.pendingChunkUpdates;
      if (update == null) break;
      try {
        if (this.applyChunkUpdate(update)) {
          visibleChunksChanged = true;
        }
      } finally {
        const nextUpdate = (this.pendingChunkUpdates = update.nextUpdate);
        if (nextUpdate == null) {
          this.pendingChunkUpdatesTail = null;
          break;
        }
      }
    }
    if (visibleChunksChanged) {
      this.visibleChunksChanged.dispatch();
    }
  }

  applyChunkUpdate(update: any) {
    let visibleChunksChanged = false;
    const { rpc } = this;
    const source = <ChunkSource>rpc!.get(update.source);
    if (source === undefined) {
      // Source was removed while chunk update was enqueued.
      return;
    }
    const newState: number = update.state;
    if (newState === ChunkState.EXPIRED) {
      source.deleteChunk(update.id);
    } else {
      let chunk: Chunk;
      const key = update.id;
      if (update.new) {
        chunk = source.getChunk(update);
        source.addChunk(key, chunk);
      } else {
        chunk = source.chunks.get(key)!;
      }
      const oldState = chunk.state;
      if (newState !== oldState) {
        switch (newState) {
          case ChunkState.GPU_MEMORY:
            chunk.copyToGPU(this.gl);
            visibleChunksChanged = true;
            break;
          case ChunkState.SYSTEM_MEMORY:
            if (oldState === ChunkState.GPU_MEMORY) {
              chunk.freeGPUMemory(this.gl);
            }
            break;
          default:
            throw new Error(
              `INTERNAL ERROR: Invalid chunk state: ${ChunkState[newState]}`,
            );
        }
      }
    }
    return visibleChunksChanged;
  }
}

registerRPC("Chunk.update", function (x) {
  const source: ChunkSource = this.get(x.source);
  const queueManager = source.chunkManager.chunkQueueManager;
  const pendingTail = queueManager.pendingChunkUpdatesTail;
  if (pendingTail == null) {
    queueManager.pendingChunkUpdates = x;
    queueManager.pendingChunkUpdatesTail = x;
    queueManager.scheduleChunkUpdate();
  } else {
    pendingTail.nextUpdate = x;
    queueManager.pendingChunkUpdatesTail = x;
  }
});

@registerSharedObjectOwner(CHUNK_MANAGER_RPC_ID)
export class ChunkManager extends SharedObject {
  // Chunk sources by key, so that all views of the same data share one source and its chunks.
  private chunkSources = new Map<string, ChunkSource>();

  get gl() {
    return this.chunkQueueManager.gl;
  }

  constructor(public chunkQueueManager: ChunkQueueManager) {
    super();
    this.registerDisposer(chunkQueueManager.addRef());
    this.initializeCounterpart(chunkQueueManager.rpc!, {
      chunkQueueManager: chunkQueueManager.rpcId,
    });
  }

  /**
   * Returns the chunk source with `key`.  The first time, it is created with `create` together with
   * its worker counterpart; later calls add a reference to the same source.
   */
  getChunkSource<T extends ChunkSource>(key: string, create: () => T): T {
    let source = this.chunkSources.get(key) as T | undefined;
    if (source === undefined) {
      source = create();
      source.initializeCounterpart(this.rpc!, {});
      source.registerDisposer(() => this.chunkSources.delete(key));
      this.chunkSources.set(key, source);
    } else {
      source.addRef();
    }
    return source;
  }
}

export class ChunkSource extends SharedObject {
  chunks = new Map<string, Chunk>();

  constructor(
    public chunkManager: Borrowed<ChunkManager>,
    _options: object = {},
  ) {
    super();
  }

  initializeCounterpart(rpc: RPC, options: any) {
    options.chunkManager = this.chunkManager.rpcId;
    super.initializeCounterpart(rpc, options);
  }

  get gl() {
    return this.chunkManager.chunkQueueManager.gl;
  }

  deleteChunk(key: string) {
    const chunk = this.chunks.get(key)!;
    if (chunk.state === ChunkState.GPU_MEMORY) {
      chunk.freeGPUMemory(this.gl);
    }
    this.chunks.delete(key);
  }

  addChunk(key: string, chunk: Chunk) {
    this.chunks.set(key, chunk);
  }

  // Asks the worker to discard the chunk with key `key` and download it again, e.g. once its file
  // has been added to the store.
  reloadChunk(key: string) {
    this.rpc!.invoke(CHUNK_RELOAD_RPC_ID, { source: this.rpcId, key });
  }

  // Defined by subclasses: builds the main-thread chunk from a `Chunk.update` message.
  getChunk(_x: any): Chunk {
    throw new Error("Not implemented.");
  }
}

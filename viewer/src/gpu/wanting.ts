/**
 * @file What a flattening asks the scan for.
 *
 * A cross-section works its own chunks out: its geometry is a plane, and the chunks a plane cuts
 * fall out of the arithmetic.  A flattening cannot — the shape of the sheet IS the march, which is
 * computed in the page's own worker and is a table of a couple of hundred thousand positions, and
 * sending that here so this thread could intersect it would be sending the expensive thing to the
 * cheap question.
 *
 * So the question is answered where the answer already lives.  The card's own worker says which
 * chunks the sheet lands in; this holds that list, asks the chunk queue for exactly those, and says
 * when they have arrived — which is what lets a card keep the march it is drawing until the next
 * one can actually be drawn (`field.ts`).
 */
import { ChunkState } from "#src/chunk_manager/base.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { SURFACE_VIEW_RPC_ID, SURFACE_VIEW_WANT_RPC_ID } from "#src/render/base.js";
import type { VolumeChunkSource } from "#src/render/frontend.js";
import type { RenderLayer } from "#src/render/renderlayer.js";
import type { WatchableValueInterface } from "#src/state/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import { SharedWatchableValue } from "#src/worker/shared_watchable_value.js";
import { SharedObject } from "#src/worker/worker_rpc.js";

/** Which chunks of which scale the sheet lands in, as the card's own worker worked them out. */
export interface Wanted {
  level: number;
  // How many voxels of the full-resolution scan one of this scale's voxels covers.
  factor: number;
  // Chunk grid positions, three to a chunk, nearest the middle of the card first.
  chunks: Float32Array;
}

interface Asked {
  source: VolumeChunkSource;
  positions: Float32Array;
}

export class Wanting extends RefCounted {
  private shared: SharedObject;
  private asked: Asked[] = [];

  constructor(
    chunkManager: ChunkManager,
    private layer: WatchableValueInterface<RenderLayer | undefined>,
    visibility: WatchableValueInterface<number>,
  ) {
    super();
    const shared = (this.shared = this.registerDisposer(new SharedObject()));
    shared.RPC_TYPE_ID = SURFACE_VIEW_RPC_ID;
    shared.initializeCounterpart(chunkManager.rpc!, {
      chunkManager: chunkManager.rpcId,
      visibility: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(chunkManager.rpc!, visibility),
      ).rpcId,
    });
    this.chunkManager = chunkManager;
  }

  private chunkManager!: ChunkManager;

  /** Says which chunks the sheet lands in.  The worker then asks for exactly those. */
  want(wanted: Wanted[]) {
    const sources = this.layer.value?.getSources();
    if (sources === undefined) return;
    const asked: Asked[] = [];
    const toWorker: { source: number; positions: ArrayBuffer }[] = [];
    for (const { level, chunks } of wanted) {
      const source = sources[level]?.chunkSource as VolumeChunkSource | undefined;
      if (source === undefined) continue;
      asked.push({ source, positions: chunks });
      toWorker.push({ source: source.rpcId!, positions: chunks.slice().buffer });
    }
    this.asked = asked;
    this.chunkManager.rpc!.invoke(SURFACE_VIEW_WANT_RPC_ID, {
      id: this.shared.rpcId,
      wanted: toWorker,
    });
  }

  /**
   * Whether every chunk of the finest scale asked for has arrived.
   *
   * Asked at the moment it is wanted, never remembered: a chunk arrives long after it was asked for,
   * and an answer taken when the asking happened is an answer about nothing.
   */
  settled(): boolean {
    const finest = this.asked[0];
    if (finest === undefined) return false;
    const { source, positions } = finest;
    for (let at = 0; at + 2 < positions.length; at += 3) {
      const chunk = source.chunks.get(
        `${positions[at]},${positions[at + 1]},${positions[at + 2]}`,
      );
      /*
       * A chunk the store does not have reaches GPU_MEMORY with nothing in it — the volume is
       * sparse — so "arrived" has to mean the state, not the data.
       */
      if (chunk === undefined || chunk.state !== ChunkState.GPU_MEMORY) return false;
    }
    return true;
  }
}

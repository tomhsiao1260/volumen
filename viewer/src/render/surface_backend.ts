/**
 * @file The worker half of a surface view: what a flattening asks the scan for.
 *
 * A cross-section works its own chunks out — its geometry is a plane, and the chunks a plane cuts
 * fall out of the arithmetic (`forEachPlaneIntersectingVolumetricChunk`).  A flattening cannot: the
 * shape of the sheet IS the march, which is computed in a different worker and is a table of a
 * couple of hundred thousand positions.  Sending that table here so this thread could intersect it
 * would be sending the expensive thing to the cheap question.
 *
 * So the question is answered where the answer already lives.  The card's own worker walks the sheet
 * and says which chunks it lands in; this holds that list and asks for exactly those, at the tier
 * the card's visibility earns.  Getting it wrong is quiet — the sheet would be drawn from whatever
 * chunks happened to be resident for some other card and would never sharpen — so the list is the
 * one thing a test should hold against what is drawn.
 */
import { ChunkPriorityTier } from "#src/chunk_manager/base.js";
import type { ChunkManager } from "#src/chunk_manager/backend.js";
import { SURFACE_VIEW_RPC_ID, SURFACE_VIEW_WANT_RPC_ID } from "#src/render/base.js";
import type { VolumeChunkSource } from "#src/render/backend.js";
import type { SharedWatchableValue } from "#src/worker/shared_watchable_value.js";
import type { RPC } from "#src/worker/worker_rpc.js";
import {
  registerRPC,
  registerSharedObject,
  SharedObjectCounterpart,
} from "#src/worker/worker_rpc.js";

// Lower than a cross-section's, which starts at -1e12: a card that is looking at one place wants its
// own chunks before it wants a flattening's.  Within a list, earlier is nearer the middle.
const BASE_PRIORITY = -2e12;

interface Wanted {
  source: VolumeChunkSource;
  // Chunk grid positions, three to a chunk.
  positions: Float32Array;
}

@registerSharedObject(SURFACE_VIEW_RPC_ID)
export class SurfaceViewBackend extends SharedObjectCounterpart {
  chunkManager: ChunkManager;
  visibility: SharedWatchableValue<number>;
  wanted: Wanted[] = [];

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.chunkManager = rpc.get(options.chunkManager);
    this.visibility = rpc.get(options.visibility);
    this.registerDisposer(
      this.visibility.changed.add(() => {
        this.chunkManager.scheduleUpdateChunkPriorities();
      }),
    );
    this.registerDisposer(
      this.chunkManager.recomputeChunkPriorities.add(() => {
        this.updateChunkPriorities();
      }),
    );
  }

  updateChunkPriorities() {
    const visibility = this.visibility.value;
    // Off the board entirely: ask for nothing, as a cross-section does.
    if (visibility === Number.NEGATIVE_INFINITY) return;
    const tier =
      visibility === Number.POSITIVE_INFINITY
        ? ChunkPriorityTier.VISIBLE
        : ChunkPriorityTier.PREFETCH;
    const { chunkManager } = this;
    for (const { source, positions } of this.wanted) {
      for (let at = 0; at + 2 < positions.length; at += 3) {
        const chunk = source.getChunk(positions.subarray(at, at + 3));
        // Earlier in the list is nearer the middle of the card, so it is worth more.
        chunkManager.requestChunk(chunk, tier, BASE_PRIORITY - at);
      }
    }
  }
}

registerRPC(SURFACE_VIEW_WANT_RPC_ID, function (x) {
  const view = <SurfaceViewBackend>this.get(x.id);
  view.wanted = (x.wanted as any[]).map((one) => ({
    source: <VolumeChunkSource>this.get(one.source),
    positions: new Float32Array(one.positions),
  }));
  view.chunkManager.scheduleUpdateChunkPriorities();
});

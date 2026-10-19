/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * @file The layer a view draws: a volume's scales, and the worker counterpart that chooses chunks.
 *
 * This used to be the render layer, which also drew — for each visible chunk, the polygon where the
 * cross-section cut the chunk's box, with that chunk's own texture bound.  The drawing is gone (a
 * card is drawn once, out of one atlas, in `gpu/`), and what is left is what the ASKING needs: which
 * scales there are, how fine a scale to ask for, and the counterpart in the worker
 * (`SliceViewRenderLayerBackend`) that is told both.
 */

import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { SLICEVIEW_RENDERLAYER_RPC_ID } from "#src/render/base.js";
import type {
  MultiscaleVolumeChunkSource,
  SliceViewSingleResolutionSource,
} from "#src/render/frontend.js";
import type { WatchableValueInterface } from "#src/state/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import { SharedWatchableValue } from "#src/worker/shared_watchable_value.js";
import type { RpcId } from "#src/worker/worker_rpc.js";
import { SharedObject } from "#src/worker/worker_rpc.js";

/** What a view needs of the thing it shows. */
export interface RenderLayer extends RefCounted {
  rpcId: RpcId | null;
  renderScaleTarget: WatchableValueInterface<number>;
  getSources(): SliceViewSingleResolutionSource[];
}

export interface VolumeLayerOptions {
  renderScaleTarget: WatchableValueInterface<number>;
}

/** One volume as a layer: its scales, finest first, and how fine a one to ask for. */
export class VolumeLayer extends RefCounted implements RenderLayer {
  rpcId: RpcId | null = null;
  chunkManager: ChunkManager;
  renderScaleTarget: WatchableValueInterface<number>;

  constructor(
    public multiscaleSource: MultiscaleVolumeChunkSource,
    options: VolumeLayerOptions,
  ) {
    super();
    this.chunkManager = multiscaleSource.chunkManager;
    this.renderScaleTarget = options.renderScaleTarget;
    this.initializeCounterpart();
  }

  getSources() {
    return this.multiscaleSource.getSources();
  }

  get dataType() {
    return this.multiscaleSource.dataType;
  }

  // Creates the worker counterpart (`SliceViewRenderLayerBackend`), sharing the values the worker
  // needs to choose chunks.
  private initializeCounterpart() {
    const sharedObject = this.registerDisposer(new SharedObject());
    const rpc = this.chunkManager.rpc!;
    sharedObject.RPC_TYPE_ID = SLICEVIEW_RENDERLAYER_RPC_ID;
    sharedObject.initializeCounterpart(rpc, {
      renderScaleTarget: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(rpc, this.renderScaleTarget),
      ).rpcId,
    });
    this.rpcId = sharedObject.rpcId;
  }
}

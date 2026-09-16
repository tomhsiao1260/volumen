/** @license Copyright 2020 Google Inc. SPDX-License-Identifier: Apache-2.0 */

import {
  MISSING_CHUNK_RPC_ID,
  VolumeChunkSourceParameters,
} from "#src/datasource/zarr/base.js";
import { decodeChunk } from "#src/datasource/zarr/decode.js";
import { createZarrStore } from "#src/datasource/zarr/store.js";
import type { VolumeChunk } from "#src/render/backend.js";
import { VolumeChunkSource } from "#src/render/backend.js";
import type { RPC } from "#src/worker/worker_rpc.js";
import { registerSharedObject } from "#src/worker/worker_rpc.js";

/**
 * Worker side of one scale of a zarr volume.  The chunk manager calls `download` for each chunk it
 * decides to load: the chunk file is read from the store and decoded into `chunk.data`.  A chunk
 * missing from the store keeps `data === null` and is drawn with the fill value; the main thread is
 * told about it, and may add the file and ask for the chunk again.  If the file cannot be read or
 * decoded, `download` rejects: the chunk fails and is not drawn, so coarser scales show through.
 */
@registerSharedObject(VolumeChunkSourceParameters.RPC_ID)
export class ZarrVolumeChunkSource extends VolumeChunkSource {
  parameters: VolumeChunkSourceParameters;
  private store;

  constructor(rpc: RPC, options: any) {
    super(rpc, options);
    this.parameters = options.parameters;
    this.store = createZarrStore(this.parameters.store);
  }

  async download(chunk: VolumeChunk, signal: AbortSignal) {
    const { metadata, path } = this.parameters;
    // The chunk grid position is in (x, y, z) order, while zarr chunk keys list the chunk indices in
    // (z, y, x) order, e.g. `52/24/18`.
    const key = `${path}/${Array.from(chunk.chunkGridPosition)
      .reverse()
      .join(metadata.dimensionSeparator)}`;
    // Once the download is cancelled, the chunk object may be reused for another chunk, so after
    // each step the download stops if `signal` was aborted, before touching the chunk.
    const data = await this.store.get(key, signal);
    signal.throwIfAborted();
    if (data === undefined) {
      this.rpc!.invoke(MISSING_CHUNK_RPC_ID, {
        source: this.rpcId,
        chunk: chunk.key,
        key,
      });
      return;
    }
    const decoded = await decodeChunk(metadata, data, signal);
    signal.throwIfAborted();
    chunk.data = decoded;
  }
}

/** @license Copyright 2020 Google Inc. SPDX-License-Identifier: Apache-2.0 */

import type { ArrayMetadata } from "#src/datasource/zarr/metadata.js";
import type { ZarrStoreSpec } from "#src/datasource/zarr/store.js";

export class VolumeChunkSourceParameters {
  // The store holding the volume.
  store!: ZarrStoreSpec;
  // Path of this scale's array within the store, e.g. `0`.
  path!: string;
  metadata!: ArrayMetadata;
  static RPC_ID = "zarr/VolumeChunkSource";
}

// Sent by the worker for each chunk whose file is not in the store.
export const MISSING_CHUNK_RPC_ID = "zarr/missingChunk";

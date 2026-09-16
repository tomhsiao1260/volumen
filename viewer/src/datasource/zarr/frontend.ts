/** @license Copyright 2020 Google Inc. SPDX-License-Identifier: Apache-2.0 */

import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import {
  MISSING_CHUNK_RPC_ID,
  VolumeChunkSourceParameters,
} from "#src/datasource/zarr/base.js";
import type { ArrayMetadata } from "#src/datasource/zarr/metadata.js";
import { parseV2Metadata } from "#src/datasource/zarr/metadata.js";
import type {
  OmeMultiscaleMetadata,
  OmeMultiscaleScale,
} from "#src/datasource/zarr/ome.js";
import { parseOmeMetadata } from "#src/datasource/zarr/ome.js";
import type { ZarrStore, ZarrStoreSpec } from "#src/datasource/zarr/store.js";
import { createZarrStore } from "#src/datasource/zarr/store.js";
import type { VolumeChunkSpecification } from "#src/render/base.js";
import { makeVolumeChunkSpecification } from "#src/render/base.js";
import type { SliceViewSingleResolutionSource } from "#src/render/frontend.js";
import {
  MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource,
  VolumeChunkSource,
} from "#src/render/frontend.js";
import { DataType } from "#src/util/data_type.js";
import type { Borrowed } from "#src/util/disposable.js";
import { verifyObject } from "#src/util/json.js";
import { Signal } from "#src/util/signal.js";
import type { RPC } from "#src/worker/worker_rpc.js";
import {
  registerRPC,
  registerSharedObjectOwner,
} from "#src/worker/worker_rpc.js";

// Called with the store key of a chunk whose file is missing, and a function that loads the chunk
// again.
type MissingChunkListener = (key: string, reload: () => void) => void;

@registerSharedObjectOwner(VolumeChunkSourceParameters.RPC_ID)
class ZarrVolumeChunkSource extends VolumeChunkSource {
  parameters: VolumeChunkSourceParameters;
  missingChunk = new Signal<MissingChunkListener>();

  constructor(
    chunkManager: Borrowed<ChunkManager>,
    options: { spec: VolumeChunkSpecification; parameters: VolumeChunkSourceParameters },
  ) {
    super(chunkManager, options);
    this.parameters = options.parameters;
  }

  initializeCounterpart(rpc: RPC, options: any) {
    options.parameters = this.parameters;
    super.initializeCounterpart(rpc, options);
  }
}

registerRPC(MISSING_CHUNK_RPC_ID, function (x) {
  const source = this.get(x.source) as ZarrVolumeChunkSource | undefined;
  if (source === undefined) return;
  source.missingChunk.dispatch(x.key, () => source.reloadChunk(x.chunk));
});

interface ZarrScaleInfo extends OmeMultiscaleScale {
  metadata: ArrayMetadata;
}

interface ZarrMultiscaleInfo {
  store: ZarrStoreSpec;
  // Bounds of the volume in voxels of the full-resolution scale, in zarr (z, y, x) order.
  lowerBounds: Float64Array;
  upperBounds: Float64Array;
  dataType: DataType;
  scales: ZarrScaleInfo[];
}

// Distinguishes the chunk sources of the volumes loaded into one viewer (see `getSources`).
let nextVolumeId = 0;

export class MultiscaleVolumeChunkSource extends GenericMultiscaleVolumeChunkSource {
  // Reports the missing chunks of every scale.
  missingChunk = new Signal<MissingChunkListener>();

  private id = nextVolumeId++;

  get dataType() {
    return this.multiscale.dataType;
  }

  get lowerBounds() {
    return this.multiscale.lowerBounds;
  }

  get upperBounds() {
    return this.multiscale.upperBounds;
  }


  constructor(
    chunkManager: Borrowed<ChunkManager>,
    public multiscale: ZarrMultiscaleInfo,
  ) {
    super(chunkManager);
  }

  // Returns the chunk source of each scale, finest first, with the transform from its chunk grid to
  // the viewer's coordinates.  The chunk sources run their `download` in the worker (see
  // `datasource/zarr/backend.ts`).
  getSources() {
    return this.multiscale.scales.map(
      (scale): SliceViewSingleResolutionSource => {
        const { metadata } = scale;
        const { rank, chunkShape, shape } = metadata;
        // Zarr lists dimensions in (z, y, x) order; chunk space uses the reverse order, (x, y, z),
        // which matches C-order voxel data where x varies fastest.  The transform from chunk space
        // to the viewer's coordinates therefore scales chunk dimension `i` onto zarr dimension
        // `rank - 1 - i`; it is stored column-major, as a homogeneous matrix.
        const chunkShapeXyz = new Uint32Array(rank);
        const shapeXyz = new Float32Array(rank);
        const transform = new Float32Array((rank + 1) ** 2);
        transform[(rank + 1) ** 2 - 1] = 1;
        for (let i = 0; i < rank; ++i) {
          const zarrDim = rank - 1 - i;
          chunkShapeXyz[i] = chunkShape[zarrDim];
          shapeXyz[i] = shape[zarrDim];
          transform[i * (rank + 1) + zarrDim] = scale.scale[zarrDim];
          transform[rank * (rank + 1) + zarrDim] = scale.translation[zarrDim];
        }
        const spec = makeVolumeChunkSpecification({
          rank,
          dataType: metadata.dataType,
          chunkDataSize: chunkShapeXyz,
          upperVoxelBound: shapeXyz,
          fillValue: metadata.fillValue,
        });
        // Every call (one per view) returns the same chunk source for a scale, so views of one
        // volume share its chunks.  The scale's path alone would not identify the source: the scales
        // of two volumes are both named `0`, `1`, ..., and their chunk sources must not be shared.
        const options = {
          spec,
          parameters: { store: this.multiscale.store, path: scale.path, metadata },
        };
        const chunkSource = this.chunkManager.getChunkSource(
          `zarr:${this.id}:${scale.path}`,
          () => new ZarrVolumeChunkSource(this.chunkManager, options),
        );
        // Adding a listener that is already added has no effect.
        chunkSource.missingChunk.add(this.missingChunk.dispatch);
        return { chunkSource, chunkToMultiscaleTransform: transform };
      },
    );
  }
}

// Reads and parses the JSON file at `key`, or returns `undefined` if the store has no such file.
async function readJson(store: ZarrStore, key: string): Promise<any> {
  const data = await store.get(key);
  if (data === undefined) return undefined;
  return JSON.parse(new TextDecoder().decode(data));
}

async function resolveOmeMultiscale(
  storeSpec: ZarrStoreSpec,
  store: ZarrStore,
  multiscale: OmeMultiscaleMetadata,
): Promise<ZarrMultiscaleInfo> {
  const scaleZarrMetadata: ArrayMetadata[] = await Promise.all(
    multiscale.scales.map(async (scale) =>
      parseV2Metadata(await readJson(store, `${scale.path}/.zarray`)),
    ),
  );
  const dataType = scaleZarrMetadata[0].dataType;
  const numScales = scaleZarrMetadata.length;
  const { rank } = multiscale;
  for (let i = 0; i < numScales; ++i) {
    const scale = multiscale.scales[i];
    const zarrMetadata = scaleZarrMetadata[i];
    if (zarrMetadata.rank !== rank) {
      throw new Error(
        `Expected zarr array at ${JSON.stringify(
          scale.path,
        )} to have rank ${rank}, ` + `but received: ${zarrMetadata.rank}`,
      );
    }
    if (zarrMetadata.dataType !== dataType) {
      throw new Error(
        `Expected zarr array at ${JSON.stringify(
          scale.path,
        )} to have data type ` +
          `${DataType[dataType]}, but received: ${
            DataType[zarrMetadata.dataType]
          }`,
      );
    }
  }

  // The volume starts at the position of the full-resolution scale's first voxel (-0.5 for OME's
  // voxel-center convention) and spans its shape.
  const lowerBounds = new Float64Array(rank);
  const upperBounds = new Float64Array(rank);
  const baseScale = multiscale.scales[0];
  const baseZarrMetadata = scaleZarrMetadata[0];
  for (let i = 0; i < rank; ++i) {
    const lower = (lowerBounds[i] = baseScale.translation[i]);
    upperBounds[i] = lower + baseZarrMetadata.shape[i];
  }

  return {
    store: storeSpec,
    lowerBounds,
    upperBounds,
    dataType,
    scales: multiscale.scales.map((scale, i) => ({
      ...scale,
      metadata: scaleZarrMetadata[i],
    })),
  };
}

/**
 * Loads an OME-Zarr (zarr v2) multiscale volume from `storeSpec`: reads `.zattrs` for the list of
 * scales, then the `.zarray` of every scale.
 */
export async function loadZarrVolume(
  chunkManager: ChunkManager,
  storeSpec: ZarrStoreSpec,
): Promise<MultiscaleVolumeChunkSource> {
  const store = createZarrStore(storeSpec);
  const multiscale = parseOmeMetadata(
    verifyObject(await readJson(store, ".zattrs")),
  );
  return new MultiscaleVolumeChunkSource(
    chunkManager,
    await resolveOmeMultiscale(storeSpec, store, multiscale),
  );
}

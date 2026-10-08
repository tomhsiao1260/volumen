/**
 * @file One scan, answering the atlas.
 *
 * Everything above this — asking for chunks, deciding which are worth having, dropping the ones that
 * are not, reading zarr, decoding blosc — is the library as it was, and none of it knows what a GPU
 * is.  What changed is where a chunk goes, and when.
 *
 * It goes nowhere when it arrives.  It sits in memory until the shader says it wanted a page of it
 * and did not find one, and then that page alone is written.  The reason is arithmetic: a
 * full-resolution chunk of these scans is 256 voxels a side — sixty-four pages — and a sheet cutting
 * through one touches two or three of them.  Writing all sixty-four filled the atlas with papyrus
 * nobody was looking at, and the card a person *was* looking at lost its pages to make the room.
 *
 * The shader is the only thing that knows what is really being drawn, so the shader is asked.
 */
import { PAGE } from "#src/gpu/atlas.js";
import type { Atlas } from "#src/gpu/atlas.js";
import { putPage } from "#src/gpu/feed.js";
import type { Scale } from "#src/gpu/slice.js";
import type {
  SliceViewSingleResolutionSource,
  VolumeChunk,
  VolumeChunkSource,
} from "#src/render/frontend.js";
import type { Volume } from "#src/viewer.js";
import { RefCounted } from "#src/util/disposable.js";

export class Scan extends RefCounted {
  /** Finest first, as the renderer wants them. */
  readonly scales: Scale[] = [];
  private readonly levels: VolumeChunkSource[] = [];

  constructor(
    private atlas: Atlas,
    /** Which scan this is, as the atlas's keys count them. */
    readonly source: number,
    volume: Volume,
  ) {
    super();
    const layer = volume.renderLayer.value;
    if (layer === undefined) throw new Error("A scan can only be made once its volume has loaded.");
    const sources: SliceViewSingleResolutionSource[] = layer.getSources();
    // The x scale of each level against the finest, which is what "how many full-resolution voxels
    // is one of these" means.  The transform is column-major and x is the last zarr dimension.
    const finest = sources[0].chunkToMultiscaleTransform[2];
    sources.forEach((one: SliceViewSingleResolutionSource, level: number) => {
      this.scales.push({ level, factor: one.chunkToMultiscaleTransform[2] / finest });
      const from = one.chunkSource as VolumeChunkSource;
      this.levels.push(from);
      /*
       * A chunk arriving puts nothing anywhere; it is in memory now, which is all the queue above
       * means by its GPU tier.  What it holds goes up a page at a time, when a page is asked for.
       */
      from.feed = () => {};
      /*
       * A chunk leaving takes its pages with it.  One eviction policy, and it is the queue's: it
       * knows what every card wants, at what priority, and how visible each card is.  The atlas
       * cannot see any of that — the lookup happens on the GPU — so it does as it is told.
       */
      from.drop = (chunk) => this.give(level, from, chunk);
      this.registerDisposer(() => {
        from.feed = undefined;
        from.drop = undefined;
      });
    });
  }

  /**
   * Answers the pages the shader said it wanted and could not find.
   *
   * `asked` is the whole miss table, two words a key at the key's own hash, zero where nothing was
   * asked.  A page whose chunk has not been downloaded yet is passed over: the queue above is
   * already fetching it, and the shader will ask again next frame.
   */
  answer(asked: Uint32Array): number {
    let put = 0;
    for (let i = 0; i + 1 < asked.length; i += 2) {
      const lo = asked[i], hi = asked[i + 1];
      if (lo === 0 && hi === 0) continue;
      if ((hi & 255) !== this.source) continue;
      const level = (hi >> 8) & 15;
      const from = this.levels[level];
      if (from === undefined) continue;
      const at: [number, number, number] = [lo & 1023, (lo >> 10) & 1023, (lo >> 20) & 1023];
      if (this.atlas.has({ source: this.source, level, at })) continue;
      const size = from.spec.chunkDataSize;
      const grid = [
        Math.floor((at[0] * PAGE) / size[0]),
        Math.floor((at[1] * PAGE) / size[1]),
        Math.floor((at[2] * PAGE) / size[2]),
      ];
      const chunk = from.chunks.get(grid.join(",")) as VolumeChunk | undefined;
      const data = chunk?.data;
      if (data == null) continue;
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (putPage(this.atlas, this.source, level, at, grid, size, bytes)) put++;
    }
    return put;
  }

  private give(level: number, from: VolumeChunkSource, chunk: VolumeChunk) {
    const size = from.spec.chunkDataSize;
    const pages = [size[0] / PAGE, size[1] / PAGE, size[2] / PAGE];
    const grid = chunk.chunkGridPosition;
    for (let pz = 0; pz < pages[2]; pz++)
      for (let py = 0; py < pages[1]; py++)
        for (let px = 0; px < pages[0]; px++) {
          this.atlas.remove({
            source: this.source,
            level,
            at: [grid[0] * pages[0] + px, grid[1] * pages[1] + py, grid[2] * pages[2] + pz],
          });
        }
  }
}

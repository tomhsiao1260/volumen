/**
 * @file One scan, feeding the atlas.
 *
 * Everything above this — asking for chunks, deciding which are worth having, dropping the ones
 * that are not, reading zarr, decoding blosc — is the library as it was, and none of it knows what
 * a GPU is.  This is where its output is pointed somewhere new: a chunk that used to become a
 * texture of its own becomes some pages of the one atlas.
 */
import type { Atlas } from "#src/gpu/atlas.js";
import { PAGE } from "#src/gpu/atlas.js";
import { putChunk } from "#src/gpu/feed.js";
import type { Arrived } from "#src/gpu/feed.js";
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
  /*
   * Chunks that arrived before the atlas's texture existed.
   *
   * three.js makes a texture on the GPU when it is first drawn with, so the first chunks of a
   * session land before there is anywhere to put them.  They are held and offered again rather than
   * dropped, because a dropped chunk is not asked for twice — the queue above believes it is on the
   * GPU — and the card would simply never fill in.
   */
  private waiting: Arrived[] = [];

  constructor(
    private atlas: Atlas,
    /** Which scan this is, as the atlas's keys count them. */
    readonly source: number,
    volume: Volume,
  ) {
    super();
    /*
     * The volume's layer arrives after its metadata does, so a `Scan` is only worth making once
     * `volume.loaded` has settled — which is also when the scales are known.
     */
    const layer = volume.renderLayer.value;
    if (layer === undefined) throw new Error("A scan can only be made once its volume has loaded.");
    const sources: SliceViewSingleResolutionSource[] = layer.getSources();
    // The x scale of each level against the finest, which is what "how many full-resolution voxels
    // is one of these" means.  The transform is column-major and x is the last zarr dimension.
    const finest = sources[0].chunkToMultiscaleTransform[2];
    sources.forEach((one: SliceViewSingleResolutionSource, level: number) => {
      this.scales.push({
        level,
        factor: one.chunkToMultiscaleTransform[2] / finest,
      });
      const from = one.chunkSource as VolumeChunkSource;
      from.feed = (chunk) => this.take(level, from, chunk);
      /*
       * A chunk leaving the queue takes its pages with it.
       *
       * One eviction policy, and it is the queue's: it knows what every card wants, at what
       * priority, and how visible each card is.  Letting the atlas decide as well meant two
       * policies disagreeing — and since the lookup happens on the GPU, the atlas cannot see what
       * is being read and was dropping by age, so a card sitting still lost its pages to a card
       * streaming past it.
       */
      from.drop = (chunk) => this.give(level, from, chunk);
      this.registerDisposer(() => {
        from.feed = undefined;
        from.drop = undefined;
      });
    });
  }

  private take(level: number, from: VolumeChunkSource, chunk: VolumeChunk) {
    const data = chunk.data;
    if (data === null) return;
    const arrived: Arrived = {
      source: this.source,
      level,
      grid: chunk.chunkGridPosition,
      size: from.spec.chunkDataSize,
      data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    };
    if (!putChunk(this.atlas, arrived)) this.waiting.push(arrived);
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

  /** Offers again whatever could not be written yet.  Called once a frame; usually does nothing. */
  settle() {
    if (this.waiting.length === 0) return;
    const again = this.waiting;
    this.waiting = [];
    for (const arrived of again) {
      if (!putChunk(this.atlas, arrived)) this.waiting.push(arrived);
    }
  }
}

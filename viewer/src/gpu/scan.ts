/**
 * @file One scan, feeding the atlas.
 *
 * Everything above this — asking for chunks, deciding which are worth having, dropping the ones that
 * are not, reading zarr, decoding blosc — is the library as it was, and none of it knows what a GPU
 * is.  What changed is where a chunk goes, and when.
 *
 * A chunk arriving goes up as PAGES, and only the pages somebody is looking at.  The reason is
 * arithmetic: a full-resolution chunk of these scans is 256 voxels a side — sixty-four pages — and a
 * sheet or a slice cutting through one touches a handful of them.  Writing all sixty-four filled the
 * atlas with papyrus nobody was looking at, and the card a person *was* looking at lost its pages to
 * make the room.
 *
 * Who is looking is said two ways:
 *
 *   - A view whose geometry is known on this thread — a cross-section is a rectangle — places an
 *     ORDER for the pages it cuts (`pages.ts`).  Those go up the moment they can: when the order is
 *     placed, if the chunk is here, and when the chunk arrives, if the order is.  A view's first frame
 *     after a move has its pages, and a chunk that has just arrived is on the card in the same tick.
 *   - A view whose geometry only a worker knows — papyrus laid flat is a march of a couple of hundred
 *     thousand positions — is drawn, and the shader says which pages it wanted and did not find
 *     (`sample.ts`).  Those are read back and ANSWERED a frame or two later.
 *
 * The coarse scales are held whole: a chunk of them is one page, and they are what every pixel falls
 * back to while the page it really wants is on its way.
 */
import { PAGE } from "#src/gpu/atlas.js";
import type { Atlas, Page } from "#src/gpu/atlas.js";
import { putPage } from "#src/gpu/feed.js";
import type { Order } from "#src/gpu/pages.js";
import { unpackPage } from "#src/gpu/pages.js";
import type { Scale } from "#src/gpu/slice.js";
import { ChunkState } from "#src/chunk_manager/base.js";
import type {
  SliceViewSingleResolutionSource,
  VolumeChunk,
  VolumeChunkSource,
} from "#src/render/frontend.js";
import type { RenderLayer } from "#src/render/layer.js";
import { RefCounted } from "#src/util/disposable.js";

/*
 * From this many full-resolution voxels to a voxel, a scale is held whole rather than a page at a
 * time.  Eight is three levels down, where a card's worth of scroll is a handful of chunks.
 */
const EAGER = 8;
/*
 * How many of the pages a view is heading for — the ones a page further along its normal — go up
 * in one go.  They are not needed yet, and a page is a quarter of a megabyte: a step across a page
 * boundary wants thirty or so of them, and writing all of those in the frame the step happens is a
 * hitch where there need not be one.
 */
const NEAR_PER_TICK = 6;

export class Scan extends RefCounted {
  /** Finest first, as the renderer wants them. */
  readonly scales: Scale[] = [];
  private readonly levels: VolumeChunkSource[] = [];
  // Each view's standing order, by level; and their union, which is what a chunk arriving is held
  // against.
  private readonly orders = new Map<object, Map<number, Order>>();
  private wanted = new Map<number, Set<number>>();
  // The pages views are heading for, not yet written: `level * 2^30 + packed`, oldest first.
  private pending: number[] = [];
  private draining = false;

  constructor(
    private atlas: Atlas,
    /** Which scan this is, as the atlas's keys count them. */
    readonly source: number,
    layer: RenderLayer,
  ) {
    super();
    const sources: SliceViewSingleResolutionSource[] = layer.getSources();
    // The x scale of each level against the finest, which is what "how many full-resolution voxels
    // is one of these" means.  The transform is column-major and x is the last zarr dimension.
    const finest = sources[0].chunkToMultiscaleTransform[2];
    sources.forEach((one: SliceViewSingleResolutionSource, level: number) => {
      const from = one.chunkSource as VolumeChunkSource;
      const { upperVoxelBound } = from.spec;
      this.scales.push({
        level,
        factor: one.chunkToMultiscaleTransform[2] / finest,
        upper: [upperVoxelBound[0], upperVoxelBound[1], upperVoxelBound[2]],
      });
      this.levels.push(from);
      const eager = this.scales[level].factor >= EAGER;
      from.feed = (chunk) => this.arrived(level, from, chunk, eager);
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

  /** What the pager has done, for a measurement to look at. */
  readonly stats = { ordered: 0, offered: 0, written: 0, pending: 0 };

  /** How many voxels of its own a chunk of `level` is each way (x, y, z). */
  chunkSizeOf(level: number): [number, number, number] {
    const size = this.levels[level].spec.chunkDataSize;
    return [size[0], size[1], size[2]];
  }

  /**
   * A view's standing order: the pages it cuts now, per level, and the ones it is heading for.
   * Replaces the view's last order.  What can go up now goes up now.
   */
  order(who: object, orders: Map<number, Order>) {
    this.stats.ordered++;
    this.orders.set(who, orders);
    this.gather();
    for (const [level, { cut, near }] of orders) {
      for (const packed of cut) this.offer(level, packed, true);
      for (const packed of near) this.pending.push(level * 2 ** 30 + packed);
    }
    this.drain();
  }

  /** The view has gone, and so has its order. */
  forget(who: object) {
    if (this.orders.delete(who)) this.gather();
  }

  // The union of every order, by level.
  private gather() {
    const wanted = new Map<number, Set<number>>();
    for (const orders of this.orders.values())
      for (const [level, { cut, near }] of orders) {
        let set = wanted.get(level);
        if (set === undefined) wanted.set(level, (set = new Set()));
        for (const packed of cut) set.add(packed);
        for (const packed of near) set.add(packed);
      }
    this.wanted = wanted;
  }

  /*
   * The pages views are heading for, written a few at a time, between frames, until there are none.
   * A page that was written meanwhile — because its chunk arrived, or because a view reached it — is
   * passed over.
   */
  private drain() {
    if (this.draining || this.pending.length === 0) return;
    this.draining = true;
    const tick = () => {
      this.draining = false;
      if (this.wasDisposed) return;
      for (let n = 0; n < NEAR_PER_TICK && this.pending.length > 0; ) {
        const key = this.pending.shift()!;
        const level = Math.floor(key / 2 ** 30);
        const packed = key - level * 2 ** 30;
        // Still wanted by somebody, or the view has moved on since.
        if (!this.wanted.get(level)?.has(packed)) continue;
        if (this.offer(level, packed, false)) n++;
      }
      if (this.pending.length > 0) {
        this.draining = true;
        setTimeout(tick, 0);
      }
    };
    setTimeout(tick, 0);
  }

  /**
   * Puts one page in if it can: the page is not there yet, and its chunk is on the GPU as far as the
   * queue is concerned.  Answers whether anything was written.  A page already there is touched, so
   * that what is being looked at is not what the atlas drops.
   */
  private offer(level: number, packed: number, looking: boolean): boolean {
    this.stats.offered++;
    this.stats.pending = this.pending.length;
    const at = unpackPage(packed);
    const page: Page = { source: this.source, level, at };
    if (this.atlas.has(page)) {
      if (looking) this.atlas.touch(page);
      return false;
    }
    const from = this.levels[level];
    const size = from.spec.chunkDataSize;
    const grid = [
      Math.floor((at[0] * PAGE) / size[0]),
      Math.floor((at[1] * PAGE) / size[1]),
      Math.floor((at[2] * PAGE) / size[2]),
    ];
    const chunk = from.chunks.get(grid.join(",")) as VolumeChunk | undefined;
    if (chunk === undefined || chunk.state !== ChunkState.GPU_MEMORY) return false;
    // A chunk the store does not have: nothing to write, and the coarser scales answer for it.
    if (chunk.data === null) return false;
    const written = putPage(this.atlas, this.source, level, at, grid, size, chunk.data);
    if (written) this.stats.written++;
    return written;
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
      if (this.levels[level] === undefined) continue;
      if (this.offer(level, lo & ((1 << 30) - 1), false)) put++;
    }
    return put;
  }

  // The pages of a chunk, as the atlas counts them.
  private *pagesOf(level: number, from: VolumeChunkSource, chunk: VolumeChunk): Iterable<Page> {
    const size = from.spec.chunkDataSize;
    const pages = [size[0] / PAGE, size[1] / PAGE, size[2] / PAGE];
    const grid = chunk.chunkGridPosition;
    for (let pz = 0; pz < pages[2]; pz++)
      for (let py = 0; py < pages[1]; py++)
        for (let px = 0; px < pages[0]; px++) {
          yield {
            source: this.source,
            level,
            at: [grid[0] * pages[0] + px, grid[1] * pages[1] + py, grid[2] * pages[2] + pz],
          };
        }
  }

  /**
   * A chunk has reached the GPU, as far as the queue is concerned.  The pages of it somebody has
   * ordered go up now, and every page of a coarse chunk does.
   *
   * A chunk the store does not have puts nothing up.  It used to be marked in the table, page by
   * page, so that the shader would draw the fill there and stop asking — and a sparse scan has
   * thousands of such chunks, sixty-four pages each, which filled the table in a few hundred frames.
   * The coarser scales, held whole, answer for those places instead; where no scale has anything,
   * the pixel is the grey of nothing.
   */
  private arrived(level: number, from: VolumeChunkSource, chunk: VolumeChunk, eager: boolean) {
    const { data } = chunk;
    if (data === null) return;
    const wanted = this.wanted.get(level);
    const size = from.spec.chunkDataSize;
    const grid = chunk.chunkGridPosition;
    for (const page of this.pagesOf(level, from, chunk)) {
      if (!eager && !wanted?.has(page.at[0] | (page.at[1] << 10) | (page.at[2] << 20))) continue;
      if (this.atlas.has(page)) continue;
      putPage(this.atlas, this.source, level, page.at, grid, size, data);
    }
  }

  private give(level: number, from: VolumeChunkSource, chunk: VolumeChunk) {
    for (const page of this.pagesOf(level, from, chunk)) this.atlas.remove(page);
  }
}

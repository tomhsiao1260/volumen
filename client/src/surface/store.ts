/**
 * @file Chunks of uint8 zarr arrays, read through the server (`/api/data/<sourceId>/<key>`, which
 * downloads what it does not have yet) and kept decoded in memory — the scan's levels and Lasagna's
 * channels alike.  Runs in the surface worker.
 */

import Blosc from "numcodecs/blosc";

const codec = Blosc.fromConfig({ id: "blosc" });

// Decoded chunks kept for all arrays together, least recently used dropped first.
const BUDGET_BYTES = 128 * 1024 * 1024;
// Requests to the server at a time.  A browser opens six connections to one host, and the page needs
// some of them for itself — saving the board, listing sources — so this takes at most four.
const MAX_REQUESTS = 4;

let used = 0;
// Keyed by `array url` + chunk key, in order of last use.
const chunks = new Map<string, Uint8Array | null>();
const loading = new Map<string, Promise<void>>();
let active = 0;
const queue: (() => void)[] = [];

async function slot() {
  while (active >= MAX_REQUESTS) await new Promise<void>((resolve) => queue.push(resolve));
  active++;
}

function release() {
  active--;
  queue.shift()?.();
}

function remember(key: string, data: Uint8Array | null) {
  chunks.set(key, data);
  used += data?.byteLength ?? 0;
  for (const [old, value] of chunks) {
    if (used <= BUDGET_BYTES) break;
    chunks.delete(old);
    used -= value?.byteLength ?? 0;
  }
}

// Fetches `url`: its bytes, or null for a file neither the server nor the bucket has.  The server
// answers 503 while the bucket asks it to slow down, which is worth waiting through.
async function fetchBytes(url: string, signal?: AbortSignal): Promise<Uint8Array | null> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, { signal });
    if (response.status === 404) return null;
    if (response.ok) return new Uint8Array(await response.arrayBuffer());
    if (response.status !== 503 || attempt >= 8) {
      throw new Error(`${url} answered ${response.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** Math.min(attempt, 4)));
  }
}

export interface ArrayMeta {
  shape: [number, number, number];
  chunks: [number, number, number];
  compressed: boolean;
}

/**
 * One level of one array: `url` is the folder holding its `.zarray`, and `factor` how many voxels of
 * the full-resolution scan one of its voxels spans along each axis.
 */
export class ZarrLevel {
  private constructor(
    readonly url: string,
    readonly factor: number,
    readonly meta: ArrayMeta,
  ) {}

  static async open(url: string, factor: number) {
    const bytes = await fetchBytes(`${url}/.zarray`);
    if (bytes === null) throw new Error(`No array at ${url}`);
    const m = JSON.parse(new TextDecoder().decode(bytes));
    if (m.dtype !== "|u1") throw new Error(`${url}: ${m.dtype} is not supported`);
    if (m.shape?.length !== 3) throw new Error(`${url}: not a 3-D array`);
    if (m.order !== "C") throw new Error(`${url}: order ${m.order} is not supported`);
    if (m.compressor !== null && m.compressor?.id !== "blosc") {
      throw new Error(`${url}: compressor ${m.compressor?.id} is not supported`);
    }
    const separator = m.dimension_separator ?? ".";
    if (separator !== "/") throw new Error(`${url}: separator ${separator} is not supported`);
    return new ZarrLevel(url, factor, {
      shape: m.shape,
      chunks: m.chunks,
      compressed: m.compressor !== null,
    });
  }

  private key(cz: number, cy: number, cx: number) {
    return `${this.url}/${cz}/${cy}/${cx}`;
  }

  // The chunk's voxels, null for a chunk the store does not have (all zero), undefined if not loaded.
  get(cz: number, cy: number, cx: number) {
    const key = this.key(cz, cy, cx);
    const data = chunks.get(key);
    if (data !== undefined) {
      // Most recently used goes last.
      chunks.delete(key);
      chunks.set(key, data);
    }
    return data;
  }

  // Whether the chunk index is inside the array.
  inside(cz: number, cy: number, cx: number) {
    const [sz, sy, sx] = this.meta.shape, [kz, ky, kx] = this.meta.chunks;
    return cz >= 0 && cy >= 0 && cx >= 0 && cz * kz < sz && cy * ky < sy && cx * kx < sx;
  }

  load(cz: number, cy: number, cx: number, signal?: AbortSignal): Promise<void> {
    const key = this.key(cz, cy, cx);
    if (chunks.has(key)) return Promise.resolve();
    const pending = loading.get(key);
    if (pending !== undefined) return pending;
    const task = (async () => {
      await slot();
      try {
        const raw = await fetchBytes(key, signal);
        let data: Uint8Array | null = null;
        if (raw !== null) {
          data = this.meta.compressed ? ((await codec.decode(raw)) as Uint8Array) : raw;
          const [kz, ky, kx] = this.meta.chunks;
          if (data.length !== kz * ky * kx) throw new Error(`${key}: ${data.length} bytes`);
        }
        remember(key, data);
      } finally {
        release();
        loading.delete(key);
      }
    })();
    loading.set(key, task);
    return task;
  }

  /**
   * The chunks holding voxels of this level between `lo` and `hi` (inclusive, level voxels, z/y/x),
   * as [cz, cy, cx] triples.
   */
  chunksBetween(lo: number[], hi: number[]) {
    const [kz, ky, kx] = this.meta.chunks;
    const out: [number, number, number][] = [];
    const c0 = [Math.floor(lo[0] / kz), Math.floor(lo[1] / ky), Math.floor(lo[2] / kx)];
    const c1 = [Math.floor(hi[0] / kz), Math.floor(hi[1] / ky), Math.floor(hi[2] / kx)];
    for (let z = c0[0]; z <= c1[0]; z++)
      for (let y = c0[1]; y <= c1[1]; y++)
        for (let x = c0[2]; x <= c1[2]; x++) if (this.inside(z, y, x)) out.push([z, y, x]);
    return out;
  }

  async loadAll(list: [number, number, number][], signal?: AbortSignal) {
    await Promise.all(list.map(([z, y, x]) => this.load(z, y, x, signal)));
  }

  /**
   * Copies the voxels between `lo` and `hi` into a dense array, one chunk at a time: each chunk is
   * loaded, copied and then dropped again unless it was already in the store.  For an array whose
   * chunks are too big to hold together — the surface prediction's are 192³ or 256³, 7–17 MB each
   * decoded, and a card's worth of them would fill the whole store several times over.
   */
  async readBox(lo: number[], hi: number[], signal?: AbortSignal) {
    const box = this.chunksBetween(lo, hi);
    const out = empty(lo, hi);
    const at = { next: 0 };
    const one = async () => {
      while (at.next < box.length) {
        const [cz, cy, cx] = box[at.next++];
        const key = this.key(cz, cy, cx);
        const had = chunks.has(key);
        await this.load(cz, cy, cx, signal);
        this.copyChunkInto(out, lo, hi, cz, cy, cx);
        if (!had) {
          used -= chunks.get(key)?.byteLength ?? 0;
          chunks.delete(key);
        }
      }
    };
    // A few at a time: the waiting is on the network, but every one in flight is another chunk held.
    await Promise.all([one(), one(), one()]);
    return out;
  }

  /**
   * Copies the voxels between `lo` and `hi` (inclusive, level voxels) into a dense array, zero where
   * the array has nothing; the chunks must be loaded.
   */
  copyBox(lo: number[], hi: number[]) {
    const out = empty(lo, hi);
    for (const [cz, cy, cx] of this.chunksBetween(lo, hi)) {
      this.copyChunkInto(out, lo, hi, cz, cy, cx);
    }
    return out;
  }

  private copyChunkInto(out: Dense, lo: number[], hi: number[], cz: number, cy: number, cx: number) {
    const data = this.get(cz, cy, cx);
    if (!data) return;
    const [kz, ky, kx] = this.meta.chunks;
    const [, dy, dx] = out.dims;
    const z0 = Math.max(lo[0], cz * kz), z1 = Math.min(hi[0], cz * kz + kz - 1);
    const y0 = Math.max(lo[1], cy * ky), y1 = Math.min(hi[1], cy * ky + ky - 1);
    const x0 = Math.max(lo[2], cx * kx), x1 = Math.min(hi[2], cx * kx + kx - 1);
    for (let z = z0; z <= z1; z++)
      for (let y = y0; y <= y1; y++) {
        const from = ((z - cz * kz) * ky + (y - cy * ky)) * kx + (x0 - cx * kx);
        const to = ((z - lo[0]) * dy + (y - lo[1])) * dx + (x0 - lo[2]);
        out.data.set(data.subarray(from, from + x1 - x0 + 1), to);
      }
  }
}

// A box of voxels copied out of an array, all zero to begin with.
export interface Dense {
  data: Uint8Array;
  dims: [number, number, number];
}

function empty(lo: number[], hi: number[]): Dense {
  const dims: [number, number, number] = [hi[0] - lo[0] + 1, hi[1] - lo[1] + 1, hi[2] - lo[2] + 1];
  return { data: new Uint8Array(dims[0] * dims[1] * dims[2]), dims };
}

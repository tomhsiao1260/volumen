/**
 * @file The scan on the GPU: one texture for everything resident, and a table saying where each
 * piece of it went.
 *
 * What this replaces is a texture per chunk and a draw call per chunk, with the depth buffer used
 * as a stencil so that a coarse scale could not paint over a fine one.  That worked, but it ties
 * the shader to one chunk at a time: every pass covers the whole card and throws away the pixels
 * that fell outside the chunk it was given.  Here a card is drawn ONCE and each pixel looks up
 * whatever it needs.
 *
 * Three things fall out of that, and they are the reason for the change rather than the draw count:
 *
 *   - three.js binds a texture as a uniform of a material, so a texture per chunk means a material
 *     per chunk, and the WebGPU backend decides at build time whether a texture is sampled or
 *     loaded (mrdoob/three.js#34551).  One texture for everything sidesteps all of it.
 *   - Scales mix in the shader, by reading the finest page that is there.  The depth-as-stencil
 *     trick goes, and with it the rule that nothing else may write depth.
 *   - A sparse scroll costs nothing.  There is no page for a chunk that was never there, and the
 *     lookup simply says so, rather than a 1×1 texture being bound in its place.
 *
 * Pages are a fixed 64³ and have nothing to do with how the data is stored: the scans on disk are
 * chunked 256³ at full resolution and 64³ below it, so a chunk is cut into pages on the way in.
 * That decoupling is the point — the atlas does not care what the store does.
 */
import * as THREE from "three/webgpu";
import type { Device } from "#src/gpu/device.js";
import { RefCounted } from "#src/util/disposable.js";

/** The side of a page, in voxels of its own scale. */
export const PAGE = 64;
/*
 * The side of the atlas in voxels, and what that costs.
 *
 * A thousand pages of 64³, 262 MB — rather less than the 400 MB the chunk queue was given when every
 * chunk had a texture of its own.  The queue is given this same number (`Viewer`), so that the two
 * cannot come to disagree about how much room there is: a queue believing it has more would hand
 * over pages the atlas must immediately drop, and a card would lose what it is looking at to a chunk
 * nobody asked to see.
 */
export const SIDE = 640;
export const BYTES = SIDE ** 3;
/*
 * How many entries the table holds.  It is open addressing, so it wants to be comfortably larger
 * than the number of pages — at a load factor near a half the probe is one read nearly always.
 */
const SLOTS = 4096;
// Four words an entry: the key in two, where the page went, and how recently it was read.
const WORDS = 4;
const EMPTY = 0xffffffff;

/** Where a page of some scale of some source belongs. */
export interface Page {
  source: number;
  level: number;
  // The page's position in its scale's grid of pages, counted (x, y, z).
  at: [number, number, number];
}

/*
 * The key, as two words.
 *
 * Ten bits a coordinate is a scale 65,536 voxels across, which is four times the deepest scroll
 * here; eight bits of source and four of level are more than the page will ever hold open at once.
 */
const keyOf = (page: Page): [number, number] => [
  (page.at[0] & 1023) | ((page.at[1] & 1023) << 10) | ((page.at[2] & 1023) << 20),
  (page.source & 255) | ((page.level & 15) << 8),
];

/** Knuth's multiplicative hash over the two words, which is enough for keys this regular. */
const hashOf = (lo: number, hi: number) =>
  (Math.imul(lo ^ Math.imul(hi, 0x9e3779b1), 0x85ebca6b) >>> 0) % SLOTS;

export class Atlas extends RefCounted {
  /** The one texture.  R8, read with the texture unit's own filtering. */
  readonly texture: THREE.Data3DTexture;
  /** The table, as the shader reads it: `SLOTS × (keyLo, keyHi, where, when)`. */
  readonly table = new Uint32Array(SLOTS * WORDS);

  // Pages across the atlas each way, and how many there are in all.
  private readonly across: number;
  private readonly pages: number;
  // Which page is in each slot of the atlas, and nothing where it is free.
  private readonly held: (Page | undefined)[];
  // Where each page went, by its key, so that the same page is not written twice.
  private readonly where = new Map<string, number>();
  // A clock that only goes forward, for dropping the least recently wanted page.
  private clock = 0;
  private readonly used: number[];
  /** Bumped whenever the table changes, so a view knows to send it again. */
  generation = 0;

  constructor(
    private device: Device,
    side = SIDE,
  ) {
    super();
    this.across = Math.max(1, Math.floor(side / PAGE));
    this.pages = this.across ** 3;
    this.held = new Array(this.pages).fill(undefined);
    this.used = new Array(this.pages).fill(0);
    this.table.fill(EMPTY);

    /*
     * Allocated empty and written a page at a time through the raw device.  three.js has no cover
     * for writing part of a texture, and uploading the whole atlas because one chunk arrived would
     * be a hundred and thirty megabytes a chunk.
     */
    const voxels = this.across * PAGE;
    this.texture = new THREE.Data3DTexture(
      new Uint8Array(voxels ** 3),
      voxels,
      voxels,
      voxels,
    );
    this.texture.format = THREE.RedFormat;
    this.texture.type = THREE.UnsignedByteType;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.wrapS = THREE.ClampToEdgeWrapping;
    this.texture.wrapT = THREE.ClampToEdgeWrapping;
    this.texture.wrapR = THREE.ClampToEdgeWrapping;
    this.texture.unpackAlignment = 1;
    this.texture.needsUpdate = true;
    this.registerDisposer(() => this.texture.dispose());
  }

  /** How many pages the atlas holds, and how many are in use. */
  get room() {
    return { pages: this.pages, used: this.where.size };
  }

  /**
   * Gives a page's room back.
   *
   * This is how room is really made.  The atlas's own count of what was written recently is a
   * backstop and not a policy: the lookup happens on the GPU, so nothing here can see what is
   * actually being read, and an atlas left to decide for itself drops by age — which is to say it
   * drops whatever a card has been looking at longest while another card streams past it.  The
   * chunk queue above already knows what every card wants, at what priority and how visible it is,
   * and it already drops accordingly.  So it decides, and this does as it is told.
   */
  remove(page: Page) {
    const name = `${page.source}/${page.level}/${page.at.join(",")}`;
    const slot = this.where.get(name);
    if (slot === undefined) return;
    this.where.delete(name);
    this.held[slot] = undefined;
    this.used[slot] = 0;
    this.forget(page);
  }

  private cornerOf(slot: number): [number, number, number] {
    const { across } = this;
    return [
      (slot % across) * PAGE,
      (Math.floor(slot / across) % across) * PAGE,
      Math.floor(slot / (across * across)) * PAGE,
    ];
  }

  /**
   * Puts one page in, overwriting what was there if it is already in.
   *
   * `voxels` is `PAGE³` bytes laid out with x fastest.  A page the caller only partly filled is
   * still a whole page here: the atlas has no idea what a chunk boundary is, which is the point.
   *
   * Answers `false` when the page could not be written — the texture may not exist on the GPU yet,
   * since three.js makes it on first use — and the caller should offer it again.
   */
  put(page: Page, voxels: Uint8Array): boolean {
    if (this.device.gone) return false;
    const gpu = this.device.textureOf(this.texture);
    if (gpu === undefined) return false;
    if (voxels.length !== PAGE ** 3) {
      throw new Error(`A page is ${PAGE ** 3} bytes, not ${voxels.length}.`);
    }
    const name = `${page.source}/${page.level}/${page.at.join(",")}`;
    let slot = this.where.get(name);
    if (slot === undefined) {
      slot = this.free();
      const was = this.held[slot];
      if (was !== undefined) {
        this.where.delete(`${was.source}/${was.level}/${was.at.join(",")}`);
        this.forget(was);
      }
      this.held[slot] = page;
      this.where.set(name, slot);
      this.remember(page, slot);
    }
    this.used[slot] = ++this.clock;
    const [x, y, z] = this.cornerOf(slot);
    this.device.gpu.queue.writeTexture(
      { texture: gpu, origin: { x, y, z } },
      voxels,
      { bytesPerRow: PAGE, rowsPerImage: PAGE },
      { width: PAGE, height: PAGE, depthOrArrayLayers: PAGE },
    );
    return true;
  }

  /** The least recently wanted slot, or the first free one. */
  private free(): number {
    let worst = 0, when = Number.POSITIVE_INFINITY;
    for (let slot = 0; slot < this.pages; slot++) {
      if (this.held[slot] === undefined) return slot;
      if (this.used[slot] < when) {
        when = this.used[slot];
        worst = slot;
      }
    }
    return worst;
  }

  /*
   * The table is open addressing with linear probing, and the shader walks it the same way — so a
   * key that was never here is answered by the first empty slot rather than by a walk to the end.
   * That is why forgetting cannot just blank a slot: it would cut a probe chain in half and hide
   * every key behind it.  A forgotten slot is marked taken-but-no-page instead.
   */
  private remember(page: Page, slot: number) {
    const [lo, hi] = keyOf(page);
    let at = hashOf(lo, hi);
    for (let step = 0; step < SLOTS; step++) {
      const o = at * WORDS;
      const free = this.table[o + 2] === EMPTY;
      const same = this.table[o] === lo && this.table[o + 1] === hi;
      if (free || same) {
        this.table[o] = lo;
        this.table[o + 1] = hi;
        this.table[o + 2] = slot;
        this.table[o + 3] = 0;
        this.generation++;
        return;
      }
      at = (at + 1) % SLOTS;
    }
    throw new Error("The atlas's table is full, which cannot happen while it is larger than the atlas.");
  }

  private forget(page: Page) {
    const [lo, hi] = keyOf(page);
    let at = hashOf(lo, hi);
    for (let step = 0; step < SLOTS; step++) {
      const o = at * WORDS;
      if (this.table[o + 2] === EMPTY) return;
      if (this.table[o] === lo && this.table[o + 1] === hi) {
        // Taken, but holding nothing: the probe chain stays whole and the lookup misses here.
        this.table[o] = EMPTY;
        this.table[o + 1] = EMPTY;
        this.table[o + 2] = this.pages;
        this.generation++;
        return;
      }
      at = (at + 1) % SLOTS;
    }
  }
}

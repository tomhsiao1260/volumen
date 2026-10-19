/**
 * @file Reading the scan, as a TSL function: a place in the scroll goes in, a grey comes out.
 *
 * This is the one piece of shader every view shares, and the only one that knows the atlas exists.
 * A view says where it is looking — a cross-section says a plane, a flattening says a point of the
 * march — and gets back a grey and whether there was anything there.  Nothing above it knows about
 * pages, scales or residency.
 *
 * The lookup is open addressing with linear probing over the same table `atlas.ts` writes, walked
 * the same way: on to the next slot while the key does not match, and stop at the first empty one,
 * because a key that was never here cannot be past an empty slot.  That is also why a page that is
 * dropped leaves its slot taken — see `Atlas.forget`.
 */
import * as THREE from "three/webgpu";
import {
  Break,
  atomicStore,
  Fn,
  If,
  Loop,
  float,
  instancedArray,
  texture3D,
  uint,
  vec2,
  vec3,
} from "three/tsl";
import type { Atlas } from "#src/gpu/atlas.js";
import { PAGE } from "#src/gpu/atlas.js";

/*
 * What a TSL node looks like to TypeScript.
 *
 * `@types/three` does not describe node arguments in a way that survives being passed between
 * `Fn`s — the result of `uint()` is a `VarNode` and the parameter of an `Fn` is a plain `Node`, and
 * the two do not meet.  Naming it once here is better than scattering casts, and it is the one
 * place to narrow when the typings catch up.
 */
type Num = any;

// How far a probe may walk before giving up.  At the load factor the atlas holds it is one read
// nearly always, and four is far past where a run of that length is worth looking for.
const PROBES = 8;
const SLOTS = 4096;
const EMPTY = 0xffffffff;

/**
 * The scan as a TSL function, and the handle for keeping its table up to date.
 *
 * `at(source, level, factor, fill, upper, voxel)` takes a place in FULL-RESOLUTION voxels and the
 * scale to read it at, and answers `(grey, found)` — `found` being 0 where that page is not
 * resident, so a view can try a coarser scale or leave the pixel alone.  A page the store does not
 * have IS found, and is `fill`: the volume's own value for a voxel it never stored, as the renderer
 * before this one drew it.
 *
 * `upper` is how many voxels the scale has each way.  Beyond it is the padding of the store's last
 * chunk — zarr pads every chunk to the same size — and a place there is nothing, not black: a card
 * past the edge of a scroll used to show the padding of a coarse scale, confidently, where the
 * renderer before this one clipped its polygons to the volume and showed its clear colour.
 */
export function scanOf(atlas: Atlas) {
  const table = instancedArray(atlas.table, "uvec4");
  /*
   * Where the shader says which page it wanted and did not find.
   *
   * This is the whole of how the atlas learns what to hold.  The lookup happens here, so here is the
   * only place that knows what is actually being drawn — a list worked out on the other thread can
   * only be a guess at it, and the guess was wrong by a factor of sixty: a chunk of this scan is
   * 256 voxels a side, sixty-four pages, and a sheet cutting through one touches two or three of
   * them.  Uploading all sixty-four filled the atlas with papyrus nobody was looking at.
   *
   * Written at the key's own hash, two words a key, and atomically — not for the atomicity but
   * because three.js will not give a fragment shader a writable storage buffer any other way (its
   * `getNodeAccess` returns read-only outside compute unless the buffer is atomic, since WGSL does
   * allow atomics there).  Two misses landing on one slot can still interleave their halves, which
   * makes a key for a page that does not exist; it is passed over on the way back in and the one
   * that lost asks again next frame.
   */
  const asks = instancedArray(atlas.asks, "uint").toAtomic();
  // What the table looked like when it was last sent; the atlas bumps its own on every change.
  let sent = -1;

  const across = Math.max(1, Math.floor(atlas.texture.image.width / PAGE));
  const side = float(across * PAGE);
  // The slot that says "this page is nowhere": one past the last real one (`Atlas.absent`).
  const ABSENT = atlas.absentSlot;

  /*
   * A multiplicative hash, the same two constants the other side uses.  WGSL's `u32` multiply
   * wraps, which is what `Math.imul` is doing over there — so the two agree without either of them
   * having to say so.
   *
   * The slot is the TOP twelve bits of the product, not the bottom.  The bottom twelve depend only on
   * the bottom twelve of the key — the page's x and two bits of its y — so every page of a column
   * through the scroll hashed to one slot, and a card cut along z walked a chain as long as the
   * scroll is deep and gave up: measured, pages that were resident were asked for again every frame
   * and never found.
   */
  const hashOf = Fn(([lo, hi]: Num[]) =>
    lo
      .bitXor(hi.mul(uint(0x9e3779b1)))
      .mul(uint(0x85ebca6b))
      .shiftRight(uint(32 - Math.log2(SLOTS))),
  );

  /** Where a page sits in the atlas, in voxels, or `-1` in `w` when it is not resident. */
  const pageAt = Fn(([lo, hi]: Num[]) => {
      const at = hashOf(lo, hi).toVar();
      const slot = uint(EMPTY).toVar();
      Loop(PROBES, () => {
        const entry = table.element(at);
        // An empty slot ends the chain: a key that was never here cannot be beyond one.
        If(entry.z.equal(uint(EMPTY)), () => {
          Break();
        });
        If(entry.x.equal(lo).and(entry.y.equal(hi)), () => {
          slot.assign(entry.z);
          Break();
        });
        at.assign(at.add(uint(1)).mod(uint(SLOTS)));
      });
      return slot;
    },
  );

  /**
   * The grey at a place, and whether anything was there.
   *
   * The sample is the texture unit's own trilinear.  It used to be eight fetches weighted by hand,
   * because the scan was held as `R8UI` and integers cannot be filtered; held as `R8` the hardware
   * does it, which is both less code and less work.
   */
  const at = Fn(([source, level, factor, fill, upper, voxel]: Num[]) => {
      /*
       * Into this scale's own voxels, where a page is `PAGE` of them — nudged up by a thousandth of
       * one, so that a place exactly on the boundary between two texels, which every whole-numbered
       * position is, reads the one at the higher coordinate rather than whichever way the arithmetic
       * happened to round.  The renderer before this one nudged its chunk positions by the same
       * amount for the same reason.
       */
      const here = voxel.add(0.5).div(factor).sub(0.5 - 1e-3);
      const page = here.div(float(PAGE)).floor();
      const out = vec2(0, 0).toVar();
      /*
       * Outside the volume there is nothing to ask about — and asking anyway is not harmless.  A
       * negative coordinate turned into a `u32` wraps to an enormous one, and ten bits of it are
       * kept, so it lands on some OTHER page's key: a card reaching past the edge of a scroll would
       * draw a piece of somewhere else entirely, confidently.  Measured on a card one border-width
       * too wide, which is how this was found.  And past `upper` is the padding of the last chunk,
       * which is not the scroll either.
       */
      const inRange = here
        .greaterThanEqual(vec3(-0.5))
        .all()
        .and(here.lessThan(upper.sub(0.5)).all())
        .and(page.lessThan(vec3(1024)).all());
      If(inRange, () => {
      const lo = page.x
        .toUint()
        .bitAnd(uint(1023))
        .bitOr(page.y.toUint().bitAnd(uint(1023)).shiftLeft(uint(10)))
        .bitOr(page.z.toUint().bitAnd(uint(1023)).shiftLeft(uint(20)));
      const hi = source.bitAnd(uint(255)).bitOr(level.bitAnd(uint(15)).shiftLeft(uint(8)));
      const slot = pageAt(lo, hi).toVar();
      // Not here: say so, once, where whoever fills the atlas will see it.
      If(slot.equal(uint(EMPTY)), () => {
        const where = hashOf(lo, hi).mul(uint(2));
        atomicStore(asks.element(where), lo);
        atomicStore(asks.element(where.add(uint(1))), hi);
      });
      // Nowhere, and known to be: the volume's own value for a voxel it never stored.
      If(slot.equal(uint(ABSENT)), () => {
        out.assign(vec2(fill, 1));
      });
      If(slot.notEqual(uint(EMPTY)).and(slot.notEqual(uint(ABSENT))), () => {
        /*
         * Where that page went, unpacked from its number: pages are laid out x fastest, then y,
         * then z, which is the order `Atlas.cornerOf` lays them out in.
         */
        const n = float(slot);
        const corner = vec3(
          n.mod(across).floor(),
          n.div(across).floor().mod(across),
          n.div(across * across).floor(),
        ).mul(float(PAGE));
        /*
         * Where in the page, and then where that is in the texture.
         *
         * The half is the texel's own middle: a 3-D texture's coordinate `i / side` is the EDGE
         * between texel `i-1` and texel `i`, so sampling there mixes the two.  Left out, the whole
         * picture is half a voxel off in every direction — which looks perfectly reasonable and is
         * simply the wrong place.  Found by checking a linear volume pixel by pixel; nothing less
         * exact would have shown it.
         *
         * The clamp keeps both texels the filter touches inside this page, and inside the volume.
         * Without it the filter reaches into whatever page sits next door in the ATLAS, which is
         * some unrelated part of the scroll — the one way this scheme can draw a seam, and it draws
         * a bright one — or into the padding of the volume's last chunk.  The cost is half a voxel
         * of error at a page's own edge, which is the same bargain the renderer before this one made
         * at a chunk's.
         */
        const corner0 = page.mul(float(PAGE));
        const inside = here
          .sub(corner0)
          .clamp(vec3(0), upper.sub(1).sub(corner0).min(vec3(PAGE - 1)));
        const got = texture3D(atlas.texture, corner.add(inside).add(0.5).div(side));
        out.assign(vec2(got.r, 1));
      });
      });
      return out;
    },
  );

  return {
    at,
    /** Sends the table again if the atlas has changed since it last went.  Cheap when it has not. */
    update() {
      if (sent === atlas.generation) return;
      sent = atlas.generation;
      const attribute = (table as unknown as { value: THREE.BufferAttribute }).value;
      attribute.needsUpdate = true;
    },
    /** The buffer the shader writes its misses into, for whoever reads them back. */
    get asked() {
      return (asks as unknown as { value: THREE.BufferAttribute }).value;
    },
  };
}

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
  Fn,
  If,
  Loop,
  float,
  instancedArray,
  texture3D,
  uint,
  uvec2,
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
 * `at(source, level, factor, voxel)` takes a place in FULL-RESOLUTION voxels and the scale to read
 * it at, and answers `(grey, found)` — `found` being 0 where that page is not resident, so a view
 * can try a coarser scale or leave the pixel alone.
 */
export function scanOf(atlas: Atlas) {
  const table = instancedArray(atlas.table, "uvec4");
  // What the table looked like when it was last sent; the atlas bumps its own on every change.
  let sent = -1;

  const across = Math.max(1, Math.floor(atlas.texture.image.width / PAGE));
  const side = float(across * PAGE);

  /*
   * Knuth's multiplicative hash, the same two constants the other side uses.  WGSL's `u32` multiply
   * wraps, which is what `Math.imul` is doing over there — so the two agree without either of them
   * having to say so.
   */
  const hashOf = Fn(([lo, hi]: Num[]) =>
    lo
      .bitXor(hi.mul(uint(0x9e3779b1)))
      .mul(uint(0x85ebca6b))
      .mod(uint(SLOTS)),
  );

  /** Where a page sits in the atlas, in voxels, or `-1` in `w` when it is not resident. */
  const pageAt = Fn(([source, level, px, py, pz]: Num[]) => {
      const lo = px
        .bitAnd(uint(1023))
        .bitOr(py.bitAnd(uint(1023)).shiftLeft(uint(10)))
        .bitOr(pz.bitAnd(uint(1023)).shiftLeft(uint(20)));
      const hi = source.bitAnd(uint(255)).bitOr(level.bitAnd(uint(15)).shiftLeft(uint(8)));
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
  const at = Fn(([source, level, factor, voxel]: Num[]) => {
      // Into this scale's own voxels, where a page is `PAGE` of them.
      const here = voxel.add(0.5).div(factor).sub(0.5);
      const page = here.div(float(PAGE)).floor();
      const out = vec2(0, 0).toVar();
      /*
       * Outside the keys a page can have, there is nothing to ask about — and asking anyway is not
       * harmless.  A negative coordinate turned into a `u32` wraps to an enormous one, and ten bits
       * of it are kept, so it lands on some OTHER page's key: a card reaching past the edge of a
       * scroll would draw a piece of somewhere else entirely, confidently.  Measured on a card one
       * border-width too wide, which is how this was found.
       */
      const inRange = page
        .greaterThanEqual(vec3(0))
        .all()
        .and(page.lessThan(vec3(1024)).all());
      If(inRange, () => {
      const slot = pageAt(
        source,
        level,
        page.x.toUint(),
        page.y.toUint(),
        page.z.toUint(),
      ).toVar();
      If(slot.notEqual(uint(EMPTY)), () => {
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
         * The clamp keeps both texels the filter touches inside this page.  Without it the filter
         * reaches into whatever page sits next door in the ATLAS, which is some unrelated part of
         * the scroll — the one way this scheme can draw a seam, and it draws a bright one.  The cost
         * is half a voxel of error at a page's own edge, which is the same bargain the renderer
         * before this one made at a chunk's.
         */
        const inside = here.sub(page.mul(float(PAGE))).clamp(0, PAGE - 1);
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
  };
}

/**
 * @file Papyrus laid flat, as a TSL function.
 *
 * A pixel of the card is a point of the march; the march says where that point is in the scroll;
 * the scan says what is there.  Two reads, and that is the whole of it.
 *
 * **A card is an affine window on the flattening**, and nothing more:
 *
 *   (u, v, w) = at + right·a + down·b        with a, b the card's own 0..1
 *
 * The three planes a person can ask for — the sheet laid flat, and the two cuts across the stack —
 * are three sets of values for `at`, `right` and `down`.  They are not three cases in here.  The
 * renderer this replaces had them as three cases because a renderer working a pixel at a time on
 * the other thread could not afford to be general; a GPU can, and an oblique cut or a card that
 * follows a chain of annotations is then another three values and no new code.
 *
 * The one thing kept from that renderer, because it is the one thing that is really about papyrus:
 *
 *   **across the sheets, the card is spread by DISTANCE and not by winding.**
 *
 * Measured down the middle of one real piece, a half-wrap ran from 8.7 voxels to 31.3 — so spread by
 * winding, the thin parts would be drawn three and a half times magnified against the thick, and the
 * sheets a person is trying to tell apart would stop being level lines.  `walk` is the march's own
 * path inverted, and reading it is what keeps one winding on one line across the card.
 */
import * as THREE from "three/webgpu";
import {
  Fn,
  If,
  float,
  instancedArray,
  ivec3,
  texture3D,
  texture3DLoad,
  uint,
  uniform,
  uv,
  vec3,
  vec4,
} from "three/tsl";
import type { View } from "#src/gpu/card.js";
import type { Device } from "#src/gpu/device.js";
import type { Field } from "#src/gpu/field.js";
import type { scanOf } from "#src/gpu/sample.js";
import type { Scale } from "#src/gpu/slice.js";

/*
 * What a TSL node looks like to TypeScript.  `@types/three` does not describe node arguments in a
 * way that survives being passed between `Fn`s, so it is named once here rather than cast about.
 */
type Num = any;

/**
 * The window a card has on the flattening.
 *
 * `at`, `right` and `down` are in the march's own units: a whole number along u or v is a grid
 * point, and a whole number along w is a sheet.
 */
export interface Window {
  at: [number, number, number];
  right: [number, number, number];
  down: [number, number, number];
  /*
   * Where the card's top edge is across the papyrus, and how far down it reaches, in voxels.
   *
   * Given, the card's own b is a DISTANCE rather than a winding, and the w from `at` and `down` is
   * not used — this is the one place a card is not affine in the march's coordinates, and the one
   * place it must not be.  Left out, w comes from the window as u and v do.
   */
  through?: { from: number; across: number };
  /** A way of being told what the shader thinks rather than only what it draws; see `TELL`. */
  show?: number;
}

/**
 * What `show` asks for.
 *
 * Kept rather than deleted, as it was in the renderer before this one: a card that is wrong is wrong
 * for a dozen reasons and says nothing about which, and telling them apart one at a time is the
 * whole of getting one to draw.
 */
export const TELL = {
  /** How much of the march reached here, as grey. */
  reached: 1,
  /** The place in the scroll, wrapped every 64 voxels. */
  place: 2,
  /** Where the pixel is on the card: red across, green down. */
  card: 3,
  /** Where the pixel is on the march: red along u, green along v, blue the sheet. */
  grid: 4,
} as const;

export function surfaceOf(
  device: Device,
  scan: ReturnType<typeof scanOf>,
  source: number,
  scales: Scale[],
  field: Field,
): View & { show(window: Window): void } {
  const material = new THREE.MeshBasicNodeMaterial();
  material.transparent = true;

  const at = uniform(new THREE.Vector3());
  const right = uniform(new THREE.Vector3());
  const down = uniform(new THREE.Vector3());
  const from = uniform(0);
  // Zero means the card is affine in w too, which is the sheet laid flat.
  const across = uniform(0);
  const show = uniform(0);
  let want: Window = { at: [0, 0, 0], right: [0, 0, 0], down: [0, 0, 0] };
  let built = -1;

  /** Builds the program for the march being shown.  Once a piece, not once a frame. */
  const build = () => {
    const held = field.now;
    if (held === undefined) return;
    const { said, texture } = held;
    const size = vec3(said.nu, said.nv, said.layers);
    const walk = instancedArray(said.walk, "float");
    const steps = said.walk.length;

    /**
     * The winding at a distance through the papyrus — the march's own path, inverted.
     *
     * Read by hand rather than filtered: a one-dimensional float texture would raise the same
     * optional-feature question as the field and buy nothing, since this is two reads and a mix.
     */
    const windingAt = Fn(([b]: Num[]) => {
      const far = from.add(b.mul(across));
      const t = far.sub(said.lo).div(Math.max(1e-6, said.hi - said.lo));
      const texel = t.mul(steps - 1).clamp(0, steps - 1);
      const i = texel.floor();
      const j = i.add(1).min(steps - 1);
      return walk.element(i.toUint()).mix(walk.element(j.toUint()), texel.sub(i));
    });

    /**
     * The march, read where the card is looking — one texture read where the device will filter
     * floats and eight where it will not.
     *
     * The fourth channel is whether the march reached.  It is 0 or 1 and the eight weights of a
     * trilinear read sum to 1, so the blend reaches 1 only where every corner carrying weight was
     * reached: an alpha short of 1 is exactly "there is no sheet here", whichever way it was read.
     */
    const marchAt = Fn(([p]: Num[]) => {
      if (device.filtersFloats) return texture3D(texture, p.add(0.5).div(size));
      const base = p.floor();
      const t = p.sub(base);
      const top = size.sub(1);
      const total = vec4(0).toVar();
      for (let dk = 0; dk < 2; dk++)
        for (let di = 0; di < 2; di++)
          for (let dj = 0; dj < 2; dj++) {
            const weight = (dk ? t.z : t.z.oneMinus())
              .mul(di ? t.y : t.y.oneMinus())
              .mul(dj ? t.x : t.x.oneMinus());
            const corner = base.add(vec3(dj, di, dk)).clamp(vec3(0), top);
            total.addAssign(
              texture3DLoad(
                texture,
                ivec3(corner.x.toInt(), corner.y.toInt(), corner.z.toInt()),
                0,
              ).mul(weight),
            );
          }
      return total;
    });

    material.colorNode = Fn(() => {
      // Across the card and down it.  The quad's own y runs up, the card's runs down.
      const a = uv().x;
      const b = uv().y.oneMinus();
      const window_ = at.add(right.mul(a)).add(down.mul(b));
      // Along the sheets the window says where directly; across them, distance does.
      const w = across.equal(0).select(window_.z, windingAt(b));

      const out = vec4(0).toVar();
      If(show.equal(TELL.card), () => {
        out.assign(vec4(a, b, float(0.5), float(1)));
      });
      If(show.equal(TELL.grid), () => {
        out.assign(
          vec4(
            window_.x.div(Math.max(1, said.nu - 1)),
            window_.y.div(Math.max(1, said.nv - 1)),
            w.div(said.K).mul(0.5).add(0.5),
            float(1),
          ),
        );
      });
      If(show.lessThan(TELL.card), () => {
        // Where that point sits in the table, which holds a sample every eighth of a sheet.
        const layer = w.add(said.K).mul(said.per);
        If(layer.greaterThanEqual(0).and(layer.lessThanEqual(said.layers - 1)), () => {
          const place = marchAt(vec3(window_.x, window_.y, layer));
          If(show.equal(TELL.reached), () => {
            out.assign(vec4(place.w, place.w, place.w, float(1)));
          });
          If(show.equal(TELL.place), () => {
            out.assign(
              vec4(place.x.div(64).fract(), place.y.div(64).fract(), place.z.div(64).fract(), float(1)),
            );
          });
          If(show.equal(0).and(place.w.greaterThan(0.999)), () => {
            /*
             * The march holds (z, y, x), which is how the scan's array and the fit are both written;
             * the atlas is asked (x, y, z), because the data source turns the axes round when it
             * places a volume in the world.  Measured once, the hard way: a place asked the wrong
             * way round sat at chunk (74, 15, 38) where it belonged at (38, 15, 74) — empty space on
             * the far side of the scroll, drawn with complete confidence.
             */
            const voxel = vec3(place.z, place.y, place.x);
            const grey = float(0).toVar();
            const found = float(0).toVar();
            for (const scale of scales) {
              If(found.equal(0), () => {
                const got = scan.at(uint(source), uint(scale.level), float(scale.factor), voxel);
                If(got.y.greaterThan(0), () => {
                  grey.assign(got.x);
                  found.assign(1);
                });
              });
            }
            // Where there is papyrus but no scan yet, nothing is claimed: the card's own background
            // shows through rather than a grey that could be read as a reading.
            out.assign(vec4(grey, grey, grey, found));
          });
        });
      });
      return out;
    })();
    material.needsUpdate = true;
    built = field.generation;
  };

  return {
    material,
    show(window: Window) {
      want = window;
    },
    before() {
      if (field.generation !== built) build();
      at.value.set(want.at[0], want.at[1], want.at[2]);
      right.value.set(want.right[0], want.right[1], want.right[2]);
      down.value.set(want.down[0], want.down[1], want.down[2]);
      from.value = want.through?.from ?? 0;
      across.value = want.through?.across ?? 0;
      show.value = want.show ?? 0;
      scan.update();
    },
    dispose() {
      material.dispose();
    },
  };
}

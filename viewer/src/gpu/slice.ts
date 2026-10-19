/**
 * @file A cross-section, as a TSL function.
 *
 * The whole of it is: a pixel of the card is a place in the scroll, and the grey there is the scan.
 *
 * That is worth saying plainly because of what it replaces.  With a texture per chunk, a card had
 * to be drawn once per chunk, and each pass worked out where the view plane cut that chunk's box —
 * a vertex program with a table of twenty-four edges, six vertices a chunk, and the depth buffer
 * used as a stencil so a coarse scale could not paint over a fine one.  All of that existed to get
 * the right chunk's texture bound for the right pixels.  With one atlas there is no right chunk:
 * every pixel asks for the place it is at, and the lookup finds whatever is resident.
 *
 * Scales are tried finest first and the first one that answers wins.  That is the depth-buffer
 * trick written as what it always meant.
 */
import * as THREE from "three/webgpu";
import { Fn, If, float, uint, uniform, uv, vec3, vec4 } from "three/tsl";
import type { View } from "#src/gpu/card.js";
import type { scanOf } from "#src/gpu/sample.js";

/**
 * One scale of a source: where it sits in the list, how many full-resolution voxels a voxel is, and
 * how many voxels of its own it has each way (x, y, z) — beyond which there is padding in the
 * store's last chunk, and nothing to draw.
 */
export interface Scale {
  level: number;
  factor: number;
  upper: [number, number, number];
}

/**
 * Where a cross-section is looking, in full-resolution scan voxels, counted (x, y, z).
 *
 * The axes carry the zoom: they are how far one PIXEL of the drawing moves in the scroll, which is
 * exactly what the view matrix the chunks are asked for holds (`NavigationState.toMat4`).  Taking
 * both from the same matrix is the point — a view drawn from one place while its chunks are fetched
 * for another draws whatever happens to be resident, confidently, and that is not a thing anyone
 * would notice by looking.
 */
export interface Looking {
  // The middle of the card.
  at: [number, number, number];
  // One pixel to the right, and one pixel down.
  right: [number, number, number];
  down: [number, number, number];
  /*
   * The finest scale worth drawing at this zoom, as the asking chose it (`filterVisibleSources`).
   *
   * A finer page that happens to be resident — fetched for another card, or for this one before it
   * zoomed out — is passed over.  Drawing it would be sharper where it is and no sharper where it is
   * not, and a card half of one scale and half of another has a seam down it that moves as the
   * atlas turns over.  The renderer before this one drew only the scales the asking chose, and so
   * does this.
   */
  finest: number;
}

// What a pixel no scale can answer for yet is drawn as: the grey the renderer before this cleared to.
const MISSING = 0.5;

/**
 * A cross-section of `source`, drawn from `scan`.
 *
 * `scales` is finest first.  It is unrolled here rather than looped on the GPU because there are
 * only ever a handful and they are known when the shader is built, which keeps every index constant.
 */
export function sliceOf(
  scan: ReturnType<typeof scanOf>,
  source: number,
  scales: Scale[],
): View & { show(looking: Looking): void } {
  const at = uniform(new THREE.Vector3());
  const right = uniform(new THREE.Vector3(1, 0, 0));
  const down = uniform(new THREE.Vector3(0, 1, 0));
  // Half the card in pixels, so a place is `at + right·x + down·y` with x, y in ±this.
  const half = uniform(new THREE.Vector2());
  const finest = uniform(0);

  const material = new THREE.MeshBasicNodeMaterial();
  material.transparent = false;
  material.colorNode = Fn(() => {
    // The card's own y runs downward; the quad's runs up.
    const x = uv().x.sub(0.5).mul(2);
    const y = uv().y.oneMinus().sub(0.5).mul(2);
    /*
     * A variable, on purpose, and before anything conditional.  TSL gives a node that is used more
     * than once a variable of its own, and ASSIGNS it where the node is first met — which, without
     * this, was inside the `If` of the first scale below.  With that scale skipped the variable was
     * never assigned, the coarser scales read a place of (0, 0, 0), and a card zoomed out past the
     * second scale was one flat grey: every pixel the first voxel of the scroll.
     */
    const place = at.add(right.mul(x.mul(half.x))).add(down.mul(y.mul(half.y))).toVar();
    const grey = float(MISSING).toVar();
    const found = float(0).toVar();
    for (const scale of scales) {
      // Finest first, and the first that answers wins; a coarser one only fills what is missing.
      If(found.equal(0).and(float(scale.level).greaterThanEqual(finest)), () => {
        const got = scan.at(
          uint(source),
          uint(scale.level),
          float(scale.factor),
          vec3(...scale.upper),
          place,
        );
        If(got.y.greaterThan(0), () => {
          grey.assign(got.x);
          found.assign(1);
        });
      });
    }
    return vec4(grey, grey, grey, float(1));
  })();

  return {
    material,
    show(looking: Looking) {
      at.value.set(looking.at[0], looking.at[1], looking.at[2]);
      right.value.set(looking.right[0], looking.right[1], looking.right[2]);
      down.value.set(looking.down[0], looking.down[1], looking.down[2]);
      finest.value = looking.finest;
    },
    before(width: number, height: number) {
      // Worked out here because only now is the size the card is actually drawn at known.
      half.value.set(width / 2, height / 2);
      scan.update();
    },
    dispose() {
      material.dispose();
    },
  };
}

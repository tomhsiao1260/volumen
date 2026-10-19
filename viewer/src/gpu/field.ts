/**
 * @file The march on the GPU, and the rule that keeps a card from going blank.
 *
 * A surface card draws papyrus out of a *field*: for every point of a grid laid on the sheet and
 * every sample through the stack, where that point is in the scroll.  One texture, read once a
 * pixel, is the whole of what drawing a flattening costs.
 *
 * The rule, which matters more than the texture:
 *
 *   **A field is not let go of until the one replacing it can actually be drawn.**
 *
 * Moving along the papyrus past the piece it was built on makes a new field, and a new field is of
 * somewhere the scan has not been fetched for yet.  Taking it at once is what turned a card black
 * for the better part of a second — the old march was dropped, the new one had no scan behind it,
 * and every pixel was thrown away.  So the new one waits here until its chunks have arrived, and
 * the card goes on showing what it has.  Nothing about that needs the march to be fast; it only
 * needs the old answer to be kept, which is free.
 */
import * as THREE from "three/webgpu";
import type { Device } from "#src/gpu/device.js";
import { RefCounted } from "#src/util/disposable.js";

/** A march, as the page's own worker packs it. */
export interface Said {
  // The grid, and how many samples of it the table holds.
  nu: number;
  nv: number;
  layers: number;
  // Samples to a whole sheet, and whole sheets each way.
  per: number;
  K: number;
  /*
   * Where this march's grid sits on the plane it is laid on, in nodes (rows, then columns).
   *
   * A card's window is said on the PLANE, and the march is one piece of it: the piece slides under
   * the card as the card moves, and the one being drawn is not always the one that arrived last —
   * a new march waits here for its scan.  So the window is taken against the lattice of the march
   * actually being drawn, in `surfaceOf`, and nothing on the page has to know which that is.
   */
  lattice: [number, number];
  /*
   * RGBA, float32, laid out (layer, v, u) with u fastest: the place in the scroll in RGB — counted
   * (z, y, x), as the scan's array and the march both are — and in A whether the march reached.
   *
   * `A` being 0 or 1 while the eight weights of a trilinear read sum to 1 is what lets one read
   * answer both questions: the blend reaches 1 only where every corner carrying weight was reached,
   * so an alpha short of 1 is exactly "there is no sheet here".  Hardware filtering keeps that
   * exactly; it was true of the hand-written eight taps before it and is true of this.
   */
  data: Float32Array;
  /*
   * The walk inverted: the winding at each of `walk.length` equal distances from `lo` to `hi`.
   *
   * A cut spreads its sheets by distance rather than by winding, because the papyrus is not the
   * same thickness everywhere and spreading by winding draws the thin parts magnified.
   */
  walk: Float32Array;
  lo: number;
  hi: number;
}

/** How long a field may be kept waiting for its scan before it is shown anyway. */
const PATIENCE_MS = 4000;

export class Field extends RefCounted {
  /** What is being drawn.  Undefined until the first march arrives. */
  private held: Made | undefined;
  /** What will be drawn once the scan behind it is there. */
  private coming: (Made & { since: number }) | undefined;
  /** Bumped whenever what is being drawn changes, so a view knows to rebuild its uniforms. */
  generation = 0;

  /*
   * Tables let go of, kept to be written into again.  Pieces of one card are nearly always the same
   * size — the grid is fixed by the zoom, the layers by `K` and `per` — and a new march of the same
   * size can go into a texture the GPU already has, as a write, rather than into a new one, which
   * is an allocation and a fresh binding.  Measured: a new march cost the frame that first drew it
   * about 90 ms over the write alone.  One spare of each size is enough: the one being shown, and
   * the one coming.
   */
  private spare = new Map<string, Made>();

  constructor(private device: Device) {
    super();
    this.registerDisposer(() => {
      free(this.held);
      free(this.coming);
      for (const made of this.spare.values()) free(made);
      this.spare.clear();
    });
  }

  private sizeOf(said: { nu: number; nv: number; layers: number; walk: { length: number } }) {
    return `${said.nu}x${said.nv}x${said.layers}/${said.walk.length}`;
  }

  /** Lets a march go: into the spares if there is room for its size there, otherwise freed. */
  private release(made: Made | undefined) {
    if (made === undefined) return;
    const size = this.sizeOf(made.said);
    if (this.spare.has(size)) free(made);
    else this.spare.set(size, made);
  }

  get now() {
    return this.held;
  }

  /** Whether anything is waiting to be shown; the card asks so that it can say it is loading. */
  get waiting() {
    return this.coming !== undefined;
  }

  /**
   * A new march.  It is made ready at once and shown later — at once if nothing is being shown yet,
   * since a blank card has nothing to lose by taking it.
   */
  take(said: Said, { now = false } = {}) {
    this.release(this.coming);
    const made = this.make(said);
    /*
     * At once when nothing is shown yet — a blank card has nothing to lose by taking it — and at
     * once when asked: a cell whose corners are being dragged has to follow the hand, and a hole
     * where the scan has not arrived is the honest picture of where the hand is.
     */
    if (this.held === undefined || now) {
      this.release(this.held);
      this.held = made;
      this.coming = undefined;
      this.generation++;
      this.device.redraw();
      return;
    }
    this.coming = { ...made, since: performance.now() };
  }

  /**
   * Says whether the scan behind the waiting march has arrived.  Called by the card each time its
   * chunks settle; the swap happens here rather than there so that the rule lives in one place.
   */
  settled(ready: boolean) {
    const { coming } = this;
    if (coming === undefined) return;
    // Or it has waited long enough.  A piece over a hole in the scan would otherwise never arrive,
    // and a card showing somewhere it has left is worse than a card showing what little it has.
    if (!ready && performance.now() - coming.since < PATIENCE_MS) return;
    this.release(this.held);
    this.held = { said: coming.said, texture: coming.texture, walk: coming.walk };
    this.coming = undefined;
    this.generation++;
    this.device.redraw();
  }

  private make(said: Said): Made {
    /*
     * Into a spare of the same size, if there is one the GPU already holds: the table is written
     * straight into its texture through the raw device, and the walk likewise.  three.js is not
     * told — it would upload the stale `image.data` again — and does not need to be: the binding is
     * the same texture, and the pixels are the new ones.
     */
    const spare = this.spare.get(this.sizeOf(said));
    if (spare !== undefined) {
      const table = this.device.textureOf(spare.texture);
      const walk = this.device.textureOf(spare.walk);
      if (table !== undefined && walk !== undefined) {
        this.spare.delete(this.sizeOf(said));
        const { queue } = this.device.gpu;
        queue.writeTexture(
          { texture: table },
          said.data,
          { bytesPerRow: said.nu * 16, rowsPerImage: said.nv },
          { width: said.nu, height: said.nv, depthOrArrayLayers: said.layers },
        );
        queue.writeTexture(
          { texture: walk },
          said.walk,
          { bytesPerRow: said.walk.length * 4 },
          { width: said.walk.length, height: 1 },
        );
        // So that what three.js would upload, if it ever did again, is what the texture holds.
        spare.texture.image.data = said.data as unknown as Uint8Array;
        spare.walk.image.data = said.walk as unknown as Uint8Array;
        return { said, texture: spare.texture, walk: spare.walk };
      }
    }
    const texture = new THREE.Data3DTexture(
      said.data as unknown as Uint8Array,
      said.nu,
      said.nv,
      said.layers,
    );
    texture.format = THREE.RGBAFormat;
    texture.type = THREE.FloatType;
    /*
     * Never filtered by the texture unit: the shader blends the eight nodes around a point itself,
     * at full precision, because a weight here multiplies a distance (`surfaceOf.marchAt`).  The
     * walk below is filtered where the device will, since what it holds is small.
     */
    const smooth = this.device.filtersFloats;
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.wrapR = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;

    /*
     * And the walk as a one-dimensional texture rather than a buffer the shader indexes.
     *
     * It is a lookup with an interpolation, which is exactly what a texture unit is: one sample does
     * both and there is no index arithmetic to get wrong.  There was — a storage buffer of two
     * thousand entries read correctly at a constant index and wrongly at a computed one above about
     * half its length, and the winding it gave down a cut was not even monotonic (`?show=5`).
     */
    const walk = new THREE.DataTexture(
      said.walk as unknown as Uint8Array,
      said.walk.length,
      1,
      THREE.RedFormat,
      THREE.FloatType,
    );
    walk.minFilter = smooth ? THREE.LinearFilter : THREE.NearestFilter;
    walk.magFilter = smooth ? THREE.LinearFilter : THREE.NearestFilter;
    walk.wrapS = THREE.ClampToEdgeWrapping;
    walk.wrapT = THREE.ClampToEdgeWrapping;
    walk.needsUpdate = true;
    return { said, texture, walk };
  }
}

/** A march ready to draw: the table, and the walk that spreads a cut by distance. */
export interface Made {
  said: Said;
  texture: THREE.Data3DTexture;
  walk: THREE.DataTexture;
}

function free(made: { texture: THREE.Texture; walk: THREE.Texture } | undefined) {
  made?.texture.dispose();
  made?.walk.dispose();
}

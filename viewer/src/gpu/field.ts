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
  private held: { said: Said; texture: THREE.Data3DTexture } | undefined;
  /** What will be drawn once the scan behind it is there. */
  private coming: { said: Said; texture: THREE.Data3DTexture; since: number } | undefined;
  /** Bumped whenever what is being drawn changes, so a view knows to rebuild its uniforms. */
  generation = 0;

  constructor(private device: Device) {
    super();
    this.registerDisposer(() => {
      this.held?.texture.dispose();
      this.coming?.texture.dispose();
    });
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
  take(said: Said) {
    this.coming?.texture.dispose();
    const texture = this.make(said);
    if (this.held === undefined) {
      this.held = { said, texture };
      this.coming = undefined;
      this.generation++;
      return;
    }
    this.coming = { said, texture, since: performance.now() };
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
    this.held?.texture.dispose();
    this.held = { said: coming.said, texture: coming.texture };
    this.coming = undefined;
    this.generation++;
    this.device.redraw();
  }

  private make(said: Said) {
    const texture = new THREE.Data3DTexture(
      said.data as unknown as Uint8Array,
      said.nu,
      said.nv,
      said.layers,
    );
    texture.format = THREE.RGBAFormat;
    texture.type = THREE.FloatType;
    /*
     * Filtered by the texture unit where it can be.  Thirty-two-bit floats are an optional thing to
     * filter in WebGPU as they were an extension in WebGL, so where the device will not, the shader
     * reads the eight corners itself — one branch in `surfaceOf`, not a second way of holding this.
     */
    const smooth = this.device.filtersFloats;
    texture.minFilter = smooth ? THREE.LinearFilter : THREE.NearestFilter;
    texture.magFilter = smooth ? THREE.LinearFilter : THREE.NearestFilter;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.wrapR = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    return texture;
  }
}

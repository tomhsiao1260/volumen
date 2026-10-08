/**
 * @file The one GPU device, and the surface every card is drawn in.
 *
 * There is exactly one of these for a page.  A card is an ordinary element with an ordinary 2-D
 * canvas in it; the drawing happens once, off the page, and is copied into each card's canvas in
 * turn.  Giving every card its own WebGPU context instead would be the obvious thing and it is
 * wrong twice over: a browser allows only a handful of contexts, and nothing on one device is
 * visible to another — every card would hold its own copy of every chunk.
 *
 * Measured in the spike (`client/spike.html`): three cards drawn and copied out inside one task all
 * come out right, so the scheme survives the move from WebGL to WebGPU unchanged.  That matters,
 * because WebGPU presents a canvas at the END of the current task — the copy has to happen before
 * the task yields, which is what `draw` below enforces by doing all of it in one go.
 *
 * Two things here are deliberate and easy to lose:
 *
 *   - `gpu` is the raw `GPUDevice`.  three.js's own cover does not reach everything WebGPU does —
 *     it has no integer textures at all, and it maps sixteen-bit unorm to uint — so the parts that
 *     need the real thing (writing one page of an atlas, say) go through here.  Checked: both the
 *     device and the `GPUTexture` behind a three.js texture are reachable.
 *   - Everything that can fail quietly is made to speak.  A WebGPU call that is invalid does not
 *     throw: it goes to an error scope and the operation does nothing, which on a canvas shows as
 *     the frame BEFORE it — the spike was fooled by exactly that twice before error scopes went in.
 */
import * as THREE from "three/webgpu";
import type { RenderViewport } from "#src/render/base.js";
import { RefCounted } from "#src/util/disposable.js";
import { NullarySignal } from "#src/util/signal.js";
import { animationFrameDebounce } from "#src/util/animation_frame_debounce.js";

/** What a card has to be able to do to be drawn. */
export interface Card {
  // The element the card's own canvas lives in.
  element: HTMLElement;
  /*
   * How much it is worth drawing: `+∞` on screen, `0` near the board's edge — fetch, but do not
   * draw — and `-∞` off the board entirely, which asks for nothing at all.
   */
  visibility: { value: number };
  renderViewport: RenderViewport;
  // Works out how big it is now; called before anything is drawn so the surface can be sized once.
  measure(): void;
  // Gives up its pixels while it is off the board.
  release(): void;
  // Draws into the shared surface and copies its own rectangle out.  One task, no awaiting.
  draw(): void;
}

/*
 * The surface is left alone while it is within twice the size needed, because reallocating a
 * drawing buffer is not free — but it does have to come back down, or a board zoomed far in leaves
 * tens of megapixels allocated, which is how a device is lost.
 */
const ROOM = 2;

export class Device extends RefCounted {
  /** Where the cards are drawn before being copied into their own canvases.  Never in the page. */
  readonly surface: HTMLCanvasElement;
  readonly renderer: THREE.WebGPURenderer;
  /** The raw device, for what three.js's cover does not reach.  See the file comment. */
  readonly gpu: GPUDevice;

  readonly lost = new NullarySignal();
  /*
   * Once the device is gone every texture and pipeline belongs to a device that is gone, so any
   * further call only produces errors — thousands of them, since drawing is driven by animation
   * frames.  Nothing is drawn after this is set.
   */
  gone = false;

  private cards = new Set<Card>();
  /** Bumped whenever a card's size may have changed, so each card measures itself at most once. */
  sized = 0;

  private constructor(
    surface: HTMLCanvasElement,
    renderer: THREE.WebGPURenderer,
    gpu: GPUDevice,
  ) {
    super();
    this.surface = surface;
    this.renderer = renderer;
    this.gpu = gpu;
    gpu.lost.then((why) => {
      if (this.wasDisposed) return;
      this.gone = true;
      console.warn(`The GPU device was lost: ${why.reason} ${why.message}`);
      this.lost.dispatch();
    });
    this.registerDisposer(() => {
      this.gone = true;
      renderer.dispose();
    });
  }

  /**
   * Starts the one device, or answers `undefined` for every reason there is — no WebGPU, no
   * adapter, a device that would not come.  They all mean the same thing to the caller, which is
   * that this browser cannot show a scroll.
   */
  static async start(): Promise<Device | undefined> {
    const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
    if (gpu === undefined) return undefined;
    try {
      const adapter = await gpu.requestAdapter();
      if (adapter === null) return undefined;
      /*
       * Float filtering is asked for, not required.  With it the march's positions are one texture
       * read; without it the same texture is read by hand in eight — one line of shader, not a
       * second way of holding the data.
       */
      const wanted: GPUFeatureName[] = [];
      if (adapter.features.has("float32-filterable")) wanted.push("float32-filterable");
      const surface = document.createElement("canvas");
      const renderer = new THREE.WebGPURenderer({
        canvas: surface,
        antialias: false,
        requiredFeatures: wanted,
      } as THREE.WebGPURendererParameters);
      /*
       * No colour management.  A scan's greys are a measurement, not a colour: three.js would
       * otherwise encode the output as sRGB, and 200 would come back as 229 — which is what it did
       * the first time the atlas was read back.  Everything here is linear from the scan to the
       * card, as the WebGL renderer before it was.
       */
      renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
      await renderer.init();
      const device = (renderer as unknown as { backend?: { device?: GPUDevice } }).backend?.device;
      if (device === undefined) {
        renderer.dispose();
        return undefined;
      }
      return new Device(surface, renderer, device);
    } catch (error) {
      console.warn("The GPU device would not start:", error);
      return undefined;
    }
  }

  /** Whether the texture unit can filter 32-bit floats, or the shaders must do it by hand. */
  get filtersFloats() {
    return this.gpu.features.has("float32-filterable");
  }

  /**
   * The `GPUTexture` behind a three.js texture, for the writes three.js has no cover for.
   *
   * `undefined` until three.js has first used the texture, so anything that writes pages has to
   * cope with not being able to yet and try again on the next frame.
   */
  textureOf(texture: THREE.Texture): GPUTexture | undefined {
    const backend = (this.renderer as unknown as {
      backend?: { get(of: unknown): { texture?: GPUTexture } | undefined };
    }).backend;
    return backend?.get(texture)?.texture;
  }

  /**
   * Runs `what` with everything it does checked.
   *
   * WebGPU does not throw for an invalid call — a buffer written with the wrong size, a texture
   * laid out wrongly, a binding that does not fit.  Each goes to an error scope and the operation
   * quietly does nothing, which here would be a card showing the frame before it and no sign of
   * why.  The spike was fooled by exactly that, twice.
   */
  async checked<T>(what: () => T, saying: string): Promise<T> {
    this.gpu.pushErrorScope("validation");
    try {
      return what();
    } finally {
      const wrong = await this.gpu.popErrorScope();
      if (wrong !== null) console.error(`${saying}: ${wrong.message}`);
    }
  }

  add(card: Card) {
    this.cards.add(card);
    this.resized();
  }

  remove(card: Card) {
    this.cards.delete(card);
  }

  /** Says that some card's size may have changed, so every card measures itself again. */
  resized() {
    this.sized++;
    this.redraw();
  }

  readonly redraw = this.registerCancellable(
    animationFrameDebounce(() => this.draw()),
  );

  /**
   * One frame: measure every card, size the surface once to the largest, then draw and copy them
   * one at a time.
   *
   * All of it in one task, with nothing awaited.  A WebGPU canvas is presented when the task ends,
   * so a copy that happened after an await would be copying a canvas that had already gone.
   */
  private draw() {
    if (this.gone) return;
    const drawing: Card[] = [];
    let width = 0, height = 0;
    for (const card of this.cards) {
      card.measure();
      if (card.visibility.value === Number.NEGATIVE_INFINITY) {
        // Off the board: it gives up its pixels until it comes back.
        card.release();
        continue;
      }
      const seen = card.renderViewport;
      if (seen.width === 0 || seen.height === 0) continue;
      drawing.push(card);
      width = Math.max(width, seen.width);
      height = Math.max(height, seen.height);
    }
    if (drawing.length === 0) return;
    this.fit(width, height);
    for (const card of drawing) card.draw();
    this.drawn?.();
  }

  /** Called once every frame, after every card has been drawn and copied out. */
  drawn: (() => void) | undefined;

  private fit(width: number, height: number) {
    const { surface } = this;
    const enough =
      surface.width >= width &&
      surface.height >= height &&
      surface.width <= width * ROOM &&
      surface.height <= height * ROOM;
    if (enough) return;
    surface.width = width;
    surface.height = height;
    this.renderer.setSize(width, height, false);
  }
}

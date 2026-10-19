/**
 * @file The one GPU device, and the frame every card is drawn in.
 *
 * There is exactly one of these for a page.  Every card has a WebGPU canvas of its own, and all of
 * them present from this one device (`card.ts`): the atlas, the shaders and every texture are
 * shared, and a card is drawn straight onto its own canvas.  Giving every card its own device would
 * be the obvious thing and it is wrong: nothing on one device is visible to another, so every card
 * would hold its own copy of every chunk.
 *
 * Two things here are deliberate and easy to lose:
 *
 *   - `gpu` is the raw `GPUDevice`.  three.js's own cover does not reach everything WebGPU does —
 *     it has no integer textures at all, and it maps sixteen-bit unorm to uint — so the parts that
 *     need the real thing (writing one page of an atlas, say) go through here.  Checked: both the
 *     device and the `GPUTexture` behind a three.js texture are reachable.
 *   - Everything that can fail quietly is made to speak.  A WebGPU call that is invalid does not
 *     throw: it goes to an error scope and the operation does nothing, which on a canvas shows as
 *     the frame BEFORE it — which fooled the first version of this exactly twice before error
 *     scopes went in.
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
  // Whether its shader may ask for pages it cannot find, so that the frame has to be read back.
  asks: boolean;
  // Works out how big it is now; called before anything is drawn.
  measure(): void;
  // Gives up its pixels while it is off the board.
  release(): void;
  // Draws onto its own canvas.  One task, no awaiting.
  draw(): void;
}

export class Device extends RefCounted {
  /** The renderer's own canvas, never in the page and never drawn to: the cards have their own. */
  readonly surface: HTMLCanvasElement;
  readonly renderer: THREE.WebGPURenderer;
  /** The raw device, for what three.js's cover does not reach.  See the file comment. */
  readonly gpu: GPUDevice;

  readonly lost = new NullarySignal();
  /** Dispatched as a frame starts drawing, before any card is measured. */
  readonly frameStarted = new NullarySignal();
  /**
   * Dispatched once every card is measured and the frame is about to be drawn: everything on this
   * thread that changes what the shaders read — pages ordered as the frame started, say — has
   * happened by now, so this is when what they read goes up.
   */
  readonly frameMeasured = new NullarySignal();
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
   * why.
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

  /** The cards being drawn, for whoever has to ask them all something. */
  get drawing(): Iterable<Card> {
    return this.cards;
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
   * One frame: measure every card, then draw them one at a time, each onto its own canvas.
   *
   * All of it in one task, with nothing awaited: a WebGPU canvas is presented when the task ends.
   */
  private draw() {
    if (this.gone) return;
    const began = performance.now();
    this.frameStarted.dispatch();
    const drawing: Card[] = [];
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
    }
    if (drawing.length === 0) return;
    this.frameMeasured.dispatch();
    let asked = false;
    for (const card of drawing) {
      card.draw();
      asked ||= card.asks;
    }
    const took = performance.now() - began;
    const { stats } = this;
    stats.frames++;
    stats.lastMs = took;
    stats.meanMs += (took - stats.meanMs) / Math.min(stats.frames, 60);
    this.drawn?.(asked);
  }

  /**
   * Called once every frame, after every card has been drawn, with whether any of them may have
   * asked the GPU for pages — which is when the frame is worth reading back.
   */
  drawn: ((asked: boolean) => void) | undefined;

  /**
   * What a frame costs, for a measurement to look at: the last one, a running mean, and over all
   * frames the time spent rendering and the pixels drawn.
   */
  readonly stats = { frames: 0, lastMs: 0, meanMs: 0, renderMs: 0, pixels: 0 };
}

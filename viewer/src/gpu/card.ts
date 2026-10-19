/**
 * @file A card: an element on the page, a canvas inside it, and whatever is drawn into it.
 *
 * Every card's canvas is a WebGPU canvas of its own, presented from the ONE device: three.js's
 * `CanvasTarget` points the renderer at it for the card's turn, and the frame lands on it directly.
 * There is no shared surface and no copy.  The renderer this replaces drew every card into one
 * hidden canvas and copied each out with `drawImage` into a 2-D canvas, because a WebGL context is
 * a scarce thing and textures do not cross them — neither of which is true of WebGPU, where any
 * number of canvases can present from one device and the atlas is visible to all of them.  The
 * copy was not free either: a 2-D canvas reading a WebGPU canvas goes the long way round.
 *
 * Nothing here knows what is being drawn.  A view is a material on a card-filling quad, or a scene
 * and a camera of its own (a board of boxes in a 3-D scene, say); this is where it is given a
 * rectangle of the page and a turn on the GPU.
 */
import * as THREE from "three/webgpu";
import type { Card as Drawn, Device } from "#src/gpu/device.js";
import { RenderViewport } from "#src/render/base.js";
import { RefCounted } from "#src/util/disposable.js";
import { WatchableValue } from "#src/state/trackable_value.js";

/*
 * The most pixels a card is drawn with along either side, and per pixel of its own layout.
 *
 * A board that magnifies a card shows the same data over more of the screen — the extent a card
 * shows is fixed by its own zoom — so drawing it with more than twice its layout pixels adds no
 * detail.  It only asks for memory and for a larger canvas every frame, which is how a device is
 * lost.  Looking closer at the data is what the card's own zoom is for; that asks for finer chunks
 * instead.
 */
const MOST = 2048;
const MOST_SCALE = 2;
// How far outside the window a card is still worth fetching for, though not drawing.
const NEAR = "200px";

/**
 * What a view has to give a card: either a material, drawn over the whole card, or a scene and a
 * camera of its own; and a chance to set either up each frame.
 */
export interface View {
  material?: THREE.Material;
  scene?: THREE.Scene;
  camera?: THREE.Camera;
  /*
   * Whether this view may ask the GPU for pages it could not find (`sample.ts`), so that the frame
   * is read back after it.  A view whose pages are ordered ahead on this thread (`pages.ts`) does
   * not need the readback, and a frame of such views alone is not read.
   */
  asks?: boolean;
  // Called once per frame before drawing, with the size it is being drawn at.
  before?(width: number, height: number): void;
  dispose?(): void;
}

/**
 * The pixels to draw one of a card's own layout pixels with, given how many pixels of the screen
 * one of them covers and how large the card is.
 *
 * Only ever a power of two: halving and doubling keeps the shape of what is drawn exactly, so the
 * card's canvas can simply be stretched over it, and leaves the size alone until the magnification
 * has really changed.  A size that changed with every frame of a zoom reallocated every card's
 * canvas sixty times a second, and that is what cost the WebGL context before this.
 */
function fitScale(shown: number, layoutSize: number) {
  let scale = 2 ** Math.round(Math.log2(Math.max(shown, 1e-3)));
  scale = Math.min(scale, MOST_SCALE);
  const most = MOST / layoutSize;
  while (scale > most && scale > 1 / 8) scale /= 2;
  return Math.max(1 / 8, scale);
}

export class CardView extends RefCounted implements Drawn {
  private canvas = document.createElement("canvas");
  private target = new THREE.CanvasTarget(this.canvas);
  private scene: THREE.Scene;
  private camera: THREE.Camera;
  private quad: THREE.Mesh | undefined;
  private sized = -1;
  private onScreen = true;
  private nearScreen = true;

  readonly renderViewport = new RenderViewport();
  readonly visibility = new WatchableValue(Number.POSITIVE_INFINITY);
  readonly asks: boolean;

  constructor(
    readonly element: HTMLElement,
    private device: Device,
    private view: View,
  ) {
    super();
    const { canvas } = this;
    canvas.style.position = "absolute";
    canvas.style.left = canvas.style.top = "0px";
    canvas.style.width = canvas.style.height = "100%";
    canvas.style.display = "block";
    if (getComputedStyle(element).position === "static") element.style.position = "relative";
    element.appendChild(canvas);
    // Sizes are said in the pixels drawn; the canvas is stretched over the element by CSS.
    this.target.setPixelRatio(1);
    this.registerDisposer(() => {
      this.target.dispose();
      canvas.remove();
    });
    this.asks = view.asks === true;

    if (view.material !== undefined) {
      // A material over the whole card: a quad that fills an orthographic camera.
      this.scene = new THREE.Scene();
      this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
      this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), view.material);
      this.scene.add(this.quad);
    } else if (view.scene !== undefined && view.camera !== undefined) {
      this.scene = view.scene;
      this.camera = view.camera;
    } else {
      throw new Error("A view is a material, or a scene and a camera.");
    }
    this.registerDisposer(() => {
      this.quad?.geometry.dispose();
      view.dispose?.();
    });

    // On the board, near it, or neither — and neither asks for no data at all.
    const settle = () => {
      this.visibility.value = this.onScreen
        ? Number.POSITIVE_INFINITY
        : this.nearScreen
          ? 0
          : Number.NEGATIVE_INFINITY;
      // A card whose visibility changed has moved, so its size is worth measuring again.
      device.resized();
    };
    const watch = (options: IntersectionObserverInit, set: (seen: boolean) => void) => {
      const observer = new IntersectionObserver((entries) => {
        set(entries[entries.length - 1].isIntersecting);
        settle();
      }, options);
      observer.observe(element);
      this.registerDisposer(() => observer.disconnect());
    };
    watch({}, (seen) => (this.onScreen = seen));
    watch({ rootMargin: NEAR }, (seen) => (this.nearScreen = seen));
    // A card resized is a card to measure again; one merely moved is reported by the board.
    const resized = new ResizeObserver(() => device.resized());
    resized.observe(element);
    this.registerDisposer(() => resized.disconnect());

    device.add(this);
    this.registerDisposer(() => device.remove(this));
  }

  /** Says the card should be drawn again, because what it is looking at changed. */
  changed() {
    this.device.redraw();
  }

  measure() {
    if (this.device.sized === this.sized) return;
    this.sized = this.device.sized;
    const wide = Math.max(1, this.element.offsetWidth);
    const tall = Math.max(1, this.element.offsetHeight);
    /*
     * How many pixels one of the card's own layout pixels is drawn with: the board's magnification
     * (`getBoundingClientRect` is scaled by a CSS transform on an ancestor and `offsetWidth` is not),
     * within the limits above.
     *
     * NOT the screen's density.  Drawing a card at two pixels per layout pixel on a dense screen made
     * it sharper and cost four times the pixels — and, because the asking divides the zoom by the
     * pixels drawn, a scale finer by one level and the downloads to match.  Measured on a board of
     * four cards: 60 frames a second at one, 38 at two.  Sharpness is what a card's own zoom is for.
     */
    const { width } = this.element.getBoundingClientRect();
    const scale = fitScale(width / wide, Math.max(wide, tall));
    this.renderViewport.width = Math.round(wide * scale);
    this.renderViewport.height = Math.round(tall * scale);
    // It is the pixels actually drawn that count, so that a card drawn with fewer of them than it
    // is shown with still shows the same data (see `RenderViewport`).
    this.renderViewport.pixelScale = scale;
  }

  /** Gives up its pixels while it is off the board; the next draw sizes the canvas again. */
  release() {
    if (this.canvas.width === 0 && this.canvas.height === 0) return;
    this.canvas.width = this.canvas.height = 0;
  }

  draw() {
    const { canvas, device } = this;
    const { width, height } = this.renderViewport;
    if (width === 0 || height === 0) return;
    this.view.before?.(width, height);
    const { renderer, stats } = device;
    const began = performance.now();
    /*
     * The renderer is pointed at this canvas BEFORE the canvas is sized.  It listens for the size of
     * the one canvas target it is pointed at, and on hearing it drops the render pass it cached for
     * that target — the depth buffer in it is the old size.  Sized first, this card's canvas told
     * the previous card's listener, which heard nothing, and the card's next frame paired a new
     * colour attachment with a stale depth buffer: a validation error, and a frame not drawn.
     */
    renderer.setCanvasTarget(this.target);
    // The canvas is the frame's size; a WebGPU canvas presents whatever size it is when asked.
    if (canvas.width !== width || canvas.height !== height) this.target.setSize(width, height, false);
    renderer.render(this.scene, this.camera);
    stats.renderMs += performance.now() - began;
    stats.pixels += width * height;
  }
}

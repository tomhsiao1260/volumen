/**
 * @file A card: an element on the page, a canvas inside it, and whatever is drawn into it.
 *
 * The drawing happens in the device's one shared surface and is copied out into this card's own
 * 2-D canvas, so the card is an ordinary element — it can be styled, stacked, clipped and moved by
 * the board like anything else, and the surface only has to be as large as the largest card.
 *
 * Nothing here knows what is being drawn.  A view is a material and a few uniforms; this is where
 * it is given a rectangle of the page and a share of the GPU.
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
 * detail.  It only asks for memory and for a larger copy every frame, which is how a device is lost.
 * Looking closer at the data is what the card's own zoom is for; that asks for finer chunks instead.
 */
const MOST = 2048;
const MOST_SCALE = 2;
// How far outside the window a card is still worth fetching for, though not drawing.
const NEAR = "200px";

/** What a view has to give a card: a material to draw with, and a chance to set it up each frame. */
export interface View {
  material: THREE.Material;
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
 * canvas and the surface sixty times a second, and that is what cost the WebGL context before this.
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
  private context: CanvasRenderingContext2D;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private quad: THREE.Mesh;
  private sized = -1;
  private onScreen = true;
  private nearScreen = true;

  readonly renderViewport = new RenderViewport();
  readonly visibility = new WatchableValue(Number.POSITIVE_INFINITY);

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
    this.context = canvas.getContext("2d")!;
    this.registerDisposer(() => canvas.remove());

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), view.material);
    this.scene.add(this.quad);
    this.registerDisposer(() => {
      this.quad.geometry.dispose();
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
     * How many pixels of the screen one of the card's own pixels covers: the board's magnification
     * (`getBoundingClientRect` is scaled by a CSS transform on an ancestor and `offsetWidth` is not)
     * times the screen's own density.  Drawn with that many, within the limits above, a card is as
     * sharp as the screen shows it and no sharper.
     */
    const { width } = this.element.getBoundingClientRect();
    const shown = (width / wide) * (window.devicePixelRatio || 1);
    const scale = fitScale(shown, Math.max(wide, tall));
    this.renderViewport.width = Math.round(wide * scale);
    this.renderViewport.height = Math.round(tall * scale);
    // It is the pixels actually drawn that count, so that a card drawn with fewer of them than it
    // is shown with still shows the same data (see `RenderViewport`).
    this.renderViewport.pixelScale = scale;
  }

  release() {
    this.canvas.width = this.canvas.height = 0;
  }

  draw() {
    const { canvas, context, device } = this;
    const { width, height } = this.renderViewport;
    if (width === 0 || height === 0) return;
    this.view.before?.(width, height);
    /*
     * The surface is made this card's size, and the card fills it.
     *
     * Drawing each card into a corner of one larger surface would save the resizing, and it is what
     * the renderer this replaces did — but three.js's WebGPU backend does not honour a viewport or a
     * scissor set before `render`, and the card came out covering about two thirds of what it had
     * asked for, in every frame, whatever was loaded.  A canvas the right size needs no viewport at
     * all, and the copy below then has no corner to find.
     */
    device.sizeFor(width, height);
    device.renderer.render(this.scene, this.camera);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    /*
     * And copied out before this task ends.  A WebGPU canvas is presented when the task does, so a
     * copy after an await would be copying a canvas that has already gone.
     *
     * From the top-left of the surface, which is where the card was just drawn.  The renderer this
     * replaces read from `surface.height - height` instead, because WebGL counts its rows from the
     * bottom; WebGPU's canvas has its origin at the top-left.
     */
    context.clearRect(0, 0, width, height);
    context.drawImage(device.surface, 0, 0);
  }
}

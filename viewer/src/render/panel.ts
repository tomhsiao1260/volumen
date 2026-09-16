/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { RenderViewport } from "#src/render/base.js";
import { SliceView } from "#src/render/frontend.js";
import type { ImageRenderLayer } from "#src/render/renderlayer.js";
import type { NavigationState } from "#src/state/navigation_state.js";
import type { WatchableValueInterface } from "#src/state/trackable_value.js";
import { WatchableValue } from "#src/state/trackable_value.js";
import { animationFrameDebounce } from "#src/util/animation_frame_debounce.js";
import { RefCounted } from "#src/util/disposable.js";
import { mat4, vec3 } from "#src/util/geom.js";
import { NullarySignal } from "#src/util/signal.js";
import type { GL } from "#src/webgl/context.js";
import { initializeWebGL } from "#src/webgl/context.js";

/**
 * The WebGL context shared by all panels.  It draws into one surface that is not part of the page:
 * after `scheduleRedraw`, `draw` runs on the next animation frame and, for each panel, draws its
 * slice at the surface's origin and copies it into the panel's own canvas.  Panels are therefore
 * ordinary elements, which may be styled, stacked and clipped like any others, and the surface only
 * has to be as large as the largest panel.
 */
export class DisplayContext extends RefCounted {
  gl: GL;
  panels = new Set<SliceViewPanel>();
  // Incremented when a panel is added, moved or resized; the panel bounds are then measured again.
  resizeGeneration = 0;
  // Dispatched when a frame starts drawing.
  updateStarted = new NullarySignal();
  // Where the slices are drawn before being copied into the panels' own canvases.
  readonly surface = document.createElement("canvas");
  private resizeObserver = new ResizeObserver(() => this.invalidateBounds());

  constructor(public container: HTMLElement) {
    super();
    this.gl = initializeWebGL(this.surface);
    this.resizeObserver.observe(container);
    this.registerDisposer(() => this.resizeObserver.disconnect());
  }

  addPanel(panel: SliceViewPanel) {
    this.panels.add(panel);
    this.resizeObserver.observe(panel.element);
    this.invalidateBounds();
  }

  removePanel(panel: SliceViewPanel) {
    this.panels.delete(panel);
    this.resizeObserver.unobserve(panel.element);
    this.invalidateBounds();
  }

  /**
   * Measures every panel again on the next frame.  Panel bounds are measured only when a panel is
   * added or resized, so an app that moves a panel without resizing it — panning a board of panels,
   * scrolling the page — has to say so.
   */
  invalidateBounds() {
    ++this.resizeGeneration;
    this.scheduleRedraw();
  }

  readonly scheduleRedraw = this.registerCancellable(
    animationFrameDebounce(() => this.draw()),
  );

  draw() {
    this.updateStarted.dispatch();
    for (const panel of this.panels) {
      if (panel.visibility.value === Number.NEGATIVE_INFINITY) continue;
      panel.ensureBoundsUpdated();
      const { width, height } = panel.renderViewport;
      if (width === 0 || height === 0) continue;
      this.growSurface(width, height);
      panel.draw();
    }
  }

  // Panels draw one at a time, so the surface only has to hold the largest of them.  Resizing it
  // reallocates the drawing buffer, so it never shrinks.
  private growSurface(width: number, height: number) {
    const { surface } = this;
    if (surface.width >= width && surface.height >= height) return;
    surface.width = Math.max(surface.width, width);
    surface.height = Math.max(surface.height, height);
  }
}

export interface SliceViewerState {
  display: DisplayContext;
  chunkManager: ChunkManager;
}

const tempVec3 = vec3.create();
const tempMat4 = mat4.create();
const tempOffset = new Float32Array(2);

function hasNoModifiers(event: MouseEvent) {
  return !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
}

function hasOnlyControl(event: MouseEvent) {
  return event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
}

// How far outside the container a panel still counts as about to be seen (see `visibility`).
const NEAR_SCREEN_MARGIN = "200px";

// Zoom factor for one wheel event: e^(deltaY / 200) when the delta is in pixels.
function getWheelZoomAmount(event: WheelEvent) {
  let multiplier = 0;
  switch (event.deltaMode) {
    case WheelEvent.DOM_DELTA_PIXEL:
      multiplier = 1 / 200.0;
      break;
    case WheelEvent.DOM_DELTA_LINE:
      multiplier = 1 / 10.0;
      break;
    case WheelEvent.DOM_DELTA_PAGE:
      multiplier = 2;
      break;
  }
  return Math.exp(event.deltaY * multiplier);
}

/**
 * One cross-section view, drawn into a canvas of its own inside `element`.  Mouse input on
 * `element` becomes navigation:
 *
 *   - left drag: pan
 *   - wheel: move one voxel along the viewing direction
 *   - control+wheel: zoom around the mouse position
 *
 * `handleInput` lets the page take any of them over.
 */
export class SliceViewPanel extends RefCounted {
  gl: GL = this.viewer.display.gl;

  // Generation used to check whether the following bounds-related fields are up to date.
  boundsGeneration = -1;

  renderViewport = new RenderViewport();

  /**
   * Whether the view handles `event` itself.  Return `false` to leave it to the page, so that a
   * board of views can take the wheel for its own zoom, say; the view then does not stop the event.
   * By default the view handles all of them.
   */
  handleInput: ((event: MouseEvent) => boolean) | undefined;

  // The canvas the slice is copied into, filling `element`.
  private canvas = document.createElement("canvas");
  private context: CanvasRenderingContext2D;

  /**
   * How much this panel's chunks are worth loading: `POSITIVE_INFINITY` while the panel is on
   * screen, `0` while it is only near its container (scrolled just out of a board of views, say),
   * and `NEGATIVE_INFINITY` once it is neither, in which case it is not drawn and its chunks are
   * not requested at all (see `render/backend.ts`).  Panels start out visible, so that the first
   * frame is not delayed by waiting for the observers below.
   */
  visibility = new WatchableValue(Number.POSITIVE_INFINITY);
  private onScreen = true;
  private nearScreen = true;

  sliceView: SliceView;

  constructor(
    public element: HTMLElement,
    public navigationState: NavigationState,
    // The layer that draws the volume this view shows; `undefined` until the volume has loaded.
    renderLayer: WatchableValueInterface<ImageRenderLayer | undefined>,
    public viewer: SliceViewerState,
  ) {
    super();
    const { display, chunkManager } = viewer;
    display.addPanel(this);
    this.registerDisposer(() => display.removePanel(this));

    const { canvas } = this;
    canvas.style.position = "absolute";
    canvas.style.left = "0px";
    canvas.style.top = "0px";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.display = "block";
    if (getComputedStyle(element).position === "static") {
      element.style.position = "relative";
    }
    element.appendChild(canvas);
    this.context = canvas.getContext("2d")!;
    this.registerDisposer(() => canvas.remove());

    const updateVisibility = () => {
      this.visibility.value = this.onScreen
        ? Number.POSITIVE_INFINITY
        : this.nearScreen
          ? 0
          : Number.NEGATIVE_INFINITY;
    };
    const observe = (
      options: IntersectionObserverInit,
      set: (intersecting: boolean) => void,
    ) => {
      const observer = new IntersectionObserver((entries) => {
        set(entries[entries.length - 1].isIntersecting);
        updateVisibility();
      }, options);
      observer.observe(element);
      this.registerDisposer(() => observer.disconnect());
    };
    // Whether the panel is on screen at all, and whether it is at least close to its place in the
    // container.  The second observer measures against the container rather than the window,
    // because a container that clips (a scrolling board of views) hides the panel from the window
    // long before it is far away.
    observe({}, (intersecting) => (this.onScreen = intersecting));
    observe(
      { root: display.container, rootMargin: NEAR_SCREEN_MARGIN },
      (intersecting) => (this.nearScreen = intersecting),
    );
    // A panel whose visibility changed has moved, so its bounds are stale and no frame is scheduled.
    this.registerDisposer(
      this.visibility.changed.add(() => display.invalidateBounds()),
    );

    this.sliceView = this.registerDisposer(
      new SliceView(chunkManager, renderLayer, navigationState, this.visibility),
    );

    this.registerDisposer(
      this.sliceView.viewChanged.add(() => display.scheduleRedraw()),
    );

    // The canvas covers the element, so the slice itself is the target of both.
    const onSlice = (event: MouseEvent) =>
      event.target === canvas || event.target === element;

    const onMouseDown = (event: MouseEvent) => {
      if (!onSlice(event) || event.button !== 0) return;
      if (!hasNoModifiers(event) || this.handleInput?.(event) === false) return;
      event.stopPropagation();
      this.startDrag(event);
      event.preventDefault();
    };

    const onWheel = (event: WheelEvent) => {
      if (this.handleInput?.(event) === false) return;
      if (hasOnlyControl(event)) {
        event.stopPropagation();
        this.zoomByMouse(event, getWheelZoomAmount(event));
        event.preventDefault();
      } else if (onSlice(event) && hasNoModifiers(event)) {
        event.stopPropagation();
        const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
        this.stepSlices(delta > 0 ? -1 : 1);
        event.preventDefault();
      }
    };

    element.addEventListener("mousedown", onMouseDown);
    element.addEventListener("wheel", onWheel);
    this.registerDisposer(() => {
      element.removeEventListener("mousedown", onMouseDown);
      element.removeEventListener("wheel", onWheel);
    });
  }

  // Pans with every pointer move until the button that started the drag is released.
  private startDrag(initialEvent: MouseEvent) {
    const { document } = initialEvent.view!;
    const { button } = initialEvent;
    let prevClientX = initialEvent.clientX;
    let prevClientY = initialEvent.clientY;
    const onMove = (e: PointerEvent) => {
      const deltaX = e.clientX - prevClientX;
      const deltaY = e.clientY - prevClientY;
      prevClientX = e.clientX;
      prevClientY = e.clientY;
      this.translateByViewportPixels(deltaX, deltaY);
    };
    const onUp = (e: PointerEvent) => {
      if (e.button === button) stop();
    };
    const stop = () => {
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", onUp, false);
      document.removeEventListener("pointercancel", stop, false);
    };
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", onUp, false);
    document.addEventListener("pointercancel", stop, false);
  }

  // Moves `count` voxels along the viewing direction, which is what the wheel does by default.
  stepSlices(count: number) {
    vec3.set(tempVec3, 0, 0, count);
    this.navigationState.translateVoxelsRelative(tempVec3);
  }

  translateByViewportPixels(deltaX: number, deltaY: number): void {
    this.navigationState.updateDisplayPosition((pos: vec3) => {
      vec3.set(pos, -deltaX, -deltaY, 0);
      vec3.transformMat4(
        pos,
        pos,
        this.sliceView.projectionParameters.value.invViewMatrix,
      );
    });
  }

  // Draws the slice into the shared surface and copies it into the panel's own canvas, which the
  // next panel's drawing would otherwise overwrite.
  draw() {
    const { sliceView, gl, canvas, context } = this;
    if (!sliceView.valid) {
      return;
    }
    const { surface } = this.viewer.display;
    const { width, height } = this.renderViewport;
    // The surface may be larger than the slice; drawing in its top-left corner (GL counts rows from
    // the bottom) is where the copy below reads from.
    gl.enable(WebGL2RenderingContext.SCISSOR_TEST);
    gl.viewport(0, surface.height - height, width, height);
    gl.scissor(0, surface.height - height, width, height);
    sliceView.draw();
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.drawImage(surface, 0, 0, width, height, 0, 0, width, height);
  }

  ensureBoundsUpdated() {
    const { display } = this.viewer;
    if (display.resizeGeneration === this.boundsGeneration) return;
    this.boundsGeneration = display.resizeGeneration;

    const { element } = this;
    const { width, height } = element.getBoundingClientRect();
    const viewport = this.renderViewport;
    viewport.width = Math.round(width);
    viewport.height = Math.round(height);
    // `getBoundingClientRect` is scaled by a CSS transform on an ancestor and `offsetWidth` is not,
    // so their ratio is how much the panel is magnified on screen (see `RenderViewport`).
    const layoutWidth = element.offsetWidth;
    viewport.pixelScale = layoutWidth > 0 ? width / layoutWidth : 1;

    this.sliceView.projectionParameters.setViewport(viewport);
  }

  // Position on the page, as an offset in viewport pixels from the center of the panel.
  private offsetFromCenter(clientX: number, clientY: number) {
    const { element, renderViewport } = this;
    const bounds = element.getBoundingClientRect();
    tempOffset[0] =
      clientX - (bounds.left + element.clientLeft) - renderViewport.width / 2;
    tempOffset[1] =
      clientY - (bounds.top + element.clientTop) - renderViewport.height / 2;
    return tempOffset;
  }

  /**
   * Returns the point, in the viewer's (z, y, x) coordinates, shown at `clientX`, `clientY` on the
   * page, or `undefined` before the volume has loaded.  Computed from the navigation state rather than
   * the projection parameters, which are updated after a delay.
   */
  pointAt(clientX: number, clientY: number) {
    const { navigationState } = this;
    if (!navigationState.valid) return undefined;
    navigationState.toMat4(tempMat4, this.renderViewport.pixelScale);
    const [x, y] = this.offsetFromCenter(clientX, clientY);
    const point = new Float32Array(3);
    for (let i = 0; i < 3; ++i) {
      point[i] = tempMat4[i] * x + tempMat4[4 + i] * y + tempMat4[12 + i];
    }
    return point;
  }

  /**
   * Zooms by the specified factor, maintaining the data position that projects to the mouse
   * position of `event`.
   */
  zoomByMouse(event: MouseEvent, factor: number) {
    const { navigationState } = this;
    if (!navigationState.valid) {
      return;
    }
    const { invViewMatrix } = this.sliceView.projectionParameters.value;
    const [mouseX, mouseY] = this.offsetFromCenter(event.clientX, event.clientY);
    // Desired invariance:
    //
    // invViewMatrixLinear * [mouseX, mouseY, 0]^T + [oldX, oldY, oldZ]^T =
    // invViewMatrixLinear * factor * [mouseX, mouseY, 0]^T + [newX, newY, newZ]^T

    const position = navigationState.position.value;
    for (let i = 0; i < 3; ++i) {
      const f = invViewMatrix[i] * mouseX + invViewMatrix[4 + i] * mouseY;
      position[i] += f * (1 - factor);
    }
    navigationState.position.changed.dispatch();
    navigationState.zoomBy(factor);
  }
}

/**
 * @file A cross-section card: a card, the asking for its chunks, and the mouse input that moves it.
 *
 * Two halves that must not come apart: a `SliceView` that asks for chunks — the plane-against-box
 * geometry, the priorities, the prefetch, all of which is the library as it was and none of which
 * knows what a GPU is — and a TSL function that draws (`slice.ts`).  Both read the SAME view
 * matrix, so they cannot disagree about where the card is looking.
 *
 * Getting that wrong is quiet: the first time this was wired, nothing asked for anything and the
 * card drew a perfectly convincing picture out of chunks some other card had fetched.
 *
 * Mouse input on the element becomes navigation — a left drag pans, the wheel moves one voxel along
 * the viewing direction, control and the wheel zooms around the mouse — unless `handleInput` says
 * otherwise.  A board where a drag moves the card asks for a modifier to be held first.
 */
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { CardView } from "#src/gpu/card.js";
import type { Device } from "#src/gpu/device.js";
import type { scanOf } from "#src/gpu/sample.js";
import type { Scan } from "#src/gpu/scan.js";
import { sliceOf } from "#src/gpu/slice.js";
import type { Looking } from "#src/gpu/slice.js";
import { SliceView } from "#src/render/frontend.js";
import type { RenderLayer } from "#src/render/layer.js";
import type { NavigationState } from "#src/state/navigation_state.js";
import type { WatchableValueInterface } from "#src/state/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import { mat4, vec3 } from "#src/util/geom.js";

const tempVec3 = vec3.create();
const tempMat4 = mat4.create();
const tempOffset = new Float32Array(2);

/*
 * A component of a view axis that is nothing, made exactly nothing.
 *
 * The axes come out of a quaternion, and a quaternion made from an axis-aligned rotation and turned
 * back into a matrix leaves a few parts in ten million where there should be zero.  Multiplied by a
 * pixel's offset from the middle of the card that is a millionth of a voxel, which is enough to put
 * a slice exactly on a voxel boundary — where every whole-numbered position IS — on the wrong side
 * of it: measured, the left third of a card read the voxel one back.
 */
function exact(component: number) {
  return Math.abs(component) < 1e-6 ? 0 : component;
}

function hasNoModifiers(event: MouseEvent) {
  return !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
}

function hasOnlyControl(event: MouseEvent) {
  return event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey;
}

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

export class CrossSection extends RefCounted {
  readonly card: CardView;
  /** The asking: which chunks the plane cuts, sent to the worker.  Draws nothing. */
  readonly asking: SliceView;

  /**
   * Whether the view handles `event` itself, rather than leaving it to the page — the view then does
   * not stop the event, so that a board can take the wheel for its own zoom, say.  A view given one
   * of these asks it about every event, including those with a modifier held; one without handles
   * the unmodified ones, plus control and the wheel to zoom.
   */
  handleInput: ((event: MouseEvent) => boolean) | undefined;

  constructor(
    readonly element: HTMLElement,
    device: Device,
    chunkManager: ChunkManager,
    // The volume's layer; `undefined` until it has loaded.
    layer: WatchableValueInterface<RenderLayer | undefined>,
    readonly navigationState: NavigationState,
    shader: ReturnType<typeof scanOf>,
    scan: Scan,
  ) {
    super();
    const view = sliceOf(shader, scan.source, scan.scales);
    this.card = this.registerDisposer(
      new CardView(element, device, {
        material: view.material,
        before: (width, height) => this.frame(view, width, height),
        dispose: () => view.dispose?.(),
      }),
    );
    this.asking = this.registerDisposer(
      new SliceView(chunkManager, layer, navigationState, this.card.visibility),
    );
    this.registerDisposer(this.asking.viewChanged.add(() => this.card.changed()));

    // The canvas covers the element, so the slice itself is the target of both.
    const onSlice = (event: MouseEvent) => element.contains(event.target as Node);

    // What the page says, or the usual rule for a view that was given nothing to say it with.
    const handles = (event: MouseEvent, usual: boolean) =>
      this.handleInput === undefined ? usual : this.handleInput(event);

    const onMouseDown = (event: MouseEvent) => {
      if (!onSlice(event) || event.button !== 0) return;
      if (!handles(event, hasNoModifiers(event))) return;
      event.stopPropagation();
      this.startDrag(event);
      event.preventDefault();
    };

    const onWheel = (event: WheelEvent) => {
      if (!handles(event, hasNoModifiers(event) || hasOnlyControl(event))) return;
      // Control and the wheel zooms, as it does over a page; the wheel alone moves through the
      // slices.
      if (event.ctrlKey || event.metaKey) {
        event.stopPropagation();
        this.zoomByMouse(event, getWheelZoomAmount(event));
        event.preventDefault();
      } else if (onSlice(event)) {
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

  get visibility() {
    return this.card.visibility;
  }

  get renderViewport() {
    return this.card.renderViewport;
  }

  /** Says the card should be drawn again. */
  changed() {
    this.card.changed();
  }

  get valid() {
    return this.asking.valid;
  }

  /** Whether every chunk the card would draw is on the GPU (see `SliceView.isReady`). */
  isReady() {
    return this.asking.isReady();
  }

  /**
   * Once a frame, before the card is drawn: the size it is drawn at is the size its chunks are asked
   * for — and `pixelScale` goes with it, because the matrix divides the zoom by it.  Getting that
   * one number wrong would leave the drawing and the fetching a factor of two apart.
   */
  private frame(view: ReturnType<typeof sliceOf>, width: number, height: number) {
    const { asking } = this;
    asking.projectionParameters.setViewport(this.card.renderViewport);
    asking.flushBackendProjectionParameters();
    /*
     * And where it is looking, out of the same matrix: its columns are the view's own axes with the
     * zoom in them, and its last is the middle.  All of it is the viewer's (z, y, x), which the
     * drawing counts the other way round.
     */
    const m = asking.projectionParameters.value.invViewMatrix;
    // And which scales the asking chose for this zoom, finest first; the drawing goes no finer.
    asking.updateVisibleSources();
    const chosen = asking.visibleSources[0];
    const looking: Looking = {
      at: [m[14], m[13], m[12]],
      right: [exact(m[2]), exact(m[1]), exact(m[0])],
      down: [exact(m[6]), exact(m[5]), exact(m[4])],
      finest: chosen === undefined ? 0 : Math.max(0, asking.sources.indexOf(chosen)),
    };
    view.show(looking);
    view.before?.(width, height);
  }

  // Pans with every pointer move until the button that started the drag is released.
  private startDrag(initialEvent: MouseEvent) {
    const { document } = initialEvent.view!;
    const { button } = initialEvent;
    let prevClientX = initialEvent.clientX;
    let prevClientY = initialEvent.clientY;
    const scale = this.drawnPerScreenPixel(this.element.getBoundingClientRect());
    const onMove = (e: PointerEvent) => {
      const deltaX = (e.clientX - prevClientX) * scale;
      const deltaY = (e.clientY - prevClientY) * scale;
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
        this.asking.projectionParameters.value.invViewMatrix,
      );
    });
  }

  // Position on the page, as an offset in drawn pixels from the center of the card.
  private offsetFromCenter(clientX: number, clientY: number) {
    const { element } = this;
    const { renderViewport } = this.card;
    const bounds = element.getBoundingClientRect();
    const scale = this.drawnPerScreenPixel(bounds);
    tempOffset[0] =
      (clientX - (bounds.left + element.clientLeft)) * scale -
      renderViewport.width / 2;
    tempOffset[1] =
      (clientY - (bounds.top + element.clientTop)) * scale -
      renderViewport.height / 2;
    return tempOffset;
  }

  /**
   * Drawn pixels per pixel on screen.  A card is drawn with as many pixels as `fitScale` allows and
   * stretched over however large it is shown, so a mouse position, which arrives in screen pixels,
   * has to be scaled before it means anything to the projection.
   */
  private drawnPerScreenPixel(bounds: DOMRect) {
    return bounds.width > 0 ? this.card.renderViewport.width / bounds.width : 1;
  }

  /**
   * Returns the point, in the viewer's (z, y, x) coordinates, shown at `clientX`, `clientY` on the
   * page, or `undefined` before the volume has loaded.  Computed from the navigation state rather than
   * the projection parameters, which are updated after a delay.
   */
  pointAt(clientX: number, clientY: number) {
    const { navigationState } = this;
    if (!navigationState.valid) return undefined;
    navigationState.toMat4(tempMat4, this.card.renderViewport.pixelScale);
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
    const { invViewMatrix } = this.asking.projectionParameters.value;
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

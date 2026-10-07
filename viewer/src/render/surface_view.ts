/**
 * @file A card showing papyrus laid flat, drawn on the GPU out of a field of positions.
 *
 * The page's half of `surface_backend.ts`, and the surface analogue of `SliceViewPanel`: it owns a
 * card-sized canvas, joins the display's shared surface so that it is drawn with the same context
 * as every cross-section, and holds the march as a texture (`SurfaceLayer`).
 *
 * The division of labour is the point.  This knows nothing about papyrus — not how a sheet is found,
 * not what a winding is, not which chunks a sheet lands in.  It is handed a field, a window and a
 * list of chunks, and it draws.  Everything that knows what those mean stays in the page's own
 * surface worker, where the march already lives.
 */
import { ChunkState } from "#src/chunk_manager/base.js";
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { RenderViewport } from "#src/render/base.js";
import { SURFACE_VIEW_RPC_ID, SURFACE_VIEW_WANT_RPC_ID } from "#src/render/base.js";
import type { VolumeChunk, VolumeChunkSource } from "#src/render/frontend.js";
import type { DisplayContext, Panel } from "#src/render/panel.js";
import type { RenderLayer } from "#src/render/renderlayer.js";
import type { SurfaceField, SurfaceScale, SurfaceWindow } from "#src/render/surface_layer.js";
import { SurfaceLayer } from "#src/render/surface_layer.js";
import type { WatchableValueInterface } from "#src/state/trackable_value.js";
import { WatchableValue } from "#src/state/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";
import { SharedWatchableValue } from "#src/worker/shared_watchable_value.js";
import { SharedObject } from "#src/worker/worker_rpc.js";

const NEAR_SCREEN_MARGIN = "200px";
// The most pixels a card is drawn with along either side, as for a cross-section.
const MOST = 2048;

/** Which chunks of which scale the sheet lands in, as the card's own worker worked them out. */
export interface SurfaceWant {
  // Index into the volume's scales, finest first.
  level: number;
  // How many voxels of the full-resolution scan one of this scale's voxels covers.  The card's own
  // worker reads the scales itself and knows this; the viewer would otherwise have to derive it.
  factor: number;
  // Chunk grid positions, three to a chunk, nearest the middle of the card first.
  chunks: Float32Array;
}

interface Asked {
  source: VolumeChunkSource;
  factor: number;
  positions: Float32Array;
}

export class SurfaceView extends RefCounted implements Panel {
  private canvas = document.createElement("canvas");
  private context: CanvasRenderingContext2D;
  private layer: SurfaceLayer;
  private shared: SharedObject;
  private window: SurfaceWindow = { plane: "uv", w: 0, from: 0, across: 1, pin: 0.5 };
  private asked: Asked[] = [];
  private boundsGeneration = -1;
  private onScreen = true;
  private nearScreen = true;

  renderViewport = new RenderViewport();
  visibility = new WatchableValue(Number.POSITIVE_INFINITY);

  constructor(
    public element: HTMLElement,
    private display: DisplayContext,
    private chunkManager: ChunkManager,
    // The volume's render layer, which carries its scales; `undefined` until it has loaded.
    private renderLayer: WatchableValueInterface<RenderLayer | undefined>,
  ) {
    super();
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
    // Inside the element it was given; where that element sits among the card's own layers is the
    // card's business, not this one's.
    element.appendChild(canvas);
    this.context = canvas.getContext("2d")!;
    this.registerDisposer(() => canvas.remove());

    this.layer = this.registerDisposer(new SurfaceLayer(display.gl));

    // Exactly as a cross-section judges it: on screen, near its container, or neither — and neither
    // means its chunks are not asked for at all.
    const settle = () => {
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
        settle();
      }, options);
      observer.observe(element);
      this.registerDisposer(() => observer.disconnect());
    };
    observe({}, (intersecting) => (this.onScreen = intersecting));
    observe(
      { root: display.container, rootMargin: NEAR_SCREEN_MARGIN },
      (intersecting) => (this.nearScreen = intersecting),
    );
    this.registerDisposer(
      this.visibility.changed.add(() => display.invalidateBounds()),
    );

    const shared = (this.shared = this.registerDisposer(new SharedObject()));
    shared.RPC_TYPE_ID = SURFACE_VIEW_RPC_ID;
    shared.initializeCounterpart(chunkManager.rpc!, {
      chunkManager: chunkManager.rpcId,
      visibility: this.registerDisposer(
        SharedWatchableValue.makeFromExisting(chunkManager.rpc!, this.visibility),
      ).rpcId,
    });

    // A chunk arriving is the only thing that changes the picture without the card asking.
    this.registerDisposer(
      chunkManager.chunkQueueManager.visibleChunksChanged.add(() =>
        display.scheduleRedraw(),
      ),
    );
  }

  /** Takes a new march.  Once per piece, and again when a winding is taken in. */
  take(field: SurfaceField) {
    this.layer.take(field);
    this.display.scheduleRedraw();
  }

  /** Moves the window.  Uniforms only; nothing is uploaded and nothing is computed. */
  show(window: SurfaceWindow) {
    this.window = window;
    this.display.scheduleRedraw();
  }

  /**
   * Says which chunks the sheet lands in.  Passed to the worker, which asks for them, and kept here
   * so that the draw knows which to bind — coarsest last, so the depth test leaves a coarse pixel
   * only where no finer one landed.
   */
  want(wanted: SurfaceWant[]) {
    const sources = this.renderLayer.value?.getSources();
    if (sources === undefined) return;
    const asked: Asked[] = [];
    const toWorker: { source: number; positions: ArrayBuffer }[] = [];
    for (const { level, factor, chunks } of wanted) {
      const source = sources[level]?.chunkSource as VolumeChunkSource | undefined;
      if (source === undefined) continue;
      asked.push({ source, factor, positions: chunks });
      toWorker.push({ source: source.rpcId!, positions: chunks.slice().buffer });
    }
    this.asked = asked;
    this.chunkManager.rpc!.invoke(SURFACE_VIEW_WANT_RPC_ID, {
      id: this.shared.rpcId,
      wanted: toWorker,
    });
    this.display.scheduleRedraw();
  }

  /**
   * Which of the chunks asked for are on the GPU right now.
   *
   * Asked at the moment of drawing, never remembered: a chunk arrives long after it was asked for,
   * and a list taken when the asking happened is a list of nothing.  This is the same bargain every
   * cross-section makes — draw what is here, and the rest fills in as it lands.
   */
  private resident(): SurfaceScale[] {
    const scales: SurfaceScale[] = [];
    for (const { source, factor, positions } of this.asked) {
      const have: VolumeChunk[] = [];
      for (let at = 0; at + 2 < positions.length; at += 3) {
        const chunk = source.chunks.get(
          `${positions[at]},${positions[at + 1]},${positions[at + 2]}`,
        );
        /*
         * A chunk the store does not have reaches GPU_MEMORY with no texture at all — the volume is
         * sparse and `copyToGPU` leaves it empty rather than uploading zeros.  Binding one of those
         * leaves the sampler reading whatever was there before, which is nothing.
         */
        if (chunk !== undefined && chunk.state === ChunkState.GPU_MEMORY && chunk.texture !== null) {
          have.push(chunk);
        }
      }
      if (have.length !== 0) {
        scales.push({ source, factor, chunkSize: source.spec.chunkDataSize, chunks: have });
      }
    }
    return scales;
  }

  isReady() {
    return true;
  }

  ensureBoundsUpdated() {
    const { display } = this;
    if (display.resizeGeneration === this.boundsGeneration) return;
    this.boundsGeneration = display.resizeGeneration;
    const { element, renderViewport } = this;
    const layoutWidth = Math.max(1, element.offsetWidth);
    const layoutHeight = Math.max(1, element.offsetHeight);
    const most = MOST / Math.max(layoutWidth, layoutHeight);
    const scale = Math.min(2, Math.max(1, most));
    renderViewport.width = Math.round(layoutWidth * scale);
    renderViewport.height = Math.round(layoutHeight * scale);
    renderViewport.pixelScale = scale;
  }

  releaseCanvas() {
    const { canvas } = this;
    canvas.width = 0;
    canvas.height = 0;
  }

  draw() {
    const { canvas, context, display } = this;
    const { gl, surface } = display;
    const { width, height } = this.renderViewport;
    if (width === 0 || height === 0) return;
    gl.enable(WebGL2RenderingContext.SCISSOR_TEST);
    gl.viewport(0, surface.height - height, width, height);
    gl.scissor(0, surface.height - height, width, height);
    // Transparent where the piece has no sheet, so the card's own background shows through.
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(
      WebGL2RenderingContext.COLOR_BUFFER_BIT |
        WebGL2RenderingContext.DEPTH_BUFFER_BIT,
    );
    // Off while something other than the papyrus is being drawn, or the first pass would write the
    // depth and hide every chunk after it.
    if ((this.window.show ?? 0) === 0) {
      gl.enable(WebGL2RenderingContext.DEPTH_TEST);
      gl.depthFunc(WebGL2RenderingContext.LESS);
    }
    gl.disable(WebGL2RenderingContext.BLEND);
    this.layer.draw(this.resident(), this.window);
    gl.disable(WebGL2RenderingContext.DEPTH_TEST);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.clearRect(0, 0, width, height);
    context.drawImage(surface, 0, 0, width, height, 0, 0, width, height);
  }
}

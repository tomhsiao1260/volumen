/**
 * @file A card of papyrus laid flat: a card, the march it draws from, and the chunks it asks for.
 *
 * Three things are pushed in from the page's own worker, because only it knows them: the march
 * (`take`), where the card is looking (`show`), and which chunks the sheet lands in (`want`).
 * Everything else — whether those chunks have arrived, and therefore whether the march that is
 * waiting may replace the one being drawn — is decided here, where both are known.
 *
 * And the pages.  The march is a table of scan positions, and it is HERE, on this thread: which
 * pages of the atlas the card's window lands in is arithmetic over that table, as a cross-section's
 * pages are arithmetic over its plane (`pages.ts`).  So the card places an order for them, and for
 * the pages of the sheet either side — where a hand turning through the sheets is going — and they
 * go up as soon as their chunks are here, before the frame that needs them.  Without that a flat
 * card got its pages the slow way, drawn with holes and read back, and turning through the sheets
 * felt heavier than stepping through the slices: every sheet was a frame or two of blur first.
 */
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { PAGE } from "#src/gpu/atlas.js";
import { CardView } from "#src/gpu/card.js";
import type { Device } from "#src/gpu/device.js";
import { Field } from "#src/gpu/field.js";
import type { Made, Said } from "#src/gpu/field.js";
import { packPage } from "#src/gpu/pages.js";
import type { Order } from "#src/gpu/pages.js";
import type { scanOf } from "#src/gpu/sample.js";
import type { Scan } from "#src/gpu/scan.js";
import { surfaceOf } from "#src/gpu/surface.js";
import type { Window } from "#src/gpu/surface.js";
import { Wanting } from "#src/gpu/wanting.js";
import type { Wanted } from "#src/gpu/wanting.js";
import type { RenderLayer } from "#src/render/layer.js";
import type { WatchableValueInterface } from "#src/state/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";

/*
 * How finely the window is sampled when its pages are worked out: this many points across and this
 * many down.  A page is 64 voxels and the nodes of a march are a few voxels apart, so a sample every
 * few nodes finds every page a sheet passes through; a thousand samples a level is well under a
 * millisecond.
 */
const SAMPLES = 32;

export class FlatCard extends RefCounted {
  readonly card: CardView;
  private readonly field: Field;
  private readonly wanting: Wanting;
  private readonly view: ReturnType<typeof surfaceOf>;
  private settled = false;
  // What the march being drawn asked for, kept until the one waiting can be drawn instead.
  private keeping: Wanted[] = [];
  // The levels the worker last asked chunks for, finest first: the scales worth ordering pages at.
  private levels: number[] = [];
  private window: Window = { at: [0, 0, 0], right: [0, 0, 0], down: [0, 0, 0] };
  // What was last ordered, so that a frame that changed nothing orders nothing.
  private ordered = "";

  /** Told when every chunk of the finest scale asked for has arrived, and when that stops. */
  onSettled: ((settled: boolean) => void) | undefined;

  constructor(
    readonly element: HTMLElement,
    device: Device,
    chunkManager: ChunkManager,
    // The volume's layer; `undefined` until it has loaded.
    layer: WatchableValueInterface<RenderLayer | undefined>,
    shader: ReturnType<typeof scanOf>,
    private readonly scan: Scan,
  ) {
    super();
    this.field = this.registerDisposer(new Field(device));
    const view = (this.view = surfaceOf(device, shader, scan.source, scan.scales, this.field));
    this.card = this.registerDisposer(
      new CardView(element, device, {
        material: view.material,
        // The pages are ordered from the table, but the shader may still find one missing — a
        // sample between two nodes can land in a page neither node did — so a frame with this card
        // in it is read back as well.
        asks: true,
        before: (width, height) => {
          /*
           * Asked once a frame, because a chunk arrives long after it was asked for.  This is both
           * what lets the waiting march through and what tells the card to stop saying it is
           * loading.
           */
          const now = this.wanting.settled();
          this.field.settled(now);
          if (now !== this.settled) {
            this.settled = now;
            this.onSettled?.(now);
          }
          // The march being drawn may have just changed, and with it every page the window lands in.
          this.order();
          view.before?.(width, height);
        },
        dispose: () => view.dispose?.(),
      }),
    );
    this.wanting = this.registerDisposer(new Wanting(chunkManager, layer, this.card.visibility));
    this.registerDisposer(() => scan.forget(this));
  }

  get visibility() {
    return this.card.visibility;
  }

  /** Whether the chunks of the finest scale asked for are all here. */
  isReady() {
    return this.settled;
  }

  /** Takes a new march.  Once per piece, and again when a winding is taken in. */
  take(said: Said) {
    this.field.take(said);
    this.card.changed();
  }

  /** Moves the window.  Uniforms only, and the pages it now lands in; nothing is computed. */
  show(window: Window) {
    this.window = window;
    this.view.show({ ...window, finest: this.levels[0] ?? 0 });
    this.order();
    this.card.changed();
  }

  /**
   * Says which chunks the sheet lands in.  The worker then asks for exactly those.
   *
   * The chunks the march being drawn needs are asked for alongside the ones the march waiting
   * needs, until the waiting one takes over.  Holding the old march is not enough on its own: the
   * moment a new list goes to the queue, the old chunks stop being wanted, are dropped, and take
   * their pages with them — so the card keeps a march it can no longer draw and goes blank anyway.
   * Measured on a swept cut, two frames in sixty fell to almost nothing, and this is what they were.
   *
   * The new list goes first, because `settled` asks about the finest scale of the first.
   */
  want(wanted: Wanted[]) {
    this.wanting.want(
      this.settled || this.keeping.length === 0 ? wanted : [...wanted, ...this.keeping],
    );
    this.keeping = wanted;
    this.levels = wanted.map((one) => one.level);
    this.ordered = "";
    // The finest scale may have changed with the list; the window is said again with it.
    this.view.show({ ...this.window, finest: this.levels[0] ?? 0 });
    this.card.changed();
  }

  /**
   * The pages the window lands in, at every scale the worker asked chunks for, and the pages of the
   * sheet either side of it — placed as this card's order with the scan.
   *
   * Worked out by sampling the window: a grid of points across and down the card, each a node of
   * the march (the nearest), each a position in the scroll, each a page.  That is the same for the
   * sheet laid flat and for a cut across the stack, which is the point of the window being affine.
   */
  private order() {
    const held = this.field.now;
    if (held === undefined) return;
    const levels = this.levels.length > 0 ? this.levels : this.scan.scales.map((one) => one.level);
    const { at, right, down, through } = this.window;
    const key = `${held.said.lattice}|${at}|${right}|${down}|${through?.from}|${through?.across}|${levels}|${this.field.generation}`;
    if (key === this.ordered) return;
    this.ordered = key;
    const orders = new Map<number, Order>();
    for (const level of levels) {
      const scale = this.scan.scales[level];
      if (scale === undefined) continue;
      orders.set(level, {
        cut: pagesOf(held, this.window, scale.factor, 0),
        near: pagesOf(held, this.window, scale.factor, 1),
      });
    }
    this.scan.order(this, orders);
  }
}

/**
 * The pages a window on `held` lands in at a scale of `factor`, `aside` whole sheets away from
 * where it is looking — 0 for the sheet itself, 1 for the sheets either side.
 */
function pagesOf(held: Made, window: Window, factor: number, aside: number): number[] {
  const { said } = held;
  const { nu, nv, layers, per, K, lattice, data, walk, lo, hi } = said;
  const found = new Set<number>();
  // The window is said on the plane; the table starts at `lattice` on it (see `surfaceOf.before`).
  const u0 = window.at[0] - lattice[1];
  const v0 = window.at[1] - lattice[0];
  const w0 = window.at[2];
  const { right, down, through } = window;
  const span = Math.max(1e-6, hi - lo);
  const sheets = aside === 0 ? [0] : [-aside, aside];
  for (const sheet of sheets)
    for (let j = 0; j < SAMPLES; j++) {
      const b = (j + 0.5) / SAMPLES;
      for (let i = 0; i < SAMPLES; i++) {
        const a = (i + 0.5) / SAMPLES;
        const u = u0 + right[0] * a + down[0] * b;
        const v = v0 + right[1] * a + down[1] * b;
        let w: number;
        if (through === undefined) w = w0 + right[2] * a + down[2] * b;
        else {
          // Across the sheets by distance: the walk says which winding is this far through.
          const far = through.from + b * through.across;
          const t = Math.min(1, Math.max(0, (far - lo) / span));
          const k = t * (walk.length - 1);
          const k0 = Math.floor(k);
          const k1 = Math.min(walk.length - 1, k0 + 1);
          w = walk[k0] + (walk[k1] - walk[k0]) * (k - k0);
        }
        w += sheet;
        const layer = Math.round((w + K) * per);
        if (layer < 0 || layer >= layers) continue;
        const ui = Math.round(u), vi = Math.round(v);
        if (ui < 0 || ui >= nu || vi < 0 || vi >= nv) continue;
        const o = ((layer * nv + vi) * nu + ui) * 4;
        // Not reached: the march has no position here.
        if (data[o + 3] < 0.5) continue;
        // The table holds (z, y, x); pages are counted (x, y, z), in the scale's own voxels.
        const x = Math.floor(((data[o + 2] + 0.5) / factor - 0.5) / PAGE);
        const y = Math.floor(((data[o + 1] + 0.5) / factor - 0.5) / PAGE);
        const z = Math.floor(((data[o] + 0.5) / factor - 0.5) / PAGE);
        if (x < 0 || y < 0 || z < 0 || x > 1023 || y > 1023 || z > 1023) continue;
        found.add(packPage(x, y, z));
      }
    }
  return [...found];
}

/**
 * @file A card of papyrus laid flat: a card, the march it draws from, and the chunks it asks for.
 *
 * Three things are pushed in from the page's own worker, because only it knows them: the march
 * (`take`), where the card is looking (`show`), and which chunks the sheet lands in (`want`).
 * Everything else — whether those chunks have arrived, and therefore whether the march that is
 * waiting may replace the one being drawn — is decided here, where both are known.
 */
import type { ChunkManager } from "#src/chunk_manager/frontend.js";
import { CardView } from "#src/gpu/card.js";
import type { Device } from "#src/gpu/device.js";
import { Field } from "#src/gpu/field.js";
import type { Said } from "#src/gpu/field.js";
import type { scanOf } from "#src/gpu/sample.js";
import type { Scan } from "#src/gpu/scan.js";
import { surfaceOf } from "#src/gpu/surface.js";
import type { Window } from "#src/gpu/surface.js";
import { Wanting } from "#src/gpu/wanting.js";
import type { Wanted } from "#src/gpu/wanting.js";
import type { RenderLayer } from "#src/render/layer.js";
import type { WatchableValueInterface } from "#src/state/trackable_value.js";
import { RefCounted } from "#src/util/disposable.js";

export class FlatCard extends RefCounted {
  readonly card: CardView;
  private readonly field: Field;
  private readonly wanting: Wanting;
  private readonly view: ReturnType<typeof surfaceOf>;
  private settled = false;
  // What the march being drawn asked for, kept until the one waiting can be drawn instead.
  private keeping: Wanted[] = [];

  /** Told when every chunk of the finest scale asked for has arrived, and when that stops. */
  onSettled: ((settled: boolean) => void) | undefined;

  constructor(
    readonly element: HTMLElement,
    device: Device,
    chunkManager: ChunkManager,
    // The volume's layer; `undefined` until it has loaded.
    layer: WatchableValueInterface<RenderLayer | undefined>,
    shader: ReturnType<typeof scanOf>,
    scan: Scan,
  ) {
    super();
    this.field = this.registerDisposer(new Field(device));
    const view = (this.view = surfaceOf(device, shader, scan.source, scan.scales, this.field));
    this.card = this.registerDisposer(
      new CardView(element, device, {
        material: view.material,
        // The march is only the worker's to know, so the pages a sheet lands in are the shader's
        // to ask for, and a frame with this card in it is read back.
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
          view.before?.(width, height);
        },
        dispose: () => view.dispose?.(),
      }),
    );
    this.wanting = this.registerDisposer(new Wanting(chunkManager, layer, this.card.visibility));
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

  /** Moves the window.  Uniforms only; nothing is uploaded and nothing is computed. */
  show(window: Window) {
    this.view.show(window);
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
    this.card.changed();
  }
}

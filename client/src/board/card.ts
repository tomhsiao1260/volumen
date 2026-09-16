/**
 * @file One card: a frame in board coordinates showing a cross-section of the source it names.  A
 * card with no source shows a form instead (see `source_panel.ts`), and each card has its own
 * navigation group, so it steps through slices on its own; a later round links cards so that their
 * coordinates move together.
 */

import type { View, ViewOrientation, Volume } from "viewer";
import type { Board } from "./board";
import type { LinkGroup } from "./links";
import { createSourcePanel } from "./source_panel";
import type { Source } from "./sources";

export interface CardRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MIN_CARD_SIZE = 140;

let nextCardId = 0;

const ORIENTATIONS: ViewOrientation[] = ["xy", "xz", "yz"];

export class Card {
  readonly element = document.createElement("div");
  // The view's element.  The viewer puts its canvas inside it, so it must have no border or padding.
  readonly slice = document.createElement("div");
  // Shows the source form, or how the volume is doing, on top of the slice.
  private overlay = document.createElement("div");
  private orientationSelect = document.createElement("select");
  private link = document.createElement("button");
  private viewChangedListener: (() => void) | undefined;
  source: Source | undefined;
  view: View | undefined;

  constructor(
    private board: Board,
    public rect: CardRect,
    public orientation: ViewOrientation,
    // The cards this one moves with; a new card is in a group of its own.
    public group: LinkGroup,
    // Names the card in the saved board.
    readonly id = `c${nextCardId++}`,
  ) {
    const { element, slice, overlay, orientationSelect } = this;
    element.className = "card";
    slice.className = "card-slice";
    overlay.className = "card-overlay";

    const header = document.createElement("div");
    header.className = "card-header";
    for (const value of ORIENTATIONS) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value.toUpperCase();
      orientationSelect.append(option);
    }
    orientationSelect.value = orientation;
    orientationSelect.className = "card-orientation";
    orientationSelect.title = "The plane this card shows";
    orientationSelect.addEventListener("change", () =>
      this.setOrientation(orientationSelect.value as ViewOrientation),
    );
    const name = document.createElement("span");
    name.className = "card-name";
    this.link.className = "card-link";
    this.link.addEventListener("click", () => {
      // While another card is waiting to be linked, this one is the target, whichever part of it is
      // clicked; clicking the waiting card's own badge gives up instead.
      const { linkFrom } = board;
      if (linkFrom === this) board.stopLinking();
      else if (linkFrom !== undefined) board.linkCards(linkFrom, this);
      else if (this.group.linked) board.unlinkCard(this);
      else board.startLinking(this);
    });
    const close = document.createElement("button");
    close.className = "card-close";
    close.textContent = "✕";
    close.title = "Remove this card";
    close.addEventListener("click", () => board.removeCard(this));
    header.append(orientationSelect, name, this.link, close);
    this.name = name;
    group.members.add(this);

    const resize = document.createElement("div");
    resize.className = "card-resize";
    resize.title = "Resize";

    element.append(header, slice, overlay, resize);
    board.layer.append(element);
    this.applyRect();
    this.showLink();
    this.showForm();
  }

  private name: HTMLElement;

  // Shows the source `source` holds, loading its volume if no other card has.
  setSource(source: Source) {
    this.source = source;
    this.name.textContent = this.board.sourceName(source);
    this.name.title = [source.local, source.http].filter((x) => x !== "").join("\n");
    this.showView(this.board.volumes.get(source.id));
    this.board.reportChanged();
    // A card linked to empty cards hands them its source, so that a new linked set only has to be
    // given one.
    for (const card of this.group.members) {
      if (card.source === undefined) card.setSource(source);
    }
  }

  // Moves this card into `group`, whose position and zoom it then shares.
  setGroup(group: LinkGroup) {
    if (group === this.group) return;
    this.group.members.delete(this);
    this.group = group;
    group.members.add(this);
    const { source } = this;
    // A view looks through its group's position and zoom, so it is added again for the new group.
    if (source !== undefined) this.showView(this.board.volumes.get(source.id));
    this.board.reportChanged();
  }

  // Shows whether this card is linked, and to how many others.
  showLink() {
    const { linked, hue, members } = this.group;
    this.link.textContent = linked ? `\u26D3 ${members.size}` : "\u26D3";
    this.link.title =
      this.board.linkFrom === this
        ? "Click another card to link it to this one, or click here again to give up"
        : this.board.linkFrom !== undefined
          ? "Link this card to the one waiting"
          : linked
            ? `Linked to ${members.size - 1} other card${members.size === 2 ? "" : "s"}; click to unlink`
            : "Link this card to another, so that they move together";
    this.link.classList.toggle("linked", linked);
    this.element.style.setProperty("--group-hue", String(hue));
    this.element.classList.toggle("grouped", linked);
  }

  get navigation() {
    return this.group.navigation;
  }

  setOrientation(orientation: ViewOrientation) {
    if (orientation === this.orientation) return;
    this.orientation = orientation;
    this.orientationSelect.value = orientation;
    // A view shows one plane for its whole life, but adding it again costs no downloads.
    const { source } = this;
    if (source !== undefined) this.showView(this.board.volumes.get(source.id));
    this.board.reportChanged();
  }

  setRect(rect: CardRect) {
    this.rect = rect;
    this.applyRect();
    this.board.reportChanged();
    // Nothing else to do: the slice is drawn in a canvas inside the card, so it moves with it, and
    // resizing the card resizes that element, which the viewer is already watching.
  }

  moveBy(deltaX: number, deltaY: number) {
    const { x, y, width, height } = this.rect;
    this.setRect({ x: x + deltaX, y: y + deltaY, width, height });
  }

  resizeBy(deltaX: number, deltaY: number) {
    const { x, y, width, height } = this.rect;
    this.setRect({
      x,
      y,
      width: Math.max(MIN_CARD_SIZE, width + deltaX),
      height: Math.max(MIN_CARD_SIZE, height + deltaY),
    });
  }

  dispose() {
    this.disposeView();
    this.group.members.delete(this);
    this.element.remove();
  }

  private showForm() {
    this.setOverlay(
      createSourcePanel({
        defaults: this.board.sourceDefaults(),
        onChosen: (source) => this.setSource(source),
      }),
    );
  }

  private showView(volume: Volume) {
    this.disposeView();
    const navigation = this.group.navigationFor(volume);
    this.viewChangedListener = navigation.onViewChanged(() =>
      this.board.reportViewChanged(),
    );
    this.view = this.board.viewer.addView(this.slice, {
      volume,
      orientation: this.orientation,
      navigation,
    });
    // The board owns the mouse button: a drag moves the card, and with Alt it pans the slice.  The
    // wheel stays with the view, which steps through slices and zooms with Control.
    this.view.handleInput = (event) => event.type === "wheel";

    this.setOverlay(this.message("Loading…"));
    const { view } = this;
    volume.loaded.then(
      () => {
        // The card may have been removed, or given another source, while it loaded.
        if (this.view !== view) return;
        this.setOverlay(undefined);
      },
      (error) => {
        if (this.view !== view) return;
        console.error("Failed to load the volume:", error);
        const message = this.message(
          "Could not load this source. See the browser console for details.",
        );
        const retry = document.createElement("button");
        retry.textContent = "Change the source";
        retry.addEventListener("click", () => {
          this.disposeView();
          this.source = undefined;
          this.name.textContent = "";
          this.showForm();
        });
        message.append(retry);
        this.setOverlay(message);
      },
    );
  }

  // The group's position and zoom belong to the board, so only the view and its listener go.
  private disposeView() {
    this.view?.dispose();
    this.viewChangedListener?.();
    this.view = undefined;
    this.viewChangedListener = undefined;
  }

  private message(text: string) {
    const element = document.createElement("div");
    element.className = "card-message";
    element.append(document.createTextNode(text));
    return element;
  }

  private setOverlay(content: HTMLElement | undefined) {
    this.overlay.replaceChildren(...(content === undefined ? [] : [content]));
    this.overlay.hidden = content === undefined;
  }

  private applyRect() {
    const { style } = this.element;
    const { x, y, width, height } = this.rect;
    style.left = `${x}px`;
    style.top = `${y}px`;
    style.width = `${width}px`;
    style.height = `${height}px`;
  }
}

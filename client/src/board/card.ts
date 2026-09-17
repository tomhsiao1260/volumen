/**
 * @file One card: a frame in board coordinates showing a cross-section of the source it names.  A
 * card with no source asks which one to show instead (see `scroll_picker.ts`).
 *
 * The card's frame is the data and nothing else, so it can be made square; what the card says about
 * itself — the plane, the scan, the voxel it is looking at — floats just above and just below the
 * frame, over the board rather than over the data.  All of it stays on screen, because that is what
 * makes a card readable while working and worth a screenshot.  The controls — the link, the close and
 * the resize corner — appear under the pointer.  The lines are also what the card is dragged by;
 * dragging the data pans the slice.
 */

import type { Point, View, ViewOrientation, Volume } from "viewer";
import type { Board } from "./board";
import type { LinkGroup } from "./links";
import { createScrollPicker } from "./scroll_picker";
import type { Source } from "./sources";

export interface CardRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MIN_CARD_SIZE = 140;

function formatVoxel({ x, y, z }: Point) {
  return `x ${Math.round(x)} · y ${Math.round(y)} · z ${Math.round(z)}`;
}

let nextCardId = 0;

const ORIENTATIONS: ViewOrientation[] = ["xy", "xz", "yz"];

// A scan is named for the card without saying that it is masked, which nearly all of them are.
function shorten(name: string) {
  return name.replace(/\s*·\s*masked$/, "");
}

export class Card {
  readonly element = document.createElement("div");
  // The view's element.  The viewer puts its canvas inside it, so it must have no border or padding.
  readonly slice = document.createElement("div");
  // Shows the source form, or how the volume is doing, on top of the slice.
  private overlay = document.createElement("div");
  private plane = document.createElement("button");
  private planeMenu = document.createElement("div");
  private link = document.createElement("button");
  // Where the card is looking, and the voxel under the pointer while there is one.
  private centre = document.createElement("span");
  private pointer = document.createElement("span");
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
    const { element, slice, overlay, plane, planeMenu } = this;
    element.className = "card";
    slice.className = "card-slice";
    overlay.className = "card-overlay";

    const header = document.createElement("div");
    header.className = "card-top";
    plane.className = "card-plane";
    plane.title = "The plane this card shows";
    plane.textContent = orientation.toUpperCase();
    planeMenu.className = "card-plane-menu";
    planeMenu.hidden = true;
    for (const value of ORIENTATIONS) {
      const choice = document.createElement("button");
      choice.textContent = value.toUpperCase();
      choice.addEventListener("click", () => {
        planeMenu.hidden = true;
        this.setOrientation(value);
      });
      planeMenu.append(choice);
    }
    plane.addEventListener("click", () => {
      planeMenu.hidden = !planeMenu.hidden;
    });
    plane.addEventListener("blur", () => {
      // Let a click on the menu land before it closes.
      setTimeout(() => (planeMenu.hidden = true), 120);
    });
    const planes = document.createElement("span");
    planes.className = "card-planes";
    planes.append(plane, planeMenu);
    const name = document.createElement("span");
    name.className = "card-name";
    this.link.className = "card-link";
    // The badge is there only while the card is linked, and a click is how it stops being.
    this.link.addEventListener("click", () => board.unlinkCard(this));
    const close = document.createElement("button");
    close.className = "card-close";
    close.textContent = "✕";
    close.title = "Remove this card";
    close.addEventListener("click", () => board.removeCard(this));
    header.append(planes, name, this.link, close);
    this.name = name;
    group.members.add(this);

    const resize = document.createElement("div");
    resize.className = "card-resize";
    resize.title = "Resize";

    const footer = document.createElement("div");
    footer.className = "card-bottom";
    this.centre.className = "card-centre";
    this.pointer.className = "card-pointer";
    footer.append(this.centre, this.pointer);

    // The frame: the slice and whatever covers it, with the two lines floating outside it.
    const body = document.createElement("div");
    body.className = "card-body";
    body.append(slice, overlay, resize);

    element.append(header, body, footer);
    board.layer.append(element);
    this.applyRect();
    this.showLink();
    this.showForm();
  }

  private name: HTMLElement;

  // Shows the source `source` holds, loading its volume if no other card has.
  setSource(source: Source) {
    this.source = source;
    this.name.textContent = shorten(this.board.sourceName(source));
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

  // Shows where the card is looking; kept on screen for reading and for screenshots.
  showPosition() {
    const position = this.navigation?.position;
    this.centre.textContent = position === undefined ? "" : formatVoxel(position);
  }

  /**
   * Shows the voxel under the pointer in place of the card's own, since the two mean the same thing
   * and one line has room for one of them; the card's own is back as soon as the pointer leaves.
   */
  showPointer(point: Point | undefined) {
    this.pointer.textContent = point === undefined ? "" : formatVoxel(point);
    this.pointer.hidden = point === undefined;
    this.centre.hidden = point !== undefined;
  }

  // Shows whether this card is linked, and to how many others.
  showLink() {
    const { linked, hue, members } = this.group;
    this.link.textContent = `\u26D3 ${members.size}`;
    this.link.title = `Moves with ${members.size - 1} other card${
      members.size === 2 ? "" : "s"
    }; click to leave them`;
    this.link.hidden = !linked;
    this.element.style.setProperty("--group-hue", String(hue));
    this.element.classList.toggle("grouped", linked);
  }

  get navigation() {
    return this.group.navigation;
  }

  setOrientation(orientation: ViewOrientation) {
    if (orientation === this.orientation) return;
    this.orientation = orientation;
    this.plane.textContent = orientation.toUpperCase();
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
      createScrollPicker({ onChosen: (source) => this.setSource(source) }),
    );
  }

  private showView(volume: Volume) {
    this.disposeView();
    const navigation = this.group.navigationFor(volume);
    this.viewChangedListener = navigation.onViewChanged(() => {
      this.showPosition();
      this.board.reportViewChanged();
    });
    this.view = this.board.viewer.addView(this.slice, {
      volume,
      orientation: this.orientation,
      navigation,
    });
    // Dragging the data pans the slice and the wheel steps through the slices, both of which the
    // view does itself; the card is moved by the lines outside it instead (see `gestures.ts`).

    this.setOverlay(this.message("Loading…"));
    const { view } = this;
    volume.loaded.then(
      () => {
        // The card may have been removed, or given another source, while it loaded.
        if (this.view !== view) return;
        this.setOverlay(undefined);
        this.showPosition();
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

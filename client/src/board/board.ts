/**
 * @file The board: the cards, their layout in board coordinates, and the board's own pan and zoom.
 */

import type { Point, View, ViewOrientation } from "viewer";
import type { Viewer } from "viewer";
import type { CardRect } from "./card";
import { Card } from "./card";
import { bindGestures } from "./gestures";
import { LinkGroup } from "./links";
import type { Source, VolumeRegistry } from "./sources";
import { sourceLabel } from "./sources";
import type { StoredBoard } from "./storage";
import type { BoardTransform, Point2D } from "./transform";
import { cssTransform, fitTo, toBoard } from "./transform";

// Size of a new card, and the space left between cards put down together, in board units.
export const CARD_WIDTH = 340;
export const CARD_HEIGHT = 300;
export const CARD_GAP = 16;

export interface BoardOptions {
  viewer: Viewer;
  // The volumes of the sources the cards name.
  volumes: VolumeRegistry;
  // The viewer's container, which the board fills.
  element: HTMLElement;
  // The element inside it that carries the board's transform; the cards are its children.
  layer: HTMLElement;
}

export class Board {
  transform: BoardTransform = { x: 0, y: 0, scale: 1 };
  readonly cards: Card[] = [];
  // Called whenever anything the saved board holds has changed.  Set once the board has been put
  // back, so that putting it back does not save it again.
  onChanged: (() => void) | undefined;
  // The cards the keyboard and a drag act on: one clicked, or a whole area picked out.
  readonly selection = new Set<Card>();
  // What was copied, and the group each pasted card joins (see `copySelected`).
  private copied:
    | {
        cards: {
          source: Source | undefined;
          orientation: ViewOrientation;
          rect: CardRect;
          group: LinkGroup;
        }[];
        // How far to the right the next paste goes, so that pasting twice does not stack.
        offset: number;
        step: number;
      }
    | undefined;
  private appliedScale = 1;
  private nextZIndex = 1;
  private viewChangedListeners: (() => void)[] = [];

  constructor(private options: BoardOptions) {
    this.applyTransform();
    bindGestures(this);
  }

  get viewer() {
    return this.options.viewer;
  }

  get volumes() {
    return this.options.volumes;
  }

  get element() {
    return this.options.element;
  }

  get layer() {
    return this.options.layer;
  }

  sourceName(source: Source) {
    return sourceLabel(source);
  }

  // Adds a card at a board position.  It shows nothing until it is given a source, and moves on its
  // own unless it is given a group to share a position and zoom with.
  addCard(
    { x, y }: { x: number; y: number },
    orientation: ViewOrientation = "xy",
    group = new LinkGroup(),
    rect?: { width: number; height: number },
    id?: string,
  ) {
    const card = new Card(
      this,
      {
        x,
        y,
        width: rect?.width ?? CARD_WIDTH,
        height: rect?.height ?? CARD_HEIGHT,
      },
      orientation,
      group,
      id,
    );
    this.cards.push(card);
    this.bringToFront(card);
    this.showLinks();
    this.reportViewChanged();
    return card;
  }

  /**
   * Adds three linked cards side by side, showing the XY, XZ and YZ planes: the three views this
   * page had before it became a board.  Giving one of them a source gives it to all three.
   */
  addLinkedCards({ x, y }: { x: number; y: number }) {
    const group = new LinkGroup();
    return (["yz", "xy", "xz"] as ViewOrientation[]).map((orientation, index) =>
      this.addCard(
        { x: x + index * (CARD_WIDTH + CARD_GAP), y },
        orientation,
        group,
      ),
    );
  }

  isSelected(card: Card) {
    return this.selection.has(card);
  }

  // Selects this card alone, or nothing.  Clicking a card does this, and clicking the board clears.
  selectOnly(card: Card | undefined) {
    this.selection.clear();
    if (card !== undefined) this.selection.add(card);
    this.showSelection();
  }

  clearSelection() {
    if (this.selection.size === 0) return;
    this.selection.clear();
    this.showSelection();
  }

  // Adds or removes one card, which is what a click with Shift does.
  toggleSelected(card: Card) {
    if (!this.selection.delete(card)) this.selection.add(card);
    this.showSelection();
  }

  // Selects every card the area between two board points touches, however little.
  selectWithin(from: Point2D, to: Point2D) {
    const left = Math.min(from.x, to.x);
    const right = Math.max(from.x, to.x);
    const top = Math.min(from.y, to.y);
    const bottom = Math.max(from.y, to.y);
    this.selection.clear();
    for (const card of this.cards) {
      const { x, y, width, height } = card.rect;
      if (x < right && x + width > left && y < bottom && y + height > top) {
        this.selection.add(card);
      }
    }
    this.showSelection();
  }

  // Moves everything selected, which is how a selected card is dragged.
  moveSelectionBy(deltaX: number, deltaY: number) {
    for (const card of this.selection) card.moveBy(deltaX, deltaY);
  }

  private showSelection() {
    for (const card of this.cards) {
      card.element.classList.toggle("selected", this.selection.has(card));
    }
  }

  // Remembers the selected cards for `pasteCopy`.  Returns false if nothing is selected.
  copySelected() {
    if (this.selection.size === 0) return false;
    const cards = [...this.selection].map((card) => ({
      source: card.source,
      orientation: card.orientation,
      rect: { ...card.rect },
      group: card.group,
    }));
    const left = Math.min(...cards.map((card) => card.rect.x));
    const right = Math.max(...cards.map((card) => card.rect.x + card.rect.width));
    const step = right - left + CARD_GAP;
    this.copied = { cards, offset: step, step };
    return true;
  }

  /**
   * Adds a copy of each card that was copied, beside the originals and linked to them: same scan,
   * same plane, same place.  Changing a copy's plane is then the way to see that place another way,
   * which is what linked cards are for.  Pasting again puts the next copies further along.
   */
  pasteCopy() {
    const copied = this.copied;
    if (copied === undefined) return false;
    const pasted = copied.cards.map((card) => {
      // Nothing is left of a group whose cards have all been removed since the copy.
      const group = card.group.members.size > 0 ? card.group : new LinkGroup();
      const rect = { ...card.rect, x: card.rect.x + copied.offset };
      const added = this.addCard(rect, card.orientation, group, rect);
      if (card.source !== undefined) added.setSource(card.source);
      return added;
    });
    copied.offset += copied.step;
    this.selection.clear();
    for (const card of pasted) this.selection.add(card);
    this.showSelection();
    return pasted;
  }

  // Takes `card` out of its group, leaving it where it is.
  unlinkCard(card: Card) {
    const previous = card.group.navigation;
    const position = previous?.position;
    const zoom = previous?.zoom;
    card.setGroup(new LinkGroup());
    const navigation = card.group.navigation;
    if (navigation !== undefined) {
      if (position !== undefined) navigation.setPosition(position);
      if (zoom !== undefined) navigation.setZoom(zoom);
    }
    this.showLinks();
  }

  // Shows every card's link state, which changes for a whole group at a time.
  showLinks() {
    for (const card of this.cards) card.showLink();
  }

  removeCard(card: Card) {
    const index = this.cards.indexOf(card);
    if (index < 0) return;
    this.selection.delete(card);
    this.cards.splice(index, 1);
    const { group } = card;
    card.dispose();
    // The last card of a group takes its shared position and zoom with it.
    if (group.members.size === 0) group.dispose();
    this.showLinks();
    this.reportViewChanged();
  }

  bringToFront(card: Card) {
    card.element.style.zIndex = String(this.nextZIndex++);
  }

  // The card containing `target`, if any.
  cardAt(target: EventTarget | null) {
    if (!(target instanceof Node)) return undefined;
    return this.cards.find((card) => card.element.contains(target));
  }

  cardOfView(view: View) {
    return this.cards.find((card) => card.view === view);
  }

  // Shows the voxel under the pointer on the card it is over, and on no other.
  showPointer(view: View, point: Point | undefined) {
    for (const card of this.cards) {
      card.showPointer(card.view === view ? point : undefined);
    }
  }

  // Moves the board so that every card is in view.
  fitToCards() {
    if (this.cards.length === 0) return;
    const bounds = this.element.getBoundingClientRect();
    this.transform = fitTo(
      this.cards.map((card) => card.rect),
      { width: bounds.width, height: bounds.height },
    );
    this.applyTransform();
  }

  // The board point at a position on the page.
  pointAt(clientX: number, clientY: number) {
    const bounds = this.element.getBoundingClientRect();
    return toBoard(this.transform, clientX - bounds.left, clientY - bounds.top);
  }

  // Shows the board at its current pan and zoom.
  applyTransform() {
    this.reportChanged();
    this.layer.style.transform = cssTransform(this.transform);
    // Panning needs nothing else: each card's slice is drawn in a canvas inside the card, which the
    // transform moves along with it.  Zooming changes how large the cards are on screen, and so how
    // much of the volume each pixel covers, which the viewer has to measure again.
    if (this.transform.scale !== this.appliedScale) {
      this.appliedScale = this.transform.scale;
      this.viewer.invalidateBounds();
    }
  }

  // Calls `callback` whenever a card is added or removed, or any card's position or zoom changes.
  onViewChanged(callback: () => void) {
    this.viewChangedListeners.push(callback);
  }

  reportViewChanged() {
    for (const callback of this.viewChangedListeners) callback();
    this.reportChanged();
  }

  // Says that something the saved board holds has changed.
  reportChanged() {
    this.onChanged?.();
  }

  /**
   * The board as it is saved: the cards, the sets that move together and where each set is looking,
   * and the board's own pan and zoom.  `rev` is filled in by the store.
   */
  serialize(): StoredBoard {
    const groups = new Map<string, LinkGroup>();
    for (const card of this.cards) groups.set(card.group.id, card.group);
    return {
      version: 1,
      rev: 0,
      view: { ...this.transform },
      groups: [...groups.values()].map((group) => ({
        id: group.id,
        hue: group.hue,
        position: group.navigation?.position ?? null,
        zoom: group.navigation?.zoom ?? null,
      })),
      cards: this.cards.map((card) => ({
        id: card.id,
        x: card.rect.x,
        y: card.rect.y,
        width: card.rect.width,
        height: card.rect.height,
        z: Number(card.element.style.zIndex) || 0,
        orientation: card.orientation,
        sourceId: card.source?.id ?? null,
        groupId: card.group.id,
      })),
    };
  }

  /**
   * Puts a saved board back: the cards in the order they were stacked, each with the source it
   * showed, and each set of linked cards where it was looking.  Cards whose source the server no
   * longer knows ask for one again.
   */
  /**
   * Puts the cards back on a new viewer, which is what a lost WebGL context needs: everything on the
   * GPU belonged to the old one.  `replace` is called once the cards have let go of their views, and
   * returns the viewer and volumes to draw on instead; the cards, their links and the board's own
   * position come back as they were, and none of it counts as a change to save.
   */
  restart(replace: () => { viewer: Viewer; volumes: VolumeRegistry }) {
    const state = this.serialize();
    const sources = new Map<string, Source>();
    for (const card of this.cards) {
      if (card.source !== undefined) sources.set(card.source.id, card.source);
    }
    for (const card of [...this.cards]) this.removeCard(card);
    const { onChanged } = this;
    this.onChanged = undefined;
    this.options = { ...this.options, ...replace() };
    this.restore(state, sources);
    this.onChanged = onChanged;
  }

  restore(board: StoredBoard, sources: Map<string, Source>) {
    for (const card of [...this.cards]) this.removeCard(card);
    this.transform = { ...board.view };
    this.appliedScale = this.transform.scale;
    this.applyTransform();
    const groups = new Map(
      board.groups.map((group) => [
        group.id,
        new LinkGroup(group.id, group.hue),
      ]),
    );
    for (const stored of [...board.cards].sort((a, b) => a.z - b.z)) {
      const group = groups.get(stored.groupId) ?? new LinkGroup();
      const card = this.addCard(
        stored,
        stored.orientation,
        group,
        stored,
        stored.id,
      );
      const source =
        stored.sourceId === null ? undefined : sources.get(stored.sourceId);
      if (source !== undefined) card.setSource(source);
    }
    for (const stored of board.groups) {
      groups.get(stored.id)?.restore(stored.position, stored.zoom);
    }
    this.showLinks();
  }
}

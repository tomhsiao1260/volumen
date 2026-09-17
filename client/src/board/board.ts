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
import type { BoardTransform } from "./transform";
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
  // The card the keyboard acts on, if the user has clicked one.
  selected: Card | undefined;
  // What was copied, and the group a pasted card joins (see `copySelected`).
  private copied:
    | {
        source: Source | undefined;
        orientation: ViewOrientation;
        rect: CardRect;
        group: LinkGroup;
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

  // The card the keyboard acts on; clicking one selects it and clicking the board selects nothing.
  selectCard(card: Card | undefined) {
    if (card === this.selected) return;
    this.selected?.element.classList.remove("selected");
    this.selected = card;
    card?.element.classList.add("selected");
  }

  // Remembers the selected card for `pasteCopy`.  Returns false if there is nothing selected.
  copySelected() {
    const card = this.selected;
    if (card === undefined) return false;
    this.copied = {
      source: card.source,
      orientation: card.orientation,
      rect: { ...card.rect },
      group: card.group,
    };
    return true;
  }

  /**
   * Adds a card beside the copied one and linked to it, showing the same scan, the same plane and
   * the same place.  Changing the new card's plane is then the way to see that place another way,
   * which is what linked cards are for.  Pasting again puts the next card beside this one.
   */
  pasteCopy() {
    const copied = this.copied;
    if (copied === undefined) return false;
    // Nothing is left of the group if the copied card has since been removed.
    const group =
      copied.group.members.size > 0 ? copied.group : new LinkGroup();
    const rect = {
      ...copied.rect,
      x: copied.rect.x + copied.rect.width + CARD_GAP,
    };
    const card = this.addCard(rect, copied.orientation, group, rect);
    if (copied.source !== undefined) card.setSource(copied.source);
    this.copied = { ...copied, group, rect };
    this.selectCard(card);
    return card;
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
    if (this.selected === card) this.selectCard(undefined);
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

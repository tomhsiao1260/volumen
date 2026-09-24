/**
 * @file The board's state and every change that can be made to it.  It is shaped like the board the
 * server keeps (`api/storage.ts`), so saving it is a copy rather than a conversion.
 *
 * Nothing here touches the DOM or the viewer: a card's position, plane and source are state, while
 * the view drawing it belongs to the session (`session.ts`).
 */

import type { Point, ViewOrientation } from "viewer";
import type { SurfacePlane } from "../surface/types";
import type { Source } from "../api/sources";
import type { StoredBoard } from "../api/storage";
import { newGroupHue, newGroupId, takeGroupIds } from "./links";
import type { BoardTransform, Point2D } from "./transform";
import { fitTo } from "./transform";

// Size of a new card, and the space left between cards put down together, in board units.
export const CARD_WIDTH = 340;
export const CARD_HEIGHT = 300;
export const CARD_GAP = 16;
export const MIN_CARD_SIZE = 140;

/**
 * A surface card's sheet: the voxel it was opened on, how many sheets it has moved from there
 * (fractional, positive outward), which of the sheet's own planes it draws, and its scale in
 * full-resolution voxels per pixel.
 */
export interface SurfaceState {
  seed: Point;
  w: number;
  plane: SurfacePlane;
  zoom: number;
}

export interface CardState {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  // Which card is in front, kept so that a saved board stacks the same way.
  z: number;
  // A slice through the scan, or a piece of one of its sheets.
  kind: "slice" | "surface";
  // The slice's plane; a surface card keeps the one it was opened from.
  orientation: ViewOrientation;
  sourceId: string | null;
  groupId: string;
  surface?: SurfaceState;
}

export interface BoardState {
  cards: CardState[];
  // The hue each group of linked cards is marked with.
  hues: Record<string, number>;
  view: BoardTransform;
  // The sources the cards name, by id.
  sources: Record<string, Source>;
  // The ids of the cards the keyboard and a drag act on.
  selection: string[];
  // What was copied, and how far to the right the next paste goes.
  clipboard: { cards: CardState[]; offset: number; step: number } | undefined;
}

export const emptyBoard: BoardState = {
  cards: [],
  hues: {},
  view: { x: 0, y: 0, scale: 1 },
  sources: {},
  selection: [],
  clipboard: undefined,
};

let nextCardId = 0;

// Keeps new card ids clear of the ones a saved board brings back.
function takeIds(ids: string[]) {
  for (const id of ids) {
    const number = Number(id.replace(/^c/, ""));
    if (Number.isFinite(number)) nextCardId = Math.max(nextCardId, number + 1);
  }
}

export type BoardAction =
  | { type: "addCard"; at: Point2D; orientation?: ViewOrientation }
  // A surface card beside card `from`, on the sheet at `seed`, showing what `from` shows.
  | { type: "addSurfaceCard"; from: string; seed: Point; zoom: number }
  | { type: "setSurfaceLayer"; id: string; w: number }
  | { type: "setSurfacePlane"; id: string; plane: SurfacePlane }
  | { type: "removeCard"; id: string }
  | { type: "moveSelection"; deltaX: number; deltaY: number }
  | { type: "resizeCard"; id: string; deltaX: number; deltaY: number }
  | { type: "setOrientation"; id: string; orientation: ViewOrientation }
  | { type: "setSource"; id: string; source: Source }
  | { type: "clearSource"; id: string }
  | { type: "addSources"; sources: Source[] }
  // `groupId` is made by the caller, which then hands the new group the place the old one was
  // looking at (see `App.tsx`).
  | { type: "unlink"; id: string; groupId: string }
  | { type: "bringToFront"; id: string }
  | { type: "select"; ids: string[] }
  | { type: "toggleSelected"; id: string }
  | { type: "selectWithin"; from: Point2D; to: Point2D }
  | { type: "copy" }
  | { type: "paste" }
  | { type: "setView"; view: BoardTransform }
  | { type: "fitToCards"; size: { width: number; height: number } }
  | { type: "restore"; board: StoredBoard; sources: Source[] };

export function boardReducer(
  state: BoardState,
  action: BoardAction,
): BoardState {
  switch (action.type) {
    case "addCard": {
      const groupId = newGroupId();
      const card: CardState = {
        id: `c${nextCardId++}`,
        x: Math.round(action.at.x),
        y: Math.round(action.at.y),
        width: CARD_WIDTH,
        height: CARD_HEIGHT,
        z: topZ(state) + 1,
        kind: "slice",
        orientation: action.orientation ?? "xy",
        sourceId: null,
        groupId,
      };
      return {
        ...state,
        cards: [...state.cards, card],
        hues: { ...state.hues, [groupId]: newGroupHue() },
        selection: [card.id],
      };
    }

    case "addSurfaceCard": {
      const from = find(state, action.from);
      if (from === undefined || from.sourceId === null) return state;
      // In the group of the card it was opened from: the slices and the sheet laid flat are one
      // family, and the link on each of them says how many panels of that place are open.
      const groupId = from.groupId;
      const card: CardState = {
        id: `c${nextCardId++}`,
        ...beside(state, from),
        width: from.width,
        height: from.height,
        z: topZ(state) + 1,
        kind: "surface",
        orientation: from.orientation,
        sourceId: from.sourceId,
        groupId,
        surface: { seed: { ...action.seed }, w: 0, plane: "uv", zoom: action.zoom },
      };
      return {
        ...state,
        cards: [...state.cards, card],
        hues: { ...state.hues, [groupId]: state.hues[groupId] ?? newGroupHue() },
        selection: [card.id],
      };
    }

    case "setSurfacePlane":
      return {
        ...state,
        cards: state.cards.map((card) =>
          card.id === action.id && card.surface !== undefined
            ? { ...card, surface: { ...card.surface, plane: action.plane } }
            : card,
        ),
      };

    case "setSurfaceLayer": {
      /*
       * Every card showing the same piece moves to the same sheet — which is what makes a pair of
       * them worth having: one piece of papyrus, laid flat on one card and cut across the sheets on
       * another, moving together.  Which plane each shows stays its own.  Another piece opened from
       * the same slices is in the same group but is not the same papyrus, and stays where it is.
       */
      const moved = state.cards.find((card) => card.id === action.id);
      if (moved?.surface === undefined) return state;
      return {
        ...state,
        cards: state.cards.map((card) =>
          samePiece(card, moved) ? { ...card, surface: { ...card.surface!, w: action.w } } : card,
        ),
      };
    }

    case "removeCard":
      return {
        ...state,
        cards: state.cards.filter((card) => card.id !== action.id),
        selection: state.selection.filter((id) => id !== action.id),
      };

    case "moveSelection": {
      const moving = new Set(state.selection);
      return {
        ...state,
        cards: state.cards.map((card) =>
          moving.has(card.id)
            ? {
                ...card,
                x: card.x + action.deltaX,
                y: card.y + action.deltaY,
              }
            : card,
        ),
      };
    }

    case "resizeCard":
      return {
        ...state,
        cards: state.cards.map((card) =>
          card.id === action.id
            ? {
                ...card,
                width: Math.max(MIN_CARD_SIZE, card.width + action.deltaX),
                height: Math.max(MIN_CARD_SIZE, card.height + action.deltaY),
              }
            : card,
        ),
      };

    case "setOrientation":
      return {
        ...state,
        cards: state.cards.map((card) =>
          card.id === action.id
            ? { ...card, orientation: action.orientation }
            : card,
        ),
      };

    case "setSource": {
      const card = find(state, action.id);
      if (card === undefined) return state;
      // A card linked to cards with nothing to show hands them its source, so that a linked set only
      // has to be given one.
      const takes = (other: CardState) =>
        other.id === card.id ||
        (other.groupId === card.groupId && other.sourceId === null);
      return {
        ...state,
        sources: { ...state.sources, [action.source.id]: action.source },
        cards: state.cards.map((other) =>
          takes(other) ? { ...other, sourceId: action.source.id } : other,
        ),
      };
    }

    case "clearSource":
      return {
        ...state,
        cards: state.cards.map((card) =>
          card.id === action.id ? { ...card, sourceId: null } : card,
        ),
      };

    case "addSources": {
      const sources = { ...state.sources };
      for (const source of action.sources) sources[source.id] = source;
      return { ...state, sources };
    }

    case "unlink": {
      const { groupId } = action;
      return {
        ...state,
        cards: state.cards.map((card) =>
          card.id === action.id ? { ...card, groupId } : card,
        ),
        hues: { ...state.hues, [groupId]: newGroupHue() },
      };
    }

    case "bringToFront": {
      const top = topZ(state);
      const card = find(state, action.id);
      if (card === undefined || card.z === top) return state;
      return {
        ...state,
        cards: state.cards.map((other) =>
          other.id === action.id ? { ...other, z: top + 1 } : other,
        ),
      };
    }

    case "select":
      return { ...state, selection: action.ids };

    case "toggleSelected":
      return {
        ...state,
        selection: state.selection.includes(action.id)
          ? state.selection.filter((id) => id !== action.id)
          : [...state.selection, action.id],
      };

    case "selectWithin": {
      const left = Math.min(action.from.x, action.to.x);
      const right = Math.max(action.from.x, action.to.x);
      const top = Math.min(action.from.y, action.to.y);
      const bottom = Math.max(action.from.y, action.to.y);
      // Every card the area touches, however little of it.
      const within = state.cards.filter(
        (card) =>
          card.x < right &&
          card.x + card.width > left &&
          card.y < bottom &&
          card.y + card.height > top,
      );
      return { ...state, selection: within.map((card) => card.id) };
    }

    case "copy": {
      const cards = selected(state);
      if (cards.length === 0) return state;
      const left = Math.min(...cards.map((card) => card.x));
      const right = Math.max(...cards.map((card) => card.x + card.width));
      const step = right - left + CARD_GAP;
      return { ...state, clipboard: { cards, offset: step, step } };
    }

    case "paste": {
      const { clipboard } = state;
      if (clipboard === undefined) return state;
      let z = topZ(state);
      const hues = { ...state.hues };
      // Each copy joins the group of the card it came from, so that the two move together — slice
      // cards on the same place, surface cards on the same sheet; a group whose cards have all been
      // removed since the copy was made is made again.
      const pasted = clipboard.cards.map((card) => {
        const groupId = state.cards.some((other) => other.groupId === card.groupId)
          ? card.groupId
          : newGroupId();
        hues[groupId] ??= newGroupHue();
        return {
          ...card,
          id: `c${nextCardId++}`,
          x: card.x + clipboard.offset,
          z: ++z,
          groupId,
        };
      });
      return {
        ...state,
        cards: [...state.cards, ...pasted],
        hues,
        selection: pasted.map((card) => card.id),
        clipboard: { ...clipboard, offset: clipboard.offset + clipboard.step },
      };
    }

    case "setView":
      return { ...state, view: action.view };

    case "fitToCards":
      if (state.cards.length === 0) return state;
      return { ...state, view: fitTo(state.cards, action.size) };

    case "restore": {
      // Ids come back with the board, so the counters must not hand out one of them again.
      takeIds(action.board.cards.map((card) => card.id));
      takeGroupIds(action.board.groups.map((group) => group.id));
      const sources = { ...state.sources };
      for (const source of action.sources) sources[source.id] = source;
      const hues: Record<string, number> = {};
      for (const group of action.board.groups) hues[group.id] = group.hue;
      const cards = [...action.board.cards]
        .sort((a, b) => a.z - b.z)
        .map((card, index) => ({
          ...card,
          kind: card.kind ?? "slice",
          z: index + 1,
          // A card whose source the server no longer knows asks for one again.
          sourceId:
            card.sourceId !== null && sources[card.sourceId] !== undefined
              ? card.sourceId
              : null,
        }));
      /*
       * Surface cards saved before they joined the slices they were opened from: a group of nothing
       * but surface cards is put back with the slices of its scan, when there is one group of them,
       * so that a board made earlier shows one family rather than two halves of one.
       */
      const slices = new Map<string, string | null>();
      for (const card of cards) {
        if (card.kind !== "slice" || card.sourceId === null) continue;
        const seen = slices.get(card.sourceId);
        slices.set(card.sourceId, seen === undefined || seen === card.groupId ? card.groupId : null);
      }
      const lonely = new Set(cards.filter((card) => card.kind === "surface").map((card) => card.groupId));
      for (const card of cards) if (card.kind !== "surface") lonely.delete(card.groupId);
      for (const card of cards) {
        if (!lonely.has(card.groupId) || card.sourceId === null) continue;
        const group = slices.get(card.sourceId);
        if (group !== undefined && group !== null) card.groupId = group;
      }
      for (const card of cards) hues[card.groupId] ??= newGroupHue();
      return {
        ...state,
        cards,
        hues,
        sources,
        view: { ...action.board.view },
        selection: [],
      };
    }
  }
}

/**
 * Somewhere to put a new card of the same size as `from`: the nearest place around it that no card
 * is in, looked for to the right first and then around and further out.  The step down leaves room
 * for the lines a card says what it is on, which lie above and below its frame.
 */
function beside(state: BoardState, from: CardState) {
  const across = from.width + CARD_GAP;
  const down = from.height + 3 * CARD_GAP;
  const clear = (x: number, y: number) =>
    !state.cards.some(
      (card) =>
        x < card.x + card.width + CARD_GAP &&
        x + from.width + CARD_GAP > card.x &&
        y < card.y + card.height + CARD_GAP &&
        y + from.height + CARD_GAP > card.y,
    );
  for (let ring = 1; ring <= 4; ring++) {
    // Right, below, left, above, then the corners, all `ring` steps out.
    const steps = [
      [1, 0], [0, 1], [-1, 0], [0, -1],
      [1, 1], [-1, 1], [1, -1], [-1, -1],
    ];
    for (const [sx, sy] of steps) {
      const x = from.x + sx * ring * across;
      const y = from.y + sy * ring * down;
      if (clear(x, y)) return { x, y };
    }
  }
  return { x: from.x + across, y: from.y };
}

function find(state: BoardState, id: string) {
  return state.cards.find((card) => card.id === id);
}

function topZ(state: BoardState) {
  return state.cards.reduce((top, card) => Math.max(top, card.z), 0);
}

// The selected cards, in the order they are stacked.
export function selected(state: BoardState) {
  const ids = new Set(state.selection);
  return state.cards.filter((card) => ids.has(card.id));
}

/*
 * Whether two cards show the same piece of papyrus: the same scan, the same seed and the same scale
 * are what the worker builds a piece from, so cards agreeing on all three are showing one thing.
 */
export function samePiece(card: CardState, other: CardState) {
  const a = card.surface, b = other.surface;
  if (a === undefined || b === undefined || card.sourceId !== other.sourceId) return false;
  return a.zoom === b.zoom && a.seed.x === b.seed.x && a.seed.y === b.seed.y && a.seed.z === b.seed.z;
}

// How many cards are linked with this one, including itself.
export function groupSize(state: BoardState, card: CardState) {
  return state.cards.filter((other) => other.groupId === card.groupId).length;
}

// The board as it is saved.  `rev` is filled in by the store.
export function serialize(
  state: BoardState,
  places: Map<string, { position: StoredBoard["groups"][0]["position"]; zoom: number | null }>,
): StoredBoard {
  const groupIds = [...new Set(state.cards.map((card) => card.groupId))];
  return {
    version: 1,
    rev: 0,
    view: { ...state.view },
    groups: groupIds.map((id) => ({
      id,
      hue: state.hues[id] ?? 0,
      position: places.get(id)?.position ?? null,
      zoom: places.get(id)?.zoom ?? null,
    })),
    cards: state.cards.map((card) => ({
      id: card.id,
      x: card.x,
      y: card.y,
      width: card.width,
      height: card.height,
      z: card.z,
      kind: card.kind,
      orientation: card.orientation,
      sourceId: card.sourceId,
      groupId: card.groupId,
      ...(card.surface === undefined ? {} : { surface: card.surface }),
    })),
  };
}

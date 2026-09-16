import path from "path";
import fsp from "fs/promises";

/**
 * The board: where the cards are, what each of them shows, and which of them move together.  The
 * page sends the whole document back whenever it changes (see `routes/board.ts`), so this file is
 * the board as it was last seen and can be read and edited by hand.
 */
export interface Board {
  version: 1;
  // Incremented by the server on every write, so that a page that saved an older board is told.
  rev: number;
  updatedAt: string;
  // The board's own pan and zoom.
  view: { x: number; y: number; scale: number };
  // The cards that move together, and where each set is looking.
  groups: {
    id: string;
    hue: number;
    position: { x: number; y: number; z: number } | null;
    zoom: number | null;
  }[];
  cards: {
    id: string;
    // In board units; the board's pan and zoom decide where that is on screen.
    x: number;
    y: number;
    width: number;
    height: number;
    // Stacking order, lowest first.
    z: number;
    orientation: "xy" | "xz" | "yz";
    // The source it shows, from `sources.json`; null for a card that has not been given one.
    sourceId: string | null;
    groupId: string;
  }[];
}

const BOARD_PATH = path.join(process.cwd(), "db", "json", "board.json");

const ORIENTATIONS = new Set(["xy", "xz", "yz"]);

let writing: Promise<unknown> = Promise.resolve();

export function emptyBoard(): Board {
  return {
    version: 1,
    rev: 0,
    updatedAt: new Date().toISOString(),
    view: { x: 0, y: 0, scale: 1 },
    groups: [],
    cards: [],
  };
}

function number(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

/**
 * Reads a board the page sent, or a hand-edited file, keeping only what this server understands.  A
 * card without a group of its own is put in one, so that the page never has to invent one.
 */
export function parseBoard(value: any): Board {
  const board = emptyBoard();
  if (typeof value !== "object" || value === null) return board;
  board.view = {
    x: number(value.view?.x, 0),
    y: number(value.view?.y, 0),
    scale: number(value.view?.scale, 1),
  };
  const groups = Array.isArray(value.groups) ? value.groups : [];
  board.groups = groups
    .filter((group: any) => text(group?.id) !== "")
    .map((group: any) => ({
      id: text(group.id),
      hue: number(group.hue, 0),
      position:
        group.position == null
          ? null
          : {
              x: number(group.position.x, 0),
              y: number(group.position.y, 0),
              z: number(group.position.z, 0),
            },
      zoom: group.zoom == null ? null : number(group.zoom, 1),
    }));
  const known = new Set(board.groups.map((group) => group.id));
  const cards = Array.isArray(value.cards) ? value.cards : [];
  board.cards = cards
    .filter(
      (card: any) =>
        text(card?.id) !== "" && ORIENTATIONS.has(text(card?.orientation)),
    )
    .map((card: any, index: number) => {
      let groupId = text(card.groupId);
      if (!known.has(groupId)) {
        groupId = `${text(card.id)}-group`;
        board.groups.push({ id: groupId, hue: 0, position: null, zoom: null });
        known.add(groupId);
      }
      return {
        id: text(card.id),
        x: number(card.x, 0),
        y: number(card.y, 0),
        width: Math.max(1, number(card.width, 340)),
        height: Math.max(1, number(card.height, 300)),
        z: number(card.z, index),
        orientation: text(card.orientation) as Board["cards"][0]["orientation"],
        sourceId: text(card.sourceId) === "" ? null : text(card.sourceId),
        groupId,
      };
    });
  // Groups nothing refers to any more.
  const used = new Set(board.cards.map((card) => card.groupId));
  board.groups = board.groups.filter((group) => used.has(group.id));
  return board;
}

export async function getBoard(): Promise<Board> {
  try {
    const saved = JSON.parse(await fsp.readFile(BOARD_PATH, "utf-8"));
    const board = parseBoard(saved);
    board.rev = number(saved.rev, 0);
    board.updatedAt = text(saved.updatedAt) || board.updatedAt;
    return board;
  } catch {
    return emptyBoard();
  }
}

export type SaveResult =
  | { kind: "saved"; rev: number }
  | { kind: "stale"; board: Board };

/**
 * Stores the board, if `rev` is the one that was last stored: a page that saved an older board is
 * given the newer one instead of overwriting it.
 */
export async function saveBoard(value: any): Promise<SaveResult> {
  let result!: SaveResult;
  writing = writing.then(async () => {
    const stored = await getBoard();
    const rev = number(value?.rev, -1);
    if (rev !== stored.rev) {
      result = { kind: "stale", board: stored };
      return;
    }
    const board = parseBoard(value);
    board.rev = stored.rev + 1;
    board.updatedAt = new Date().toISOString();
    await fsp.mkdir(path.dirname(BOARD_PATH), { recursive: true });
    await fsp.writeFile(BOARD_PATH, JSON.stringify(board, null, 2), "utf-8");
    result = { kind: "saved", rev: board.rev };
  });
  await writing;
  return result;
}

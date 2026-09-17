/**
 * @file The board as the server keeps it (see `server/src/utils/board.ts`): read when the page opens
 * and written back, a little after every change, so that the same board is there again on the next
 * visit and in another browser.
 */

import { SERVER_API_ENDPOINT } from "../config";

export interface StoredBoard {
  version: 1;
  // What the server last stored.  A save that does not carry it is refused, so that two pages
  // cannot overwrite each other without noticing.
  rev: number;
  view: { x: number; y: number; scale: number };
  groups: {
    id: string;
    hue: number;
    position: { x: number; y: number; z: number } | null;
    zoom: number | null;
  }[];
  cards: {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    z: number;
    orientation: "xy" | "xz" | "yz";
    sourceId: string | null;
    groupId: string;
  }[];
}

// How long the board is left alone after a change before it is saved, so that dragging a card is
// one save rather than one per frame.
const SAVE_DELAY_MS = 500;

const BOARD_URL = `${SERVER_API_ENDPOINT}/api/board`;

export async function loadBoard(): Promise<StoredBoard> {
  const response = await fetch(BOARD_URL);
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

export interface BoardStoreOptions {
  // The board to save; called when a save is due, so that the latest state is sent.
  serialize: () => StoredBoard;
  // Called when the board on the server is newer than the one this page loaded.
  onConflict: (board: StoredBoard) => void;
}

/**
 * Saves the board after every change, at most once every `SAVE_DELAY_MS`.  The `rev` the server
 * answers with becomes the one the next save carries.
 */
export function createBoardStore({ serialize, onConflict }: BoardStoreOptions) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving: Promise<void> | undefined;
  let again = false;
  let rev: number;
  let conflicted = false;

  const put = async () => {
    const board = { ...serialize(), rev };
    const response = await fetch(BOARD_URL, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(board),
    });
    if (response.status === 409) {
      conflicted = true;
      onConflict(((await response.json()) as { board: StoredBoard }).board);
      return;
    }
    if (!response.ok) throw new Error(await response.text());
    rev = ((await response.json()) as { rev: number }).rev;
  };

  const save = async () => {
    if (saving !== undefined) {
      // A change arrived while the last save was in flight; it goes out after it.
      again = true;
      return saving;
    }
    saving = put()
      .catch((error) => console.error("Failed to save the board:", error))
      .finally(() => {
        saving = undefined;
        if (again) {
          again = false;
          void save();
        }
      });
    return saving;
  };

  return {
    // The revision this page is working from; set when the board is loaded.
    set revision(value: number) {
      rev = value;
      conflicted = false;
    },

    // Asks for a save, a moment from now.
    schedule() {
      if (conflicted) return;
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        void save();
      }, SAVE_DELAY_MS);
    },

    // Saves now, even if a save was only scheduled.
    flush() {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      return save();
    },

    // Sends the board while the page is closing, when a normal request would be cut off.
    saveOnUnload() {
      if (conflicted || timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      fetch(BOARD_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...serialize(), rev }),
        keepalive: true,
      }).catch(() => {});
    },
  };
}

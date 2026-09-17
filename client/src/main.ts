/**
 * @file A board of cross-sections.
 *
 * The board starts empty.  A double click adds a card, which asks which scroll to show — the
 * Vesuvius Challenge data bucket, a few clicks deep — and then draws it, downloading only what is
 * looked at.  Cards naming the same scan share one volume, linked cards share a position and zoom,
 * and the whole board is kept on the server.
 */

import { Viewer } from "viewer";
import { listMissingChunks } from "./app/missing_chunks";
import { showPosition } from "./app/position_display";
import { Board } from "./board/board";
import { createMenu } from "./board/menu";
import type { Source } from "./board/sources";
import { listSources, VolumeRegistry } from "./board/sources";
import type { StoredBoard } from "./board/storage";
import { createBoardStore, loadBoard } from "./board/storage";
import "./style.css";

const main = document.querySelector<HTMLElement>("main")!;
const element = document.querySelector<HTMLDivElement>("#board")!;
const layer = document.querySelector<HTMLDivElement>("#board-layer")!;
const hint = document.querySelector<HTMLElement>("#board-hint")!;
const conflict = document.querySelector<HTMLElement>("#board-conflict")!;

const viewer = new Viewer({ container: element });
const volumes = new VolumeRegistry(viewer, listMissingChunks(main));
const board = new Board({ viewer, volumes, element, layer });

createMenu(board, element);
showPosition(board, main);

// While a card waits to be linked, a line at the top says what to do next.
const linkHint = document.querySelector<HTMLElement>("#link-hint")!;
board.onLinkingChanged((linking) => {
  linkHint.hidden = !linking;
});

// The hint stands in for the cards while the board is empty.
board.onViewChanged(() => {
  hint.hidden = board.cards.length > 0;
});

const store = createBoardStore({
  serialize: () => board.serialize(),
  onConflict: () => {
    conflict.hidden = false;
  },
});

window.addEventListener("pagehide", () => store.saveOnUnload());
document
  .querySelector<HTMLButtonElement>("#board-reload")!
  .addEventListener("click", () => window.location.reload());

// The board on the server, with the sources its cards name.
function putBack(stored: StoredBoard, sources: Source[]) {
  board.restore(stored, new Map(sources.map((source) => [source.id, source])));
  store.revision = stored.rev;
  board.onChanged = () => store.schedule();
  hint.hidden = board.cards.length > 0;
}

Promise.all([loadBoard(), listSources()]).then(
  ([stored, sources]) => putBack(stored, sources),
  (error) => {
    console.error("Failed to read the board:", error);
    // The board is still usable; it just will not be saved.
    hint.textContent =
      "Could not read the board from the server. See the browser console.";
  },
);

/**
 * @file A board of cross-section cards.
 *
 * A double click adds a card, and a card shows a form until it is given a data source (a folder on
 * the server, a remote store, or both).  Cards naming the same source show the same volume, so its
 * chunks are downloaded once.  Linked cards share a position and zoom, and the whole board is kept
 * on the server, so it is there again on the next visit.
 */

import { Viewer } from "viewer";
import { listMissingChunks } from "./app/missing_chunks";
import { showPosition } from "./app/position_display";
import { createDefaultSourceForm } from "./app/source_form";
import { Board } from "./board/board";
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

const defaults = createDefaultSourceForm(
  document.querySelector<HTMLElement>("#source")!,
  document.querySelector<HTMLElement>("#source-panel")!,
);

const viewer = new Viewer({ container: element });
const volumes = new VolumeRegistry(viewer, listMissingChunks(main));
const board = new Board({
  viewer,
  volumes,
  sourceDefaults: () => defaults.get(),
  element,
  layer,
});

showPosition(board, main);

// While a card waits to be linked, the header says what to do next.
const linkHint = document.querySelector<HTMLElement>("#link-hint")!;
board.onLinkingChanged((linking) => {
  linkHint.hidden = !linking;
});

// The three cross-sections this page had before it became a board, as one linked set.
document
  .querySelector<HTMLButtonElement>("#add-linked")!
  .addEventListener("click", () => {
    const bounds = element.getBoundingClientRect();
    const { x, y } = board.pointAt(bounds.left + 40, bounds.top + 40);
    board.addLinkedCards({ x: Math.round(x), y: Math.round(y) });
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

// The board is saved a moment after every change, and at once if the page is closing.
window.addEventListener("pagehide", () => store.saveOnUnload());
document
  .querySelector<HTMLButtonElement>("#board-reload")!
  .addEventListener("click", () => window.location.reload());

// The board on the server, with the sources its cards name.
async function openBoard() {
  const [stored, sources] = await Promise.all([loadBoard(), listSources()]);
  putBack(stored, sources);
}

function putBack(stored: StoredBoard, sources: Source[]) {
  board.restore(stored, new Map(sources.map((source) => [source.id, source])));
  store.revision = stored.rev;
  board.onChanged = () => store.schedule();
  hint.hidden = board.cards.length > 0;
}

openBoard().catch((error) => {
  console.error("Failed to read the board:", error);
  // The board is still usable; it just will not be saved.
  hint.textContent = "Could not read the board from the server. See the browser console.";
});

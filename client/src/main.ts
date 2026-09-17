/**
 * @file A board of cross-sections.
 *
 * The board starts empty.  A double click adds a card, which asks which scroll to show — the
 * Vesuvius Challenge data bucket, a few clicks deep — and then draws it, downloading only what is
 * looked at.  Cards naming the same scan share one volume, linked cards share a position and zoom,
 * and the whole board is kept on the server.
 */

import { Viewer } from "viewer";
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

let viewer = startViewer();
let volumes = new VolumeRegistry(viewer);
const board = new Board({ viewer, volumes, element, layer });

createMenu(board, element);

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
for (const button of document.querySelectorAll<HTMLButtonElement>(
  ".notice-reload",
)) {
  button.addEventListener("click", () => window.location.reload());
}

/*
 * A browser may take a page's WebGL context away at any time, usually because it or another tab
 * asked for too much of the GPU, and everything on the GPU goes with it.  Rather than making the
 * user reload and lose what is on screen, the board starts again on a new viewer and puts its cards
 * back where they were; only if that keeps happening does it stop and say so, since rebuilding a
 * context that is about to be taken away again would only make things worse.
 */
const lost = document.querySelector<HTMLElement>("#board-lost")!;
const lostText = document.querySelector<HTMLElement>("#board-lost-text")!;
const lostReload = lost.querySelector<HTMLButtonElement>(".notice-reload")!;
const RECOVERIES = 3;
let recoveries = 0;
let recoveryTimer: number | undefined;
let lostTimer: number | undefined;

// Says what happened, for a while if there is nothing left to do about it.
function sayLost(text: string, reload: boolean) {
  lostText.textContent = text;
  lostReload.hidden = !reload;
  lost.hidden = false;
  window.clearTimeout(lostTimer);
  if (!reload) lostTimer = window.setTimeout(() => (lost.hidden = true), 6000);
}

function startViewer() {
  const started = new Viewer({ container: element });
  // Each card shows the voxel under the pointer while it is over that card.
  started.onPointerMove((point, view) => board.showPointer(view, point));
  started.onContextLost(() => recover());
  return started;
}

function recover() {
  if (++recoveries > RECOVERIES) {
    sayLost(
      "The browser keeps taking this page's graphics away. Reload to carry on.",
      true,
    );
    return;
  }
  // One loss an hour is the browser being the browser, not a board that cannot be drawn: the count
  // is only there to catch a context that goes as soon as it is built.
  window.clearTimeout(recoveryTimer);
  recoveryTimer = window.setTimeout(() => (recoveries = 0), 120000);
  const previous = viewer;
  board.restart(() => {
    previous.dispose();
    viewer = startViewer();
    volumes = new VolumeRegistry(viewer);
    return { viewer, volumes };
  });
  sayLost("The browser reset this page's graphics; the cards are back.", false);
}

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

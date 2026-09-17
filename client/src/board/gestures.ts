/**
 * @file Mouse, trackpad and keyboard input on the board:
 *
 *   - click a card: select it, which is what the keyboard and a drag then act on; Shift adds one
 *   - drag the background: pick out an area, selecting every card it touches
 *   - drag the data: pan the slice, which the view does itself
 *   - drag a card's lines, or Alt and drag it anywhere: move it, and everything else selected
 *   - drag a card's corner: resize it
 *   - middle drag, or Space and drag, anywhere: pan the board
 *   - two fingers, or the wheel, outside the data: pan the board
 *   - pinch, or Control and the wheel, outside the data: zoom the board around the pointer
 *   - wheel over the data: step through the slices; with Control: zoom the slice (both the view's)
 *   - double click on the background: add a card there
 *   - copy and paste: add a copy of everything selected beside it, and linked to it
 */

import type { Board } from "./board";
import { CARD_HEIGHT, CARD_WIDTH } from "./board";
import { zoomAbout } from "./transform";

// How far the pointer has to move before a press on the board is a drag rather than a click.
const DRAG_THRESHOLD = 3;

/**
 * Zoom factor for a pinch, or for the wheel with Control held.  A trackpad's pinch arrives as a
 * wheel event with `ctrlKey` set, which is how the two are told apart.
 */
function wheelZoomAmount(event: WheelEvent) {
  const multiplier =
    event.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? 1 / 200 : 1 / 8;
  return Math.exp(-event.deltaY * multiplier);
}

/**
 * Calls `move` with the pointer's movement, divided by `scale`, until the button is released.
 * Listens during the capture phase, so a card's own handlers cannot swallow the movement.
 */
function drag(
  event: PointerEvent,
  scale: number,
  move: (deltaX: number, deltaY: number) => void,
) {
  let prevX = event.clientX;
  let prevY = event.clientY;
  const onMove = (e: PointerEvent) => {
    move((e.clientX - prevX) / scale, (e.clientY - prevY) / scale);
    prevX = e.clientX;
    prevY = e.clientY;
  };
  const stop = () => {
    document.removeEventListener("pointermove", onMove, true);
    document.removeEventListener("pointerup", stop, true);
    document.removeEventListener("pointercancel", stop, true);
  };
  document.addEventListener("pointermove", onMove, true);
  document.addEventListener("pointerup", stop, true);
  document.addEventListener("pointercancel", stop, true);
}

// Whether the event is meant for a form, where copy and paste are the browser's own.
function typing(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    (target.closest("input, textarea") !== null ||
      (window.getSelection()?.isCollapsed === false))
  );
}

export function bindGestures(board: Board) {
  const { element } = board;

  // The area being picked out, in pixels of the board element: it is not part of the board's own
  // layer, so the board's transform does not stretch it.
  const marquee = document.createElement("div");
  marquee.id = "board-marquee";
  marquee.hidden = true;
  element.append(marquee);

  // Space and a drag pans, as the board itself no longer does: dragging it picks out an area.
  let spaceHeld = false;

  const panBoardBy = (deltaX: number, deltaY: number) => {
    board.transform.x += deltaX;
    board.transform.y += deltaY;
    board.applyTransform();
  };

  /**
   * Draws the area being picked out, and selects what it touches when the button is released.  A
   * press that does not move is a click on the board, which selects nothing.
   */
  const startMarquee = (event: PointerEvent) => {
    const bounds = element.getBoundingClientRect();
    const startX = event.clientX;
    const startY = event.clientY;
    const from = board.pointAt(startX, startY);
    let dragging = false;
    const onMove = (e: PointerEvent) => {
      if (
        !dragging &&
        Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY) <
          DRAG_THRESHOLD
      ) {
        return;
      }
      dragging = true;
      marquee.hidden = false;
      marquee.style.left = `${Math.min(startX, e.clientX) - bounds.left}px`;
      marquee.style.top = `${Math.min(startY, e.clientY) - bounds.top}px`;
      marquee.style.width = `${Math.abs(e.clientX - startX)}px`;
      marquee.style.height = `${Math.abs(e.clientY - startY)}px`;
      board.selectWithin(from, board.pointAt(e.clientX, e.clientY));
    };
    const stop = () => {
      if (!dragging) board.clearSelection();
      marquee.hidden = true;
      document.removeEventListener("pointermove", onMove, true);
      document.removeEventListener("pointerup", stop, true);
      document.removeEventListener("pointercancel", stop, true);
    };
    document.addEventListener("pointermove", onMove, true);
    document.addEventListener("pointerup", stop, true);
    document.addEventListener("pointercancel", stop, true);
  };

  // `preventDefault` is deliberately not called here: it would suppress the `click` and `dblclick`
  // that follow, which create a card and close one.  `user-select: none` on the board keeps a drag
  // from selecting text instead.
  element.addEventListener("pointerdown", (event) => {
    const target = event.target as HTMLElement;
    // Buttons in a card's chrome keep their click.
    if (target.closest("button") !== null) return;
    const card = board.cardAt(event.target);
    if (event.button === 1 || (event.button === 0 && spaceHeld)) {
      drag(event, 1, panBoardBy);
      return;
    }
    if (event.button !== 0) return;
    if (card === undefined) {
      startMarquee(event);
      return;
    }
    // A card already selected keeps the rest of the selection with it, so that several can be
    // dragged or copied at once.
    if (event.shiftKey) board.toggleSelected(card);
    else if (!board.isSelected(card)) board.selectOnly(card);
    board.bringToFront(card);
    if (target.closest(".card-resize") !== null) {
      drag(event, board.transform.scale, (deltaX, deltaY) =>
        card.resizeBy(deltaX, deltaY),
      );
      return;
    }
    // The lines above and below the data are what the card is dragged by; Alt does it from anywhere.
    const onBar =
      target.closest(".card-top") !== null ||
      target.closest(".card-bottom") !== null;
    if (onBar || event.altKey) {
      drag(event, board.transform.scale, (deltaX, deltaY) =>
        board.moveSelectionBy(deltaX, deltaY),
      );
    }
    // Anywhere else is the data, which the view pans itself.
  });

  element.addEventListener(
    "wheel",
    (event) => {
      // Over the data the view has already taken the wheel — a slice step, or a zoom with Control —
      // and stopped the event, so this only sees the board's background and the cards' lines.  A card
      // that is showing a list scrolls it instead.
      if ((event.target as HTMLElement).closest(".card-overlay") !== null) return;
      event.preventDefault();
      const bounds = element.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        // A pinch on a trackpad, or Control and the wheel.
        board.transform = zoomAbout(
          board.transform,
          event.clientX - bounds.left,
          event.clientY - bounds.top,
          wheelZoomAmount(event),
        );
      } else {
        // Two fingers on a trackpad, or the wheel: the board moves, as a page would scroll.
        board.transform.x -= event.deltaX;
        board.transform.y -= event.deltaY;
      }
      board.applyTransform();
    },
    { passive: false },
  );

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") board.clearSelection();
    if (event.code === "Space" && !typing(event.target)) {
      spaceHeld = true;
      element.classList.add("panning");
      // Otherwise the page takes the space for scrolling.
      event.preventDefault();
    }
  });

  window.addEventListener("keyup", (event) => {
    if (event.code !== "Space") return;
    spaceHeld = false;
    element.classList.remove("panning");
  });

  // A window that loses focus never sees the key come back up.
  window.addEventListener("blur", () => {
    spaceHeld = false;
    element.classList.remove("panning");
  });

  /*
   * Copy and paste a card, which is how linked cards are made: the pasted card shows the same scan
   * at the same place and moves with the card it came from, and its plane is then changed to see
   * that place another way.  Nothing is written to the system clipboard — `preventDefault` leaves
   * whatever is in it alone — so this only pastes within the page.
   */
  document.addEventListener("copy", (event) => {
    if (!typing(event.target) && board.copySelected()) event.preventDefault();
  });

  document.addEventListener("paste", (event) => {
    if (typing(event.target)) return;
    if (board.pasteCopy() !== false) event.preventDefault();
  });

  element.addEventListener("dblclick", (event) => {
    if (board.cardAt(event.target) !== undefined) return;
    const { x, y } = board.pointAt(event.clientX, event.clientY);
    board.addCard({
      x: Math.round(x - CARD_WIDTH / 2),
      y: Math.round(y - CARD_HEIGHT / 2),
    });
  });
}

/**
 * @file Mouse input on the board:
 *
 *   - left drag on the background, or middle drag anywhere: pan the board
 *   - wheel outside a slice: zoom the board around the pointer
 *   - double click on the background: add a card there
 *   - left drag on a card: move it; with Alt over its slice: pan the slice
 *   - click a card while linking: link it to the card the link started from
 *   - left drag on a card's corner: resize it
 *   - wheel over a slice: step through slices; with Control: zoom the slice (both left to the view)
 */

import type { Board } from "./board";
import { CARD_HEIGHT, CARD_WIDTH } from "./board";
import { zoomAbout } from "./transform";

// Zoom factor for one wheel notch, gentler than the view's own zoom.
function wheelZoomAmount(event: WheelEvent) {
  const multiplier =
    event.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? 1 / 400 : 1 / 8;
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

export function bindGestures(board: Board) {
  const { element } = board;

  // `preventDefault` is deliberately not called here: it would suppress the `click` and `dblclick`
  // that follow, which create a card and close one.  `user-select: none` on the board keeps a drag
  // from selecting text instead.
  element.addEventListener("pointerdown", (event) => {
    const target = event.target as HTMLElement;
    // Buttons in a card's chrome keep their click.
    if (target.closest("button") !== null) return;
    const card = board.cardAt(event.target);
    const panBoard =
      event.button === 1 || (event.button === 0 && card === undefined);
    if (panBoard) {
      drag(event, 1, (deltaX, deltaY) => {
        board.transform.x += deltaX;
        board.transform.y += deltaY;
        board.applyTransform();
      });
      return;
    }
    if (event.button !== 0 || card === undefined) return;
    if (board.linkFrom !== undefined) {
      board.linkCards(board.linkFrom, card);
      return;
    }
    board.bringToFront(card);
    if (target.closest(".card-resize") !== null) {
      drag(event, board.transform.scale, (deltaX, deltaY) =>
        card.resizeBy(deltaX, deltaY),
      );
    } else if (
      event.altKey &&
      card.view !== undefined &&
      target.closest(".card-slice") !== null
    ) {
      // The slice moves by screen pixels, so the board's zoom is already in the view's projection.
      const { view } = card;
      drag(event, 1, (deltaX, deltaY) =>
        view.translateByViewportPixels(deltaX, deltaY),
      );
    } else {
      drag(event, board.transform.scale, (deltaX, deltaY) =>
        card.moveBy(deltaX, deltaY),
      );
    }
  });

  element.addEventListener(
    "wheel",
    (event) => {
      // Over a slice the view has already taken the wheel — a slice step, or a zoom with Control —
      // and stopped the event, so this only sees the board's background and the cards' chrome.
      const bounds = element.getBoundingClientRect();
      event.preventDefault();
      board.transform = zoomAbout(
        board.transform,
        event.clientX - bounds.left,
        event.clientY - bounds.top,
        wheelZoomAmount(event),
      );
      board.applyTransform();
    },
    { passive: false },
  );

  // A click on the background, and Escape, give up on linking.
  element.addEventListener("pointerdown", (event) => {
    if (board.linkFrom !== undefined && board.cardAt(event.target) === undefined) {
      board.stopLinking();
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") board.stopLinking();
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

/**
 * @file Mouse, trackpad and keyboard input on the board:
 *
 *   - click a card: select it, which is what the keyboard and a drag then act on; Shift adds one
 *   - drag the background: pick out an area, selecting every card it touches
 *   - drag a card anywhere: move it, and everything else selected
 *   - drag a card's corner: resize it
 *   - middle drag, or Space and drag, anywhere: pan the board
 *   - two fingers, or the wheel, anywhere: pan the board
 *   - pinch, or Control and the wheel: zoom the board around the pointer
 *   - double click on the background: add a card there
 *   - copy and paste: add a copy of everything selected beside it, and linked to it
 *
 * What a card shows is moved only with Alt held — Alt and drag pans the data, Alt and the wheel
 * steps through the slices, Alt and Control and the wheel zooms it (all the view's own, see
 * `handleInput` in `CardView.tsx`).  Without that, picking a card up or scrolling the board past it
 * would move the data inside it by accident.
 */

import { useEffect } from "react";
import type { BoardAction, BoardState } from "./state";
import { CARD_HEIGHT, CARD_WIDTH } from "./state";
import type { BoardTransform, Point2D } from "./transform";
import { toBoard, zoomAbout } from "./transform";

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
  scale: () => number,
  move: (deltaX: number, deltaY: number) => void,
) {
  let prevX = event.clientX;
  let prevY = event.clientY;
  const onMove = (e: PointerEvent) => {
    move((e.clientX - prevX) / scale(), (e.clientY - prevY) / scale());
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
    (target instanceof HTMLElement &&
      target.closest("input, textarea") !== null) ||
    window.getSelection()?.isCollapsed === false
  );
}

// The id of the card the event happened in, if any.
function cardAt(target: EventTarget | null) {
  if (!(target instanceof Element)) return undefined;
  return target.closest<HTMLElement>(".card")?.dataset.card;
}

export interface GestureOptions {
  // The board element, which fills the window.
  element: HTMLElement | null;
  // The area being picked out, shown while a drag on the board lasts.
  marquee: HTMLElement | null;
  // The state as it is now; a drag reads it between renders.
  state: () => BoardState;
  dispatch: (action: BoardAction) => void;
}

export function useBoardGestures({
  element,
  marquee,
  state,
  dispatch,
}: GestureOptions) {
  useEffect(() => {
    if (element === null || marquee === null) return;
    const transform = () => state().view;
    const scale = () => transform().scale;
    // Space and a drag pans, as the board itself no longer does: dragging it picks out an area.
    let spaceHeld = false;

    const pointAt = (clientX: number, clientY: number): Point2D => {
      const bounds = element.getBoundingClientRect();
      return toBoard(transform(), clientX - bounds.left, clientY - bounds.top);
    };

    const setView = (view: BoardTransform) =>
      dispatch({ type: "setView", view });

    const panBy = (deltaX: number, deltaY: number) => {
      const { x, y, scale: current } = transform();
      setView({ x: x + deltaX, y: y + deltaY, scale: current });
    };

    /**
     * Draws the area being picked out, and selects what it touches as the pointer moves.  A press
     * that does not move is a click on the board, which selects nothing.
     */
    const startMarquee = (event: PointerEvent) => {
      const bounds = element.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const from = pointAt(startX, startY);
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
        dispatch({
          type: "selectWithin",
          from,
          to: pointAt(e.clientX, e.clientY),
        });
      };
      const stop = () => {
        if (!dragging) dispatch({ type: "select", ids: [] });
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
    // that follow.  `user-select: none` on the board keeps a drag from selecting text instead.
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      // Buttons in a card's chrome keep their click.
      if (target.closest("button") !== null) return;
      const id = cardAt(event.target);
      if (event.button === 1 || (event.button === 0 && spaceHeld)) {
        drag(event, () => 1, panBy);
        return;
      }
      if (event.button !== 0) return;
      if (id === undefined) {
        startMarquee(event);
        return;
      }
      // A card already selected keeps the rest of the selection with it, so that several can be
      // dragged or copied at once.
      if (event.shiftKey) dispatch({ type: "toggleSelected", id });
      else if (!state().selection.includes(id)) {
        dispatch({ type: "select", ids: [id] });
      }
      dispatch({ type: "bringToFront", id });
      if (target.closest(".card-resize") !== null) {
        drag(event, scale, (deltaX, deltaY) =>
          dispatch({ type: "resizeCard", id, deltaX, deltaY }),
        );
        return;
      }
      // A card is dragged by any part of it; with Alt the view pans the data instead, and a list a
      // card is showing keeps its own drag.
      if (!event.altKey && target.closest(".card-overlay") === null) {
        drag(event, scale, (deltaX, deltaY) =>
          dispatch({ type: "moveSelection", deltaX, deltaY }),
        );
      }
    };

    const onWheel = (event: WheelEvent) => {
      // With Alt the view has already taken the wheel — a slice step, or a zoom with Control — and
      // stopped the event, so this sees everything else.  A card that is showing a list scrolls it.
      if ((event.target as HTMLElement).closest(".card-overlay") !== null) {
        return;
      }
      event.preventDefault();
      const bounds = element.getBoundingClientRect();
      if (event.ctrlKey || event.metaKey) {
        // A pinch on a trackpad, or Control and the wheel.
        setView(
          zoomAbout(
            transform(),
            event.clientX - bounds.left,
            event.clientY - bounds.top,
            wheelZoomAmount(event),
          ),
        );
      } else {
        // Two fingers on a trackpad, or the wheel: the board moves, as a page would scroll.
        panBy(-event.deltaX, -event.deltaY);
      }
    };

    const onDoubleClick = (event: MouseEvent) => {
      if (cardAt(event.target) !== undefined) return;
      const at = pointAt(event.clientX, event.clientY);
      dispatch({
        type: "addCard",
        at: { x: at.x - CARD_WIDTH / 2, y: at.y - CARD_HEIGHT / 2 },
      });
    };

    const releaseSpace = () => {
      spaceHeld = false;
      element.classList.remove("panning");
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") dispatch({ type: "select", ids: [] });
      if (event.code === "Space" && !typing(event.target)) {
        spaceHeld = true;
        element.classList.add("panning");
        // Otherwise the page takes the space for scrolling.
        event.preventDefault();
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") releaseSpace();
    };

    /*
     * Copy and paste, which is how linked cards are made: the pasted card shows the same scan at the
     * same place and moves with the card it came from, and its plane is then changed to see that
     * place another way.  Nothing is written to the system clipboard — `preventDefault` leaves
     * whatever is in it alone — so this only pastes within the page.
     */
    const onCopy = (event: ClipboardEvent) => {
      if (typing(event.target) || state().selection.length === 0) return;
      dispatch({ type: "copy" });
      event.preventDefault();
    };

    const onPaste = (event: ClipboardEvent) => {
      if (typing(event.target) || state().clipboard === undefined) return;
      dispatch({ type: "paste" });
      event.preventDefault();
    };

    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("dblclick", onDoubleClick);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", releaseSpace);
    document.addEventListener("copy", onCopy);
    document.addEventListener("paste", onPaste);
    return () => {
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("dblclick", onDoubleClick);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", releaseSpace);
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("paste", onPaste);
    };
  }, [element, marquee, state, dispatch]);
}

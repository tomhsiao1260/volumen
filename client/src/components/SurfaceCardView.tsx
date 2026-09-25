/**
 * @file A surface card: a piece of one sheet of papyrus, opened from a slice card on the voxel that
 * was right-clicked, found and drawn by following the scan's Lasagna prediction (`surface/`).
 *
 * Alt and the wheel moves through the sheets, an eighth of one at a time: whole `w` are sheets and
 * halves the gaps between them.  As everywhere on the board, the data only moves while Alt is held.
 *
 * A card shows one of the sheet's own planes, as a slice card shows one of the scan's: UV is the
 * sheet laid flat, UW and VW cut across the sheets, where a piece that is right shows them as level
 * bands.  The badge changes it.
 */

import { useEffect, useRef, useState } from "react";
import { getLasagna } from "../api/lasagna";
import type { Source } from "../api/sources";
import { sourceLabel } from "../api/sources";
import type { BoardAction, CardState } from "../board/state";
import type { Point } from "viewer";
import { surfaceEngine } from "../surface/engine";
import type { ChainSaid, FrameEvent, PieceSpot, SurfacePlane, SurfaceFacts, SurfaceStatus } from "../surface/types";
import { SPAN } from "../surface/types";
import { drawMark, formatVoxel, shorten } from "./CardView";

type Status = SurfaceStatus | "no-prediction" | "no-source" | "unknown";

// The card is drawn with this many pixels per pixel of its own layout, so that it is as sharp as the
// screen allows; past two there is nothing more to see and every pixel costs.
const MAX_DENSITY = 2;

/*
 * Sheets per wheel notch, and per pixel of a scroll.  A mouse's notch is 120 pixels where a browser
 * counts in pixels, so the two agree: one notch is an eighth of a sheet either way.  Telling a mouse
 * from a trackpad by how large the scroll is does not work — a trackpad flicked hard sends more than
 * a hundred pixels at a time, and counting each of those as a notch ran the card a whole sheet past
 * where the hand stopped.
 */
/*
 * How long a card waits for the sheet it asked for before it stops saying so.  A sheet far outside
 * the piece can take several pieces to reach, and sometimes cannot be reached at all — the papyrus
 * runs out, or the prediction does — and a card that says "loading" for ever tells nobody anything.
 * What it has drawn stays on it; this only stops the waiting.
 */
const PATIENCE_MS = 8000;

const NOTCH = 1 / 8;
const PER_PIXEL = 1 / 960;
/*
 * A gap this long starts a new scroll.  What tells the hand from the trackpad coasting after it:
 * the coasting only ever fades, so a push that has grown smaller this many times in a row is not a
 * hand any more — a hand's pushes wander up and down.  Falling well below the gesture's strongest
 * push says the same thing more slowly, and catches a coast that begins gently.
 */
const GESTURE_GAP_MS = 120;
const FADING = 5;
const COASTING = 0.5;
// And however strong the flick, one of them moves at most this far.  A hand cannot tell a trackpad's
// coasting from its own push, and neither can this, so what makes the card answerable is that no one
// gesture can run away with it: to go further, push again.
const PER_GESTURE = 3 / 8;

// What the card found is for whoever is working on it, not for the board: it is written to the
// console of a page opened with `?debug`, like the rest of the handles there.
const DEBUG = new URLSearchParams(window.location.search).has("debug");

const PLANES: SurfacePlane[] = ["uv", "uw", "vw"];

// The sheets marked on a cut across them, in the colour the slice cards use for the same thing.
const SHEET_LINE = "rgba(130, 225, 255, 0.92)";
const SHEET_LINE_EDGE = "rgba(0, 10, 20, 0.55)";
// How near the pointer has to be to one to take hold of it.
const GRAB = 7;

const PLANE_TITLES: Record<SurfacePlane, string> = {
  uv: "The sheet, laid flat",
  uw: "Across the sheets, along the sheet's width",
  vw: "Across the sheets, along the scroll",
};

function formatLayer(w: number) {
  return `w ${w < 0 ? "−" : "+"}${Math.abs(w).toFixed(2)}`;
}

const MESSAGES: Partial<Record<Status, string>> = {
  loading: "Looking for the sheet…",
  "no-prediction": "This scan has no surface prediction.",
  "no-source": "The scan this card showed is no longer known to the server.",
  "no-sheet": "No sheet was found here.",
  unknown: "Could not ask the server for the surface prediction.",
  failed: "Failed to find the sheet. See the browser console.",
};

function describe(facts: SurfaceFacts) {
  return (
    `sheets ${facts.spacing.toFixed(0)} voxels apart, ` +
    `${facts.across} × ${facts.down} points ${facts.step} voxels apart, ` +
    `prediction read in ${(facts.read / 1000).toFixed(1)} s, sheet built in ${facts.built} ms\n` +
    `   sheets ${facts.apart} voxels apart · said ${facts.said} · off ${facts.off} · holes ${facts.holes} · torn ${facts.torn} · edges ×${facts.stretch}`
  );
}

export interface SurfaceCardViewProps {
  card: CardState;
  source: Source | undefined;
  selected: boolean;
  // The group's colour, and how many cards are in it: a surface card is one panel of a place, and
  // wears the same link as the slices it was opened from.
  hue: number;
  linked: number;
  // The voxel the group has marked, which this card shows on its own piece.
  mark: Point | undefined;
  // What has been said about the sheets of this scan, and is settled enough to build on.
  chains: ChainSaid[];
  dispatch: (action: BoardAction) => void;
  onUnlink: () => void;
  onMark: (at: Point | null) => void;
}

export function SurfaceCardView({ card, source, selected, hue, linked, mark, chains, dispatch, onUnlink, onMark }: SurfaceCardViewProps) {
  const body = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  // The sheets drawn over a cut across them, and what is being pulled.
  const lines = useRef<HTMLCanvasElement>(null);
  const pulling = useRef<{ from: number; w: number; perPixel: number } | undefined>(undefined);
  // Kept between frames: a frame is copied into it rather than a new one being made each time.
  const image = useRef<ImageData>(undefined);
  // And for the quick looks, which come smaller than the card: somewhere to put one before it is
  // scaled up onto the card.
  const sketch = useRef<HTMLCanvasElement>(undefined);
  const sketched = useRef<ImageData>(undefined);
  // The sheet last drawn, which is not the one asked for while a frame for it is on its way.
  const shown = useRef<number>(undefined);
  // Where the group's mark falls on this piece, null when the piece does not reach it.
  const spot = useRef<PieceSpot | null>(null);
  const [spotted, setSpotted] = useState(0);
  const [status, setStatus] = useState<Status>("loading");
  const [drawn, setDrawn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [planeMenu, setPlaneMenu] = useState(false);
  /*
   * The piece is built again when what was said about the sheets changes — the spacing decides how
   * big a box of prediction is read and how finely, so there is nothing of the old piece to keep.
   * A chain still being drawn is not in here: rebuilding under the hand after every point would take
   * the card away from the person placing them.
   */
  const said = chains.map((chain) => `${chain.id}.${chain.rev}`).join(",");
  const surface = card.surface!;
  const { id, sourceId } = card;
  const { seed, zoom, w, plane } = surface;
  // The sheet and plane asked for last, which the wheel and the badge change before the state has
  // caught up, and which a frame is compared against to know whether it is the one being waited for.
  const wanted = useRef(w);
  const wantedPlane = useRef(plane);
  // Taken from the board only when the board itself moves the card — a sheet asked for by the wheel
  // is held here until the board hears about it, and a render in between must not undo it.
  useEffect(() => {
    wanted.current = w;
    wantedPlane.current = plane;
  }, [w, plane]);
  // The listener below is set up once, and what it should do with an answer may have changed since.
  const onMarkRef = useRef(onMark);
  useEffect(() => {
    onMarkRef.current = onMark;
  }, [onMark]);
  // The size the sheet was built for; it is not built again while the card is resized, since the
  // sheet it shows does not change.
  const size = useRef({ width: card.width, height: card.height });
  const density = Math.min(MAX_DENSITY, window.devicePixelRatio || 1);

  const paint = (frame: FrameEvent) => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (element == null || context == null) return;
    if (DEBUG) {
      const kept = ((window as unknown as { __frames?: unknown[] }).__frames ??= []);
      kept.push({
        drew: Math.round(frame.drew),
        step: frame.scale,
        w: frame.w,
        loading: frame.loading,
        limited: frame.limited,
      });
      if (kept.length > 200) kept.shift();
    }
    /*
     * The canvas is sized only when the size actually changes: setting `width` or `height`, even to
     * the value it already has, makes the browser throw the canvas away and allocate another, which
     * on every frame is work for nothing and churns the memory the GPU draws from.
     */
    if (element.width !== frame.width || element.height !== frame.height) {
      element.width = frame.width;
      element.height = frame.height;
      image.current = undefined;
    }
    const across = Math.max(1, Math.ceil(frame.width / frame.scale));
    const down = Math.max(1, Math.ceil(frame.height / frame.scale));
    /*
     * A quick look comes smaller than the card and is drawn onto it scaled, which the browser does
     * smoothly: an out-of-focus picture while the sheets go by, rather than a pattern of squares of
     * its own that the eye reads as part of the papyrus.
     */
    if (frame.scale !== 1) {
      const small = (sketch.current ??= document.createElement("canvas"));
      if (small.width !== across || small.height !== down) {
        small.width = across;
        small.height = down;
        sketched.current = undefined;
      }
      const into = (sketched.current ??= small.getContext("2d")!.createImageData(across, down));
      into.data.set(new Uint8ClampedArray(frame.pixels));
      small.getContext("2d")!.putImageData(into, 0, 0);
      context.clearRect(0, 0, element.width, element.height);
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.drawImage(small, 0, 0, element.width, element.height);
      shown.current = frame.w;
      markSheets();
      setDrawn(true);
      return;
    }
    const into = (image.current ??= context.createImageData(frame.width, frame.height));
    into.data.set(new Uint8ClampedArray(frame.pixels));
    context.putImageData(into, 0, 0);
    shown.current = frame.w;
    markSheets();
    setDrawn(true);
    // Still loading while this is not the sheet and plane asked for last, or not all of it.
    const more =
      frame.loading || frame.plane !== wantedPlane.current || (!frame.limited && frame.w !== wanted.current);
    if (!more) clearTimeout(waiting.current);
    setLoading(more);
  };

  /*
   * The browser's GPU process can die under the page — on an Intel Mac, Brave 152 does it to itself
   * through a bug of its own — and it takes the canvas's pixels with it, leaving the card blank until
   * something happens to draw it again.  The frame last drawn is still here, so it is put back as
   * soon as the canvas has somewhere to put it.  A slice card comes back by itself: the viewer
   * already listens for its WebGL context being lost.
   */
  useEffect(() => {
    const element = canvas.current;
    if (element === null) return;
    const repaint = () => {
      const context = element.getContext("2d");
      const last = image.current;
      if (context !== null && last !== undefined) context.putImageData(last, 0, 0);
    };
    element.addEventListener("contextrestored", repaint);
    return () => element.removeEventListener("contextrestored", repaint);
  }, []);

  useEffect(() => {
    if (sourceId === null) {
      setStatus("no-source");
      return;
    }
    let current = true;
    setStatus("loading");
    setDrawn(false);
    setLoading(true);
    const engine = surfaceEngine();
    getLasagna(sourceId).then(
      (lasagna) => {
        if (!current) return;
        if (lasagna === null) {
          setStatus("no-prediction");
          return;
        }
        engine.open(
          {
            id,
            scanSourceId: sourceId,
            chains,
            lasagna,
            seed,
            w: wanted.current,
            plane,
            zoom,
            // The frame inside the card's border, in the pixels it is drawn with.
            width: Math.round((size.current.width - 2) * density),
            height: Math.round((size.current.height - 2) * density),
            density,
          },
          (event) => {
            if (event.type === "frame") {
              paint(event);
              // The sheets could not be followed as far as the wheel went.
              if (event.limited) dispatch({ type: "setSurfaceLayer", id, w: event.w });
              return;
            }
            // Where the sheet is goes straight to the slice cards, not through this one.
            if (event.type === "sheet") return;
            if (event.type === "place") {
              // The answer to "where is this place on your piece", or to "which voxel is this".
              if (event.voxel !== null) {
                const [z, y, x] = event.voxel;
                onMarkRef.current({ x, y, z });
              } else if (event.spot !== null) {
                spot.current = event.spot;
                setSpotted((count) => count + 1);
                // The place is on another sheet of this piece: turn to it, as the slices move.
                if (Math.abs(event.spot.w - wanted.current) > 1e-3) {
                  dispatch({ type: "setSurfaceLayer", id, w: event.spot.w });
                }
              } else {
                spot.current = null;
                setSpotted((count) => count + 1);
              }
              return;
            }
            setStatus(event.status);
            if (event.facts !== undefined && DEBUG) console.info(`${id}: ${describe(event.facts)}`);
            if (event.message !== undefined) console.error(event.message);
          },
        );
      },
      (error) => {
        if (!current) return;
        console.error("Failed to ask for the surface prediction:", error);
        setStatus("unknown");
      },
    );
    return () => {
      current = false;
      engine.close(id);
    };
    // `w` is sent on its own below; asking for another sheet must not build the piece again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, sourceId, seed, zoom, said]);

  useEffect(() => {
    surfaceEngine().show(id, w, plane);
    waitFor();
    // `waitFor` is the same work every time and is not worth being a dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, w, plane]);

  /*
   * Asks for another sheet at once, and tells the board a moment later.  A wheel turned across a
   * trackpad sends its scroll dozens of times a second, and putting each of those through the board's
   * state would lay out every card and schedule a save for each one; the worker only needs the last
   * sheet asked for, and the board only needs to know where the card came to rest.
   */
  const settling = useRef<ReturnType<typeof setTimeout>>(undefined);
  const waiting = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Says that a sheet has been asked for, and stops saying it if the answer never comes.
  const waitFor = () => {
    clearTimeout(waiting.current);
    setLoading(true);
    waiting.current = setTimeout(() => setLoading(false), PATIENCE_MS);
  };
  const askFor = (next: number) => {
    wanted.current = next;
    surfaceEngine().show(id, next, wantedPlane.current);
    waitFor();
    if (settling.current !== undefined) clearTimeout(settling.current);
    settling.current = setTimeout(() => {
      settling.current = undefined;
      dispatch({ type: "setSurfaceLayer", id, w: wanted.current });
    }, 200);
  };
  useEffect(
    () => () => {
      clearTimeout(settling.current);
      clearTimeout(waiting.current);
    },
    [],
  );

  /*
   * Alt and the wheel moves through the sheets: a notch is an eighth of one and a trackpad moves
   * smoothly.  Without Alt the board takes the wheel, as it does over a slice card.
   *
   * A trackpad goes on sending the scroll after the fingers have lifted, with the pushes fading
   * away, and a card that followed them would keep sliding on its own — so once a scroll has faded
   * well below its strongest push, the rest of it is left alone until the next one begins.
   */
  useEffect(() => {
    const element = body.current;
    if (element === null) return;
    const scroll = { at: 0, strongest: 0, last: 0, fading: 0, spent: 0, coasting: false };
    const onWheel = (event: WheelEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
      if (delta === 0) return;
      const pixels = event.deltaMode === WheelEvent.DOM_DELTA_PIXEL;
      const now = event.timeStamp;
      if (now - scroll.at > GESTURE_GAP_MS) {
        scroll.strongest = 0;
        scroll.last = 0;
        scroll.fading = 0;
        scroll.spent = 0;
        scroll.coasting = false;
      }
      scroll.at = now;
      if (pixels) {
        const size = Math.abs(delta);
        // Coasting only ever fades, so a push larger than the one before it is a hand, back on.
        if (size > scroll.last * 1.15) {
          scroll.coasting = false;
          scroll.fading = 0;
        }
        scroll.fading = size < scroll.last ? scroll.fading + 1 : 0;
        scroll.last = size;
        scroll.strongest = Math.max(scroll.strongest, size);
        if (scroll.fading >= FADING || size < scroll.strongest * COASTING) scroll.coasting = true;
        if (scroll.coasting) return;
      }
      let step = pixels ? delta * PER_PIXEL : Math.sign(delta) * NOTCH;
      const left = PER_GESTURE - scroll.spent;
      if (left <= 0) return;
      step = Math.sign(step) * Math.min(Math.abs(step), left);
      scroll.spent += Math.abs(step);
      askFor(Math.round((wanted.current + step) * 1000) / 1000);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [id, dispatch]);

  /*
   * On a cut across the sheets, each whole sheet is a line of its own: the card's is in the middle
   * and its neighbours above and below, so that a piece that is right reads as level bands between
   * level lines.  Drawn as the frames come in rather than through the board's state, which turning
   * the wheel would otherwise lay out again and again.
   */
  const markSheets = () => {
    const element = lines.current;
    if (element === null) return;
    const context = element.getContext("2d");
    if (context === null) return;
    const density = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(element.clientWidth * density));
    const height = Math.max(1, Math.round(element.clientHeight * density));
    if (element.width !== width || element.height !== height) {
      element.width = width;
      element.height = height;
    }
    context.clearRect(0, 0, width, height);
    /*
     * The place the group has marked, where it falls in this frame.  Along u and v it is a fraction
     * of the piece; across the sheets it is how far from the sheet this card is on, which is the
     * middle of the cut (`mapping` in `render.ts`, the same way round).
     */
    const here = spot.current;
    const sheet = shown.current ?? wanted.current;
    if (here !== null && shown.current !== undefined) {
      const across = 0.5 + (here.w - sheet) / (2 * SPAN);
      const at =
        wantedPlane.current === "uv"
          ? [here.fu, here.fv]
          : wantedPlane.current === "uw"
            ? [here.fu, across]
            : [across, here.fv];
      if (at[0] >= 0 && at[0] <= 1 && at[1] >= 0 && at[1] <= 1) {
        drawMark(context, at[0] * width, at[1] * height, density, Math.abs(here.w - sheet) <= 1 / 16);
      }
    }
    if (wantedPlane.current === "uv" || shown.current === undefined) return;
    /*
     * One line: where the card itself is in the stack, which is the middle of a cut.  Its neighbours
     * are only a ruler, and a ruler over the papyrus is in the way of reading it.
     *
     * Which way it runs is the plane's: a cut along u has the sheets lying one above another, a cut
     * along v has them side by side (`mapping` in `render.ts`), so the line lies across the sheets
     * either way rather than along them.
     */
    const down = wantedPlane.current === "uw";
    context.lineCap = "round";
    context.beginPath();
    if (down) {
      context.moveTo(0, height / 2);
      context.lineTo(width, height / 2);
    } else {
      context.moveTo(width / 2, 0);
      context.lineTo(width / 2, height);
    }
    context.strokeStyle = SHEET_LINE_EDGE;
    context.lineWidth = 3.4 * density;
    context.stroke();
    context.strokeStyle = SHEET_LINE;
    context.lineWidth = 1.4 * density;
    context.stroke();
  };

  useEffect(markSheets, [plane, card.width, card.height, drawn, spotted]);

  /*
   * Where the group's mark is on this piece.  Asked again whenever the mark moves or the piece is
   * built, since only the worker knows the piece; the answer turns the card to the sheet it is on.
   */
  useEffect(() => {
    if (mark === undefined) {
      spot.current = null;
      setSpotted((count) => count + 1);
      return;
    }
    if (status !== "ready") return;
    surfaceEngine().point(id, [mark.z, mark.y, mark.x]);
  }, [id, mark, status]);

  // Pulling a sheet on a cut: the one taken hold of follows the hand, and the card moves under it.
  useEffect(() => {
    const element = lines.current;
    if (element === null || plane === "uv") return;
    // A cut along u stacks the sheets downwards; a cut along v lays them out to the right.
    const down = plane === "uw";
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey) return;
      const box = element.getBoundingClientRect();
      const across = down ? element.clientHeight : element.clientWidth;
      const at = down ? event.clientY - box.top : event.clientX - box.left;
      if (Math.abs(at - across / 2) > GRAB) return;
      event.stopPropagation();
      pulling.current = {
        from: down ? event.clientY : event.clientX,
        w: wanted.current,
        // Pulling one way brings the sheets on the other side into view, so w falls as the hand goes.
        perPixel: -(2 * SPAN) / across,
      };
      let waiting = false;
      const move = (moved: PointerEvent) => {
        const hold = pulling.current;
        if (hold === undefined) return;
        moved.preventDefault();
        const now = down ? moved.clientY : moved.clientX;
        const next = Math.round((hold.w + (now - hold.from) * hold.perPixel) * 1000) / 1000;
        wanted.current = next;
        if (waiting) return;
        waiting = true;
        requestAnimationFrame(() => {
          waiting = false;
          if (pulling.current !== undefined) surfaceEngine().show(id, wanted.current, wantedPlane.current);
        });
      };
      const stop = () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", stop, true);
        window.removeEventListener("pointercancel", stop, true);
        pulling.current = undefined;
        dispatch({ type: "setSurfaceLayer", id, w: wanted.current });
      };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", stop, true);
      window.addEventListener("pointercancel", stop, true);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (pulling.current !== undefined) return;
      const box = element.getBoundingClientRect();
      const across = down ? element.clientHeight : element.clientWidth;
      const at = down ? event.clientY - box.top : event.clientX - box.left;
      element.style.cursor = Math.abs(at - across / 2) <= GRAB ? (down ? "ns-resize" : "ew-resize") : "";
    };
    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("pointermove", onPointerMove);
    return () => {
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
    };
  }, [id, plane, dispatch]);

  const message = drawn ? undefined : (MESSAGES[status] ?? MESSAGES.loading);

  return (
    <div
      className={`card${selected ? " selected" : ""}${linked > 1 ? " grouped" : ""}`}
      data-card={card.id}
      data-status={status}
      style={{
        left: card.x,
        top: card.y,
        width: card.width,
        height: card.height,
        zIndex: card.z,
        ["--group-hue" as string]: hue,
      }}
    >
      <div className="card-top">
        <span className="card-planes">
          <button
            className="card-plane"
            title={PLANE_TITLES[plane]}
            onClick={() => setPlaneMenu(!planeMenu)}
            onBlur={() => setTimeout(() => setPlaneMenu(false), 120)}
          >
            {plane.toUpperCase()}
          </button>
          {planeMenu && (
            <div className="card-plane-menu">
              {PLANES.map((value) => (
                <button
                  key={value}
                  title={PLANE_TITLES[value]}
                  onClick={() => {
                    setPlaneMenu(false);
                    dispatch({ type: "setSurfacePlane", id: card.id, plane: value });
                  }}
                >
                  {value.toUpperCase()}
                </button>
              ))}
            </div>
          )}
        </span>
        <span className="card-name">{source === undefined ? "" : shorten(sourceLabel(source))}</span>
        {linked > 1 && (
          <button
            className="card-link"
            title={`Linked to ${linked - 1} other card${linked === 2 ? "" : "s"}; click to unlink`}
            onClick={onUnlink}
          >
            {`⛓ ${linked}`}
          </button>
        )}
        <button
          className="card-close"
          title="Remove"
          onClick={() => dispatch({ type: "removeCard", id: card.id })}
        >
          ✕
        </button>
      </div>

      <div
        className="card-body"
        ref={body}
        data-loading={loading}
        /*
         * Double-clicking the papyrus marks the voxel there for the whole group, as it does on a
         * slice card: the worker is asked which voxel this point of the frame is, and the answer
         * goes to the board.
         */
        onDoubleClick={(event) => {
          const element = canvas.current;
          if (element === null) return;
          const box = element.getBoundingClientRect();
          const fx = (event.clientX - box.left) / box.width;
          const fy = (event.clientY - box.top) / box.height;
          if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return;
          surfaceEngine().where(id, fx, fy);
        }}
      >
        <canvas className="card-surface" ref={canvas} />
        <canvas className="card-lines card-sheets" ref={lines} />
        {message !== undefined && (
          <div className="card-overlay">
            <div className="card-message">{message}</div>
          </div>
        )}
        <div className="card-resize" title="Resize" />
      </div>

      <div className="card-bottom">
        <span
          className={`card-layer${loading ? " loading" : ""}`}
          title="Sheets from the one the card was opened on; whole numbers are sheets"
        >
          {formatLayer(w)}
        </span>
        <span className="card-centre">{formatVoxel(seed)}</span>
      </div>
    </div>
  );
}

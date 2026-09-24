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
import { surfaceEngine } from "../surface/engine";
import type { FrameEvent, SurfacePlane, SurfaceFacts, SurfaceStatus } from "../surface/types";
import { formatVoxel, shorten } from "./CardView";

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
    `   sheets ${facts.apart} voxels apart · holes ${facts.holes} · torn ${facts.torn} · edges ×${facts.stretch}`
  );
}

export interface SurfaceCardViewProps {
  card: CardState;
  source: Source | undefined;
  selected: boolean;
  dispatch: (action: BoardAction) => void;
}

export function SurfaceCardView({ card, source, selected, dispatch }: SurfaceCardViewProps) {
  const body = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  // Kept between frames: a frame is copied into it rather than a new one being made each time.
  const image = useRef<ImageData>(undefined);
  // The sheet last drawn, which is not the one asked for while a frame for it is on its way.
  const shown = useRef<number>(undefined);
  const [status, setStatus] = useState<Status>("loading");
  const [drawn, setDrawn] = useState(false);
  const [loading, setLoading] = useState(true);
  const [planeMenu, setPlaneMenu] = useState(false);
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
  // The size the sheet was built for; it is not built again while the card is resized, since the
  // sheet it shows does not change.
  const size = useRef({ width: card.width, height: card.height });
  const density = Math.min(MAX_DENSITY, window.devicePixelRatio || 1);

  const paint = (frame: FrameEvent) => {
    const element = canvas.current;
    const context = element?.getContext("2d");
    if (element == null || context == null) return;
    /*
     * The canvas is sized only when the size actually changes: setting `width` or `height`, even to
     * the value it already has, makes the browser throw the canvas away and allocate another, which
     * on every frame is work for nothing and churns the memory the GPU draws from.
     */
    if (element.width !== frame.width || element.height !== frame.height) {
      element.width = frame.width;
      element.height = frame.height;
      image.current = context.createImageData(frame.width, frame.height);
    }
    const into = (image.current ??= context.createImageData(frame.width, frame.height));
    into.data.set(new Uint8ClampedArray(frame.pixels));
    context.putImageData(into, 0, 0);
    shown.current = frame.w;
    setDrawn(true);
    // Still loading while this is not the sheet and plane asked for last, or not all of it.
    setLoading(
      frame.loading ||
        frame.plane !== wantedPlane.current ||
        (!frame.limited && frame.w !== wanted.current),
    );
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
  }, [id, sourceId, seed, zoom]);

  useEffect(() => {
    surfaceEngine().show(id, w, plane);
    setLoading(true);
  }, [id, w, plane]);

  /*
   * Asks for another sheet at once, and tells the board a moment later.  A wheel turned across a
   * trackpad sends its scroll dozens of times a second, and putting each of those through the board's
   * state would lay out every card and schedule a save for each one; the worker only needs the last
   * sheet asked for, and the board only needs to know where the card came to rest.
   */
  const settling = useRef<ReturnType<typeof setTimeout>>(undefined);
  const askFor = (next: number) => {
    wanted.current = next;
    surfaceEngine().show(id, next, wantedPlane.current);
    setLoading(true);
    if (settling.current !== undefined) clearTimeout(settling.current);
    settling.current = setTimeout(() => {
      settling.current = undefined;
      dispatch({ type: "setSurfaceLayer", id, w: wanted.current });
    }, 200);
  };
  useEffect(() => () => clearTimeout(settling.current), []);

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

  const message = drawn ? undefined : (MESSAGES[status] ?? MESSAGES.loading);

  return (
    <div
      className={`card${selected ? " selected" : ""}`}
      data-card={card.id}
      data-status={status}
      style={{
        left: card.x,
        top: card.y,
        width: card.width,
        height: card.height,
        zIndex: card.z,
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
        <button
          className="card-close"
          title="Remove"
          onClick={() => dispatch({ type: "removeCard", id: card.id })}
        >
          ✕
        </button>
      </div>

      <div className="card-body" ref={body} data-loading={loading}>
        <canvas className="card-surface" ref={canvas} />
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

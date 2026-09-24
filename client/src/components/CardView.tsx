/**
 * @file One card: a frame in board coordinates showing a cross-section of the scan it names.  A card
 * with no source asks which one to show instead (see `SourcePicker.tsx`).
 *
 * The data is only moved while Alt is held, so that dragging a card, or the board under it, never
 * moves what the card is looking at by accident.
 *
 * The card's frame is the data and nothing else, so it can be made square; what the card says about
 * itself — the plane, the scan, the voxel it is looking at — floats just above and just below the
 * frame, over the board rather than over the data.  All of it stays on screen, because that is what
 * makes a card readable while working and worth a screenshot.  The controls — the link, the close and
 * the resize corner — appear under the pointer.  The lines are also what the card is dragged by;
 * dragging the data pans the slice.
 */

import { useEffect, useRef, useState } from "react";
import type { Point, ViewOrientation } from "viewer";
import { getLasagna } from "../api/lasagna";
import { sourceLabel } from "../api/sources";
import type { Source } from "../api/sources";
import type { Session } from "../board/session";
import type { BoardAction, CardState } from "../board/state";
import { crossSection, sheetsOf, watchSheets } from "../surface/layers";
import { SourcePicker } from "./SourcePicker";

const ORIENTATIONS: ViewOrientation[] = ["xy", "xz", "yz"];

/**
 * Which way each plane is laid out, as indices into a point read as (z, y, x): across the view, down
 * it, and the axis it is a slice of.  x goes right, y down, z right or down, as the viewer arranges
 * them, so a sheet's line lands where the papyrus under it does.
 */
const AXES: Record<ViewOrientation, [number, number, number]> = {
  xy: [2, 1, 0],
  xz: [2, 0, 1],
  yz: [0, 1, 2],
};

// The line where a surface card's sheet cuts this slice.
const SHEET_LINE = "rgba(120, 220, 255, 0.85)";

export function formatVoxel({ x, y, z }: Point) {
  return `x ${Math.round(x)} · y ${Math.round(y)} · z ${Math.round(z)}`;
}

/**
 * The three numbers in what someone typed, in the order x, y, z.  Anything between them is ignored,
 * so the card's own `x 20048 · y 7856 · z 37888` can be pasted straight back, and so can
 * `20048 7856 37888` or `20048, 7856, 37888`.
 */
function parsePlace(text: string) {
  const numbers = text.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];
  if (numbers.length !== 3 || numbers.some((n) => !Number.isFinite(n))) return undefined;
  return { x: numbers[0], y: numbers[1], z: numbers[2] };
}

// A scan is named for the card without saying that it is masked, which nearly all of them are.
export function shorten(name: string) {
  return name.replace(/\s*·\s*masked$/, "");
}

export interface CardViewProps {
  card: CardState;
  source: Source | undefined;
  hue: number;
  selected: boolean;
  // How many cards move with this one, itself included.
  linked: number;
  session: Session;
  // Bumped when the viewer is replaced, so that the view is added to the new one.
  generation: number;
  dispatch: (action: BoardAction) => void;
  // Called when the shared position or zoom moves, which the saved board also holds.
  onLooked: () => void;
  // Takes this card out of its group, keeping it where it is looking.
  onUnlink: () => void;
  // Opens a surface card on the sheet at `seed`.
  onOpenSurface: (seed: Point) => void;
}

/**
 * The menu a right click on the data opens: where it was opened, in the card's own pixels, on which
 * voxel, and whether this scan has a surface prediction, which is asked as the menu opens.
 */
interface CardMenu {
  x: number;
  y: number;
  point: Point;
  surface: "asking" | "yes" | "no" | "unknown";
}

export function CardView({
  card,
  source,
  hue,
  selected,
  linked,
  session,
  generation,
  dispatch,
  onLooked,
  onUnlink,
  onOpenSurface,
}: CardViewProps) {
  const slice = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [centre, setCentre] = useState<Point>();
  const [pointer, setPointer] = useState<Point>();
  // The place being typed into the card's own coordinates, while someone is typing one.
  const [typed, setTyped] = useState<string>();
  // Bumped when a surface card moves to another sheet, so that its line is drawn again.
  const [sheetsMoved, setSheetsMoved] = useState(0);
  const lines = useRef<HTMLCanvasElement>(null);
  const [planeMenu, setPlaneMenu] = useState(false);
  const [menu, setMenu] = useState<CardMenu>();
  const { sourceId, orientation, groupId } = card;

  // The menu goes away on a press anywhere else, and on Escape.
  useEffect(() => {
    if (menu === undefined) return;
    const onDown = (event: PointerEvent) => {
      if (!(event.target as Element).closest?.(".card-menu")) setMenu(undefined);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setMenu(undefined);
    document.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  // The viewer's side of the card: one view, for as long as it shows this scan in this plane.
  useEffect(() => {
    if (sourceId === null || slice.current === null) return;
    const volume = session.volumes.get(sourceId);
    const navigation = session.group(groupId).navigationFor(volume);
    const added = session.viewer.addView(slice.current, {
      volume,
      orientation,
      navigation,
    });
    // The view navigates only while Alt is held; every other press and wheel belongs to the board,
    // which moves the card or the board itself.
    added.handleInput = (event) => event.altKey;
    setFailed(false);
    setLoaded(false);
    setCentre(navigation.position);
    const off = navigation.onViewChanged(() => {
      setCentre(navigation.position);
      onLooked();
    });
    const unwatch = session.watchPointer(added, setPointer);
    // Asked now, so that the menu knows whether a surface can be opened by the time it is opened.
    getLasagna(sourceId).catch(() => {});
    let current = true;
    volume.loaded.then(
      () => current && setLoaded(true),
      (error) => {
        if (!current) return;
        console.error("Failed to load the volume:", error);
        setFailed(true);
      },
    );
    return () => {
      current = false;
      off();
      unwatch();
      setPointer(undefined);
      added.dispose();
    };
    // `onLooked` is left out on purpose: it only schedules a save, and a new one every render would
    // take the view apart and add it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, generation, sourceId, groupId, orientation]);

  useEffect(() => watchSheets(() => setSheetsMoved((moved) => moved + 1)), []);

  /*
   * The sheets of the surface cards on this scan, drawn where they cut this slice.  It is the
   * plainest check on the flattening there is: the line should ride along the papyrus, and turning a
   * surface card's wheel should walk it from one sheet to the next.  Where it cuts across the grain
   * instead, the piece is wrong there, and no number says it half as clearly.
   */
  useEffect(() => {
    const canvas = lines.current;
    if (canvas === null) return;
    const context = canvas.getContext("2d");
    if (context === null) return;
    const density = Math.min(2, window.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(canvas.clientWidth * density));
    const height = Math.max(1, Math.round(canvas.clientHeight * density));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.clearRect(0, 0, width, height);
    const navigation = session.group(groupId).navigation;
    const looking = navigation?.position;
    const zoom = navigation?.zoom;
    if (looking === undefined || zoom === undefined || !Number.isFinite(zoom) || zoom <= 0) return;
    const at = [looking.z, looking.y, looking.x];
    const [across, down, sliced] = AXES[orientation];
    context.strokeStyle = SHEET_LINE;
    context.lineWidth = 1.5 * density;
    context.lineCap = "round";
    for (const sheet of sheetsOf(sourceId)) {
      const segments = crossSection(sheet, sliced, at[sliced]);
      if (segments.length === 0) continue;
      context.beginPath();
      for (const segment of segments) {
        context.moveTo(
          width / 2 + ((segment[across] - at[across]) / zoom) * density,
          height / 2 + ((segment[down] - at[down]) / zoom) * density,
        );
        context.lineTo(
          width / 2 + ((segment[3 + across] - at[across]) / zoom) * density,
          height / 2 + ((segment[3 + down] - at[down]) / zoom) * density,
        );
      }
      context.stroke();
    }
  }, [sheetsMoved, centre, orientation, sourceId, groupId, session, card.width, card.height]);

  const name = source === undefined ? "" : shorten(sourceLabel(source));
  const voxel = pointer ?? centre;

  return (
    <div
      className={`card${selected ? " selected" : ""}${linked > 1 ? " grouped" : ""}`}
      data-card={card.id}
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
            title="Plane"
            onClick={() => setPlaneMenu(!planeMenu)}
            onBlur={() => setTimeout(() => setPlaneMenu(false), 120)}
          >
            {orientation.toUpperCase()}
          </button>
          {planeMenu && (
            <div className="card-plane-menu">
              {ORIENTATIONS.map((value) => (
                <button
                  key={value}
                  onClick={() => {
                    setPlaneMenu(false);
                    dispatch({
                      type: "setOrientation",
                      id: card.id,
                      orientation: value,
                    });
                  }}
                >
                  {value.toUpperCase()}
                </button>
              ))}
            </div>
          )}
        </span>
        <span
          className="card-name"
          title={
            source === undefined
              ? undefined
              : [source.local, source.http].filter((x) => x !== "").join("\n")
          }
        >
          {name}
        </span>
        {linked > 1 && (
          <button
            className="card-link"
            title={`Moves with ${linked - 1} other card${linked === 2 ? "" : "s"}; click to unlink`}
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
        onContextMenu={(event) => {
          event.preventDefault();
          if (sourceId === null || pointer === undefined) return;
          const rect = event.currentTarget.getBoundingClientRect();
          // The card is drawn scaled with the board; the menu is placed in the card's own pixels.
          const scale = rect.width / card.width;
          setMenu({
            x: (event.clientX - rect.left) / scale,
            y: (event.clientY - rect.top) / scale,
            point: pointer,
            surface: "asking",
          });
          getLasagna(sourceId).then(
            (lasagna) => setMenu((open) => open && { ...open, surface: lasagna === null ? "no" : "yes" }),
            (error) => {
              console.error("Failed to ask for the surface prediction:", error);
              setMenu((open) => open && { ...open, surface: "unknown" });
            },
          );
        }}
      >
        {/* The viewer puts its canvas inside this element, so it has no border or padding. */}
        <div className="card-slice" ref={slice} />
        <canvas className="card-lines" ref={lines} />
        {sourceId === null && (
          <div className="card-overlay">
            <SourcePicker
              onChosen={(chosen) =>
                dispatch({ type: "setSource", id: card.id, source: chosen })
              }
            />
          </div>
        )}
        {sourceId !== null && failed && (
          <div className="card-overlay">
            <div className="card-message">
              Failed to load this source. See the browser console.
              <button
                onClick={() => dispatch({ type: "clearSource", id: card.id })}
              >
                Change source
              </button>
            </div>
          </div>
        )}
        {sourceId !== null && !failed && !loaded && (
          <div className="card-overlay">
            <div className="card-message">Loading…</div>
          </div>
        )}
        <div className="card-resize" title="Resize" />
      </div>

      {menu !== undefined && (
        <div className="card-menu" style={{ left: menu.x, top: menu.y }}>
          <button
            disabled={menu.surface !== "yes"}
            onClick={() => {
              setMenu(undefined);
              onOpenSurface(menu.point);
            }}
          >
            Open surface here
          </button>
          {menu.surface !== "yes" && (
            <div className="card-menu-note">
              {menu.surface === "asking"
                ? "Looking for a surface prediction…"
                : menu.surface === "no"
                  ? "This scan has no surface prediction."
                  : "Could not ask the server. See the browser console."}
            </div>
          )}
        </div>
      )}

      <div className="card-bottom">
        {typed === undefined ? (
          <button
            type="button"
            className={`card-place${pointer === undefined ? " card-centre" : " card-pointer"}`}
            title="Click to go to a place"
            onClick={() => {
              if (centre !== undefined) {
                setTyped(`${Math.round(centre.x)} ${Math.round(centre.y)} ${Math.round(centre.z)}`);
              }
            }}
          >
            {voxel === undefined ? "" : formatVoxel(voxel)}
          </button>
        ) : (
          <input
            className="card-place card-typing"
            autoFocus
            spellCheck={false}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onBlur={() => setTyped(undefined)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                const place = parsePlace(typed);
                if (place !== undefined) session.group(groupId).navigation?.setPosition(place);
                setTyped(undefined);
              } else if (event.key === "Escape") {
                setTyped(undefined);
              }
            }}
          />
        )}
      </div>
    </div>
  );
}

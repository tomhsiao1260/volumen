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
import type { BoardAction, CardState, PickedPoint, Tool } from "../board/state";
import { surfaceEngine } from "../surface/engine";
import { crossSection, setDrawnDots, sheetsOf, watchSheets, type DrawnDot } from "../surface/layers";
import { chainColour, chainsOf, watchChains } from "../surface/windings";
import { SourcePicker } from "./SourcePicker";

const ORIENTATIONS: ViewOrientation[] = ["xy", "xz", "yz"];

// How far (`x`, `y`) is from the segment (`ax`, `ay`)–(`bx`, `by`).
function distanceToSegment(x: number, y: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay;
  const length = dx * dx + dy * dy;
  const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length));
  return Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
}

/*
 * How near the pointer has to be to take hold of something, in the card's pixels: a winding point, and
 * a sheet's line.  The line's reach is wider, because it is thin and it wanders, and hunting for the
 * one pixel that will catch it is the sort of thing that makes a person give up and go and do it
 * somewhere else.  With Shift held there is no hunting at all: the nearest line is taken, from
 * wherever on the card the press lands.
 */
const GRAB = 7;
const GRAB_LINE = 16;

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

/*
 * The line where a surface card's sheet cuts this slice: a dark stroke under a bright one, so that it
 * reads over pale papyrus and dark gaps alike without hiding what is underneath.
 */
const SHEET_LINE = "rgba(130, 225, 255, 0.92)";
const SHEET_LINE_EDGE = "rgba(0, 10, 20, 0.55)";


/*
 * A winding annotation, in the colours VC3D gives the same two things (`SpiralPclRole.hpp`): cyan for
 * "these are one and the same sheet", orange for counting one wrap after the next.  Somebody who has
 * annotated a scroll before should recognise them.
 */
export const SAME_DOT = "rgba(50, 255, 215, 0.95)";
export const STEP_DOT = "rgba(255, 170, 50, 0.95)";
const STEP_EDGE = "rgba(20, 14, 6, 0.7)";

// A point taken hold of is drawn larger, by the same amount VC3D uses for the same thing.
const HELD_LARGER = 1.4;

/*
 * How far apart the wraps are, in voxels, until a surface card of this scan has measured it.  On the
 * scans this reads — 2.4 to 8 µm a voxel — a wrap is of this order, and it is only used to decide how
 * far from a slice an annotation is still about the papyrus in front of you.
 */
const WRAP_GUESS = 50;

export function drawDot(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  density: number,
  // How near this slice the point is, 1 on it and fading to 0 as it goes behind or in front.
  near: number,
  turn: number | null,
  held = false,
  colour = STEP_DOT,
  // A relative winding's points are drawn hollow, a same winding's filled.
  apart = false,
  /*
   * A chain nobody is working on is drawn small and quiet.  A card may carry dozens of them, and
   * drawn all alike they cover the papyrus they are about — which is the one thing the person is
   * trying to look at.  The chain being drawn, the one a point is held on, and the one under the
   * pointer in the list are the loud ones.
   */
  loud = true,
) {
  context.save();
  context.globalAlpha = near * (loud ? 1 : 0.42);
  if (held) {
    context.beginPath();
    context.arc(x, y, 9 * density, 0, 2 * Math.PI);
    context.strokeStyle = colour;
    context.lineWidth = 1.6 * density;
    context.stroke();
  }
  const radius = (loud ? 4.2 : 2.6) * (held ? HELD_LARGER : 1) * density;
  /*
   * Filled says "the same wrap", hollow says "a different wrap".  Shape alone was not enough — a
   * diamond and a circle four pixels across are the same mark — but solid against open reads at any
   * size, and it carries the meaning: a same winding gathers places together, a relative winding
   * holds them apart.  Nothing else can carry it, since a colour now says which chain this is rather
   * than which of the two things it says, and the wrap numbers are gone.
   */
  context.beginPath();
  context.arc(x, y, apart ? radius * 1.2 : radius, 0, 2 * Math.PI);
  context.strokeStyle = STEP_EDGE;
  context.lineWidth = (loud ? 3.2 : 2.2) * density;
  context.stroke();
  if (apart) {
    context.fillStyle = STEP_EDGE;
    context.fill();
    context.beginPath();
    context.arc(x, y, radius * 1.2, 0, 2 * Math.PI);
    context.strokeStyle = colour;
    context.lineWidth = (loud ? 2.4 : 1.6) * density;
    context.stroke();
  } else {
    context.fillStyle = colour;
    context.fill();
  }
  if (turn !== null && near > 0.6 && loud) {
    context.font = `${10 * density}px ui-monospace, monospace`;
    context.textAlign = "left";
    context.textBaseline = "middle";
    context.lineWidth = 3 * density;
    context.strokeStyle = STEP_EDGE;
    context.strokeText(`${turn}`, x + 7 * density, y - 6 * density);
    context.fillStyle = colour;
    context.fillText(`${turn}`, x + 7 * density, y - 6 * density);
  }
  context.restore();
}


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
  // The voxel the group has marked, if it has one.
  // The chain the person is pointing at in the list, drawn loud like the one they are working on.
  lit: string | undefined;
  // What a press on the data does, and the scan the annotations of this card are filed under.
  tool: Tool;
  scan: string;
  // The winding point taken hold of, which is the one Delete would remove.
  picked: PickedPoint | undefined;
  session: Session;
  // Bumped when the viewer is replaced, so that the view is added to the new one.
  generation: number;
  dispatch: (action: BoardAction) => void;
  // Called when the shared position or zoom moves, which the saved board also holds.
  onLooked: () => void;
  // Takes this card out of its group, keeping it where it is looking.
  onUnlink: () => void;
  // Puts a winding point down at this voxel, joining the chain being drawn or starting one.
  onPlace: (at: Point) => void;
  /*
   * A press with a winding tool on a point already down.  It says that point is part of what is being
   * drawn, so the chain it belongs to and the chain being drawn are one and the same winding.
   */
  onJoin: (at: PickedPoint) => void;
  // Takes hold of a winding point already down, or lets go.
  onPick: (picked: PickedPoint | undefined) => void;
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
  lit,
  tool,
  scan,
  picked,
  session,
  generation,
  dispatch,
  onLooked,
  onUnlink,
  onPlace,
  onJoin,
  onPick,
  onOpenSurface,
}: CardViewProps) {
  const slice = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [centre, setCentre] = useState<Point>();
  const [pointer, setPointer] = useState<Point>();
  // The winding point the pointer is on, which is drawn ringed to say it can be pressed.
  const [over, setOver] = useState<PickedPoint>();
  // The place being typed into the card's own coordinates, while someone is typing one.
  const [typed, setTyped] = useState<string>();
  // Bumped when a surface card moves to another sheet, so that its line is drawn again.
  const [sheetsMoved, setSheetsMoved] = useState(0);
  const [chainsMoved, setChainsMoved] = useState(0);
  // Where each winding point was drawn, in the card's own pixels: what a press looks through to find
  // the point under it.
  const drawnDots = useRef<DrawnDot[]>([]);
  const lines = useRef<HTMLCanvasElement>(null);
  const body = useRef<HTMLDivElement>(null);
  /*
   * The lines as they were drawn, in the card's own pixels, so that the pointer can be tested against
   * them without working the whole grid out again — and beside each, what a drag across it is worth:
   * how much w one pixel of the card is, which is the sheet's normal seen in this plane, scaled by
   * the zoom and by how far apart the sheets are.
   */
  const drawnLines = useRef<
    { cardId: string; points: number[]; perPixel: { x: number; y: number } }[]
  >([]);
  const dragging = useRef<
    { cardId: string; from: { x: number; y: number }; w: number; perPixel: { x: number; y: number } } | undefined
  >(undefined);
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
  useEffect(() => watchChains(() => setChainsMoved((moved) => moved + 1)), []);
  // Read by the press listener below, which is registered once and outlives every one of these.
  const toolRef = useRef(tool);
  const pointerRef = useRef<Point | undefined>(undefined);
  const onPlaceRef = useRef(onPlace);
  const onJoinRef = useRef(onJoin);
  const onPickRef = useRef(onPick);
  useEffect(() => {
    toolRef.current = tool;
    pointerRef.current = pointer;
    onPlaceRef.current = onPlace;
    onJoinRef.current = onJoin;
    onPickRef.current = onPick;
  });

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
    context.lineCap = "round";
    context.lineJoin = "round";
    drawnLines.current = [];
    for (const sheet of sheetsOf(sourceId)) {
      const segments = crossSection(sheet, sliced, at[sliced]);
      if (segments.length === 0) continue;
      const points: number[] = [];
      context.beginPath();
      for (const segment of segments) {
        const x1 = canvas.clientWidth / 2 + (segment[across] - at[across]) / zoom;
        const y1 = canvas.clientHeight / 2 + (segment[down] - at[down]) / zoom;
        const x2 = canvas.clientWidth / 2 + (segment[3 + across] - at[across]) / zoom;
        const y2 = canvas.clientHeight / 2 + (segment[3 + down] - at[down]) / zoom;
        points.push(x1, y1, x2, y2);
        context.moveTo(x1 * density, y1 * density);
        context.lineTo(x2 * density, y2 * density);
      }
      drawnLines.current.push({
        cardId: sheet.cardId,
        points,
        perPixel: {
          x: (sheet.normal[across] * zoom) / sheet.spacing,
          y: (sheet.normal[down] * zoom) / sheet.spacing,
        },
      });
      context.strokeStyle = SHEET_LINE_EDGE;
      context.lineWidth = 3.4 * density;
      context.stroke();
      context.strokeStyle = SHEET_LINE;
      context.lineWidth = 1.4 * density;
      context.stroke();
    }
    /*
     * The winding annotations of this scan, wherever they fall on this slice.  A chain is drawn as
     * its points joined in the order they were placed, each with the wrap it was counted as: it is
     * the only way to see what one says without reading it back out of a file.
     *
     * A point away from this slice fades with how far away it is, and is not drawn at all once it is
     * half a wrap away.  Drawn all alike, a point three hundred voxels behind the slice looks exactly
     * like one on it — and a chain laid along a wrap on one card then reads, on a card cut the other
     * way, as a chain climbing straight across the wraps, when all that has happened is that the axis
     * it was drawn along has been flattened away.
     *
     * Half a wrap, rather than some fraction of the card, because that is the distance at which a
     * place stops being about the papyrus in front of you: beyond it there is another wrap in the
     * way.  Annotations drawn on three different slices of the same place would otherwise all land on
     * every card at once, which is what a hundred of them look like.
     */
    const apart = sheetsOf(sourceId)[0]?.spacing ?? WRAP_GUESS;
    const fade = apart / 2;
    drawnDots.current = [];
    for (const one of chainsOf(scan)) {
      if (one.points.length === 0) continue;
      const places = one.points.map((point) => {
        const q = [point.at.z, point.at.y, point.at.x];
        const off = Math.abs(q[sliced] - at[sliced]);
        return {
          x: canvas.clientWidth / 2 + (q[across] - at[across]) / zoom,
          y: canvas.clientHeight / 2 + (q[down] - at[down]) / zoom,
          near: off <= 0.5 ? 1 : Math.max(0, 1 - off / fade),
          turn: point.turn,
        };
      });
      if (places.every((place) => place.near === 0)) continue;
      const colour = chainColour(one);
      const loud = one.id === lit || one.id === picked?.chain;
      // The thread belongs to the chain being worked on; on the others it is what makes a card of
      // papyrus look like a cat's cradle.
      const apart = one.kind === "step";
      context.save();
      /*
       * Quiet, but not gone: with a colour of its own per chain the thread is what makes a scatter of
       * dots read as one winding rather than as a field of them.  A relative winding's thread is drawn
       * plainly and always, because the thread IS the thing it says — these two places are not the
       * same wrap — and it is cut through the middle to say so.
       */
      context.globalAlpha = apart ? (one.on ? 0.85 : 0.35) : loud ? (one.on ? 0.75 : 0.3) : one.on ? 0.2 : 0.09;
      context.strokeStyle = colour;
      context.lineWidth = (apart ? 1.8 : 1.4) * density;
      context.setLineDash(apart ? [] : [4 * density, 4 * density]);
      context.beginPath();
      let drawing = false;
      let from;
      const cuts: [number, number, number, number][] = [];
      for (const place of places) {
        // The thread is drawn only between points that are both near enough to be shown.
        if (place.near === 0) {
          drawing = false;
          from = undefined;
          continue;
        }
        if (drawing) {
          context.lineTo(place.x * density, place.y * density);
          if (from !== undefined) cuts.push([from.x, from.y, place.x, place.y]);
        } else context.moveTo(place.x * density, place.y * density);
        from = place;
        drawing = true;
      }
      context.stroke();
      // The cut: a short bar across the middle of each link, the way a break is drawn.
      if (apart)
        for (const [x1, y1, x2, y2] of cuts) {
          const away = Math.hypot(x2 - x1, y2 - y1) || 1;
          const [ux, uy] = [(x2 - x1) / away, (y2 - y1) / away];
          const [mx, my] = [((x1 + x2) / 2) * density, ((y1 + y2) / 2) * density];
          const arm = 2.6 * density;
          context.beginPath();
          context.moveTo(mx - uy * arm, my + ux * arm);
          context.lineTo(mx + uy * arm, my - ux * arm);
          context.lineWidth = 1.7 * density;
          context.stroke();
        }
      context.restore();
      one.points.forEach((point, k) => {
        const place = places[k];
        if (place.near === 0) return;
        // Ringed while the pointer is on it, so that "this point can be pressed" — and with a winding
        // tool that means "joined to what I am drawing" — is seen rather than remembered.
        const held =
          (picked?.chain === one.id && picked.point === point.id) ||
          (over?.chain === one.id && over.point === point.id);
        drawnDots.current.push({ chain: one.id, point: point.id, x: place.x, y: place.y, near: place.near });
        context.save();
        if (!one.on) context.globalAlpha = 0.35;
        drawDot(
          context,
          place.x * density,
          place.y * density,
          density,
          place.near,
          place.turn,
          held,
          colour,
          one.kind === "step",
          loud,
        );
        context.restore();
      });
    }
    setDrawnDots(card.id, drawnDots.current);
  }, [
    sheetsMoved,
    chainsMoved,
    centre,
    picked,
    over,
    lit,
    scan,
    orientation,
    sourceId,
    groupId,
    session,
    card.width,
    card.height,
  ]);

  // The sheet's line under the pointer, in the card's own pixels.
  const lineUnder = (x: number, y: number, anywhere = false) => {
    let found;
    let nearest = anywhere ? Infinity : GRAB_LINE;
    for (const line of drawnLines.current) {
      for (let i = 0; i + 3 < line.points.length; i += 4) {
        const away = distanceToSegment(x, y, line.points[i], line.points[i + 1], line.points[i + 2], line.points[i + 3]);
        if (away < nearest) {
          nearest = away;
          found = line;
        }
      }
    }
    return found;
  };

  /*
   * Taking hold of a sheet's line and pulling it through the papyrus.  The surface card follows at
   * once, and the board only hears about it when the hand lets go, the same as for its own wheel.
   *
   * The press is listened for on the card itself rather than through React, which hands its events
   * out at the root of the page — by then the board has already seen the press and started to move
   * the card.
   */
  useEffect(() => {
    const element = body.current;
    if (element === null) return;

    // The winding point under the pointer, in the card's own pixels.
    const dotUnder = (x: number, y: number) => {
      let found;
      let nearest = GRAB + 3;
      for (const dot of drawnDots.current) {
        const away = Math.hypot(dot.x - x, dot.y - y);
        if (away < nearest) {
          nearest = away;
          found = { chain: dot.chain, point: dot.point };
        }
      }
      return found;
    };

    const lineUnder = (x: number, y: number, anywhere = false) => {
      let found;
      let nearest = anywhere ? Infinity : GRAB_LINE;
      for (const line of drawnLines.current) {
        for (let i = 0; i + 3 < line.points.length; i += 4) {
          const away = distanceToSegment(x, y, line.points[i], line.points[i + 1], line.points[i + 2], line.points[i + 3]);
          if (away < nearest) {
            nearest = away;
            found = line;
          }
        }
      }
      return found;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey) return;
      /*
       * With a tool picked, a press on the data puts a winding point down and goes no further: the
       * board would otherwise take hold of the card, and the sheet lines below would take the press
       * as a drag.
       */
      const box = element.getBoundingClientRect();
      const scale = box.width / element.clientWidth;
      const under = dotUnder((event.clientX - box.left) / scale, (event.clientY - box.top) / scale);
      if (toolRef.current !== "look") {
        event.stopPropagation();
        event.preventDefault();
        /*
         * A press on a point already down says that point belongs to what is being drawn too — which
         * is how a person says two annotations are one and the same winding, and the two are then
         * merged.  Anywhere else puts another point down.  Taking hold of a point to move or delete it
         * is the arrow tool's press, below: one gesture cannot mean both.
         */
        if (under !== undefined) onJoinRef.current(under);
        else {
          onPickRef.current(undefined);
          const at = pointerRef.current;
          if (at !== undefined) onPlaceRef.current(at);
        }
        return;
      }
      // The arrow takes hold of a point, which is what Delete then acts on — and lets go of one when
      // the press lands anywhere else on the data, since a ring left behind on a point nobody is
      // working on says something is held that is not.
      if (under !== undefined) {
        event.stopPropagation();
        event.preventDefault();
        onPickRef.current(under);
        return;
      }
      onPickRef.current(undefined);
      // Shift pulls the nearest sheet's line from wherever the press lands, without having to find it.
      const line = lineUnder(event.clientX - box.left, event.clientY - box.top, event.shiftKey);
      if (line === undefined) return;
      const sheet = sheetsOf(sourceId).find((one) => one.cardId === line.cardId);
      if (sheet === undefined) return;
      event.stopPropagation();
      dragging.current = {
        cardId: line.cardId,
        from: { x: event.clientX, y: event.clientY },
        w: sheet.w,
        perPixel: line.perPixel,
      };
      let asked = sheet.w;
      let waiting = false;
      const move = (moved: PointerEvent) => {
        const grabbed = dragging.current;
        if (grabbed === undefined) return;
        moved.preventDefault();
        asked =
          Math.round(
            (grabbed.w +
              (moved.clientX - grabbed.from.x) * grabbed.perPixel.x +
              (moved.clientY - grabbed.from.y) * grabbed.perPixel.y) *
              1000,
          ) / 1000;
        // Once a frame is as often as the card can draw one.
        if (waiting) return;
        waiting = true;
        requestAnimationFrame(() => {
          waiting = false;
          // Still held: the piece is not to be rebuilt under the hand (`ShowRequest.resting`).
          if (dragging.current !== undefined) surfaceEngine().showLayer(grabbed.cardId, asked, false);
        });
      };
      const stop = () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", stop, true);
        window.removeEventListener("pointercancel", stop, true);
        const grabbed = dragging.current;
        dragging.current = undefined;
        if (grabbed === undefined) return;
        /*
         * Where the line ACTUALLY got to, not where the hand asked it to go.
         *
         * A piece only holds a few wraps either side of its own, and while a hand is dragging it is
         * not rebuilt — so a long drag asks for more than the piece can show and the line stops at
         * the edge of it.  Taking the hand's number here would then move the line again on release,
         * past the place it had been left, which is the one thing a drag must never do: it has to
         * stop where it was let go.
         */
        const line = sheetsOf(sourceId).find((one) => one.cardId === grabbed.cardId);
        dispatch({ type: "setSurfaceLayer", id: grabbed.cardId, w: line?.w ?? asked });
      };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", stop, true);
      window.addEventListener("pointercancel", stop, true);
    };

    // The cursor says when a point or a line can be taken hold of, and the point itself is ringed.
    const onPointerMove = (event: PointerEvent) => {
      if (dragging.current !== undefined) return;
      const box = element.getBoundingClientRect();
      const scale = box.width / element.clientWidth;
      const under = dotUnder((event.clientX - box.left) / scale, (event.clientY - box.top) / scale);
      setOver((was) =>
        was?.chain === under?.chain && was?.point === under?.point ? was : under,
      );
      if (under !== undefined) {
        element.style.cursor = "pointer";
        return;
      }
      if (toolRef.current !== "look") {
        element.style.cursor = "crosshair";
        return;
      }
      element.style.cursor =
        lineUnder(event.clientX - box.left, event.clientY - box.top, event.shiftKey) !== undefined
          ? "ns-resize"
          : "";
    };
    const onPointerLeave = () => setOver(undefined);

    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("pointerleave", onPointerLeave);
    element.addEventListener("pointermove", onPointerMove);
    return () => {
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointerleave", onPointerLeave);
      element.removeEventListener("pointermove", onPointerMove);
    };
  }, [sourceId, dispatch]);

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
        ref={body}
        // Double-clicking the data marks the voxel under the pointer for the whole group: the other
        // cards move to it and show it.  The board's own double-click, which adds a card, is only
        // for the space between cards.
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

      {/*
        * Kept inside the card: opened near an edge the menu would otherwise hang over the row of
        * coordinates below, which is a row of fields — and a menu lying over a field is a field that
        * cannot be reached.
        */}
      {menu !== undefined && (
        <div
          className="card-menu"
          style={{
            left: Math.max(4, Math.min(menu.x, card.width - 192)),
            top: Math.max(4, Math.min(menu.y, card.height - 96)),
          }}
        >
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

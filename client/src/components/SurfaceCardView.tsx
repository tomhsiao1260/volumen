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

import { useCallback, useEffect, useRef, useState } from "react";
import { getLasagna } from "../api/lasagna";
import type { Source } from "../api/sources";
import { sourceLabel, sourceMicron } from "../api/sources";
import type { BoardAction, CardState, PickedPoint, Tool } from "../board/state";
import type { Point } from "viewer";
import { surfaceEngine } from "../surface/engine";
import type { Flat } from "viewer";
import type { Session } from "../board/session";
import { farOf, sheetOf } from "../surface/render";
import { setDrawnDots, setSpots, type DrawnDot } from "../surface/layers";
import type { ChainSaid, PieceSpot, SurfacePlane, SurfaceFacts, SurfaceStatus } from "../surface/types";

import type { WindChain } from "../surface/windings";
import { chainColour, chainsOf, watchChains } from "../surface/windings";
import { drawDot, formatVoxel, shorten } from "./CardView";

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

/*
 * A wheel is counted in the card's own pixels, because that is the one thing a flat card and a cut
 * card share — what the pixels then mean is the plane's, and only the flat card turns them into
 * sheets.  So the two sizes below are said in pixels and `PER_PIXEL` is what converts.
 */
// Whether this session draws its papyrus with the renderer being built to replace the old one.
const ON_GPU2 = new URLSearchParams(window.location.search).get("gpu2") === "yes";

const PER_PIXEL = 1 / 960;
const NOTCH = 1 / 8;
const NOTCH_PIXELS = NOTCH / PER_PIXEL;
/*
 * And on a cut, where the same eighth is an eighth of what the card SHOWS rather than of a sheet.
 *
 * It used to borrow the flat card's two sizes, and 960 pixels to a sheet is 360 to a gesture — which
 * on a cut is most of the papyrus the piece has along the axis being swept.  So one flick crossed it
 * and then nothing moved, which is exactly how it read: a jump, and then a wall.
 */
const CUT_NOTCH = 1 / 8;
const CUT_GESTURE = 3 / 8;
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
const GESTURE_PIXELS = PER_GESTURE / PER_PIXEL;

// What the card found is for whoever is working on it, not for the board: it is written to the
// console of a page opened with `?debug`, like the rest of the handles there.
const DEBUG = new URLSearchParams(window.location.search).has("debug");

const PLANES: SurfacePlane[] = ["uv", "uw", "vw"];

// The sheets marked on a cut across them, in the colour the slice cards use for the same thing.
const SHEET_LINE = "rgba(130, 225, 255, 0.92)";
const SHEET_LINE_EDGE = "rgba(0, 10, 20, 0.55)";
// How near the pointer has to be to one to take hold of it.
const GRAB = 7;
// How near the line a press has to be to pull the sheets.  Wider than the line looks, because it is
// the only handle a cut card has.
const LINE = 16;
// How often the worker is told where a pull has got to.  It is not what the hand is watching, so it
// only has to be often enough that the sharp picture is of roughly the right sheet when the hand stops.
const TELL_MS = 150;

/*
 * How faint a winding point goes when the card is turned away from the wrap it is on.  Not to nothing:
 * see the drawing below.
 */
const GHOST = 0.28;
const GHOST_APART = 0.45;

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
  "too-coarse":
    "This scan's voxels are too big to see the sheets — a whole winding of papyrus is only a voxel or" +
    " two across. Open a finer scan of the same scroll.",
  unknown: "Could not ask the server for the surface prediction.",
  failed: "Failed to find the sheet. See the browser console.",
};

// How many sheets one whole width of a cut is worth, about its middle: what a pull across it moves.
function describe(facts: SurfaceFacts) {
  return (
    `wraps ${facts.spacing.toFixed(0)} voxels apart at the seed · ` +
    `grid ${facts.across} × ${facts.down}, ${facts.step} voxels apart · ` +
    `${facts.kept ? "march read back" : "prediction read"} in ${facts.read} ms · ` +
    `marched in ${facts.walked} ms · table built in ${facts.built} ms\n` +
    `   ${facts.said} places said, each reaching ${facts.reach.toFixed(0)} voxels\n` +
    `   wraps ${facts.apart} voxels apart · holes ${facts.holes}` +
    ` · torn ${facts.torn} · stretch ×${facts.stretch}`
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
  // What has been said about the sheets of this scan, and is settled enough to build on.
  chains: ChainSaid[];
  // What a press on the papyrus does, the scan the annotations are filed under, and the point held.
  tool: Tool;
  scan: string;
  picked: PickedPoint | undefined;
  // The chain being pointed at in the list, which is drawn loud like the one being worked on.
  lit: string | undefined;
  dispatch: (action: BoardAction) => void;
  onUnlink: () => void;
  // Puts a winding point down at this voxel, and takes hold of one already down.
  // The viewer, for a card that draws on the GPU; `null` until it exists.
  session: Session | null;
  onPlace: (at: Point) => WindChain | undefined;
  // A press with a winding tool on a point already down: that place is on what is being drawn too,
  // so the chain it belongs to and the chain being drawn are one and the same winding.
  onJoin: (at: PickedPoint) => void;
  onPick: (picked: PickedPoint | undefined) => void;
  // Whether anything has been said that this piece has not been told yet, which happens while a
  // winding tool is in hand: the pieces are left alone then, so that a run of annotations is not
  // interrupted by a rebuild after each one.
  behind: boolean;
}

export function SurfaceCardView({
  card,
  source,
  selected,
  hue,
  linked,
  chains,
  tool,
  scan,
  picked,
  lit,
  dispatch,
  onUnlink,
  session,
  onPlace,
  onJoin,
  onPick,
  behind,
}: SurfaceCardViewProps) {
  const body = useRef<HTMLDivElement>(null);
  // The sheets drawn over a cut across them, and what is being pulled.
  const lines = useRef<HTMLCanvasElement>(null);
  const pulling = useRef<
    { from: number; zoomed: number; pin: number; perPixel: number } | undefined
  >(undefined);
  // The sheet last drawn, which is not the one asked for while a frame for it is on its way.
  const shown = useRef<number>(undefined);
  // Where the group's mark falls on this piece, null when the piece does not reach it.
  const spot = useRef<PieceSpot | null>(null);
  const [spotted, setSpotted] = useState(0);
  /*
   * And where each winding point of this scan falls on it.  A card of a sheet laid flat is the one
   * place where "these are the same sheet" needs no eye at all: every press on it is on that sheet
   * because that is what the card is.  So the points are asked about one at a time and drawn here,
   * and they fade as the card turns away from the sheet they are on.
   */
  const dots = useRef(new Map<string, PieceSpot>());
  // The winding point the pointer is on, drawn ringed to say it can be pressed.
  const [over, setOver] = useState<PickedPoint>();
  // Where each of them was drawn, in the card's own pixels: what a press looks through to find one.
  const drawnDots = useRef<DrawnDot[]>([]);
  const [chainsMoved, setChainsMoved] = useState(0);
  useEffect(() => watchChains(() => setChainsMoved((moved) => moved + 1)), []);
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
  const onPlaceRef = useRef(onPlace);
  const onJoinRef = useRef(onJoin);
  const onPickRef = useRef(onPick);
  const toolRef = useRef(tool);
  useEffect(() => {
    onPlaceRef.current = onPlace;
    onJoinRef.current = onJoin;
    onPickRef.current = onPick;
    toolRef.current = tool;
  });
  // The size the sheet was built for; it is not built again while the card is resized, since the
  // sheet it shows does not change.
  const size = useRef({ width: card.width, height: card.height });
  const density = Math.min(MAX_DENSITY, window.devicePixelRatio || 1);

  /*
   * Where the card is looking, as a DISTANCE through the papyrus in voxels.
   *
   * This is the one authority while a cut is in hand, and `w` is derived from it — not the other way
   * round.  A hand moves in pixels and a picture is in voxels; going through windings in between is
   * what let the two come apart, and they came apart badly: the rate was read from a frame, and a
   * cut card was sent none, so it fell back to a constant and the papyrus moved at a quarter of hand
   * speed.  In distance there is no constant to get wrong.
   *
   * `undefined` means "wherever `w` says", which is what any ask from outside the card leaves it as.
   */
  const far = useRef<number | undefined>(undefined);
  /*
   * Where along the papyrus a cut is taken, 0 to 1 across the grid.
   *
   * This is what a pull on a cut moves.  A cut already shows the whole stack the piece holds, so
   * travelling through the stack shows nothing that was not already on the card; what it cannot show
   * is the rest of the papyrus, one row of the grid at a time.  The flat card is the other way
   * round — it shows one sheet and travels through them — so each card moves along the axis it
   * cannot otherwise reach.
   */
  const pin = useRef(0.5);
  /*
   * Drawn on the GPU, where the march is a texture and a pixel of the card is two texture reads.
   *
   * The only way a card is drawn.  There was a path that drew on this thread, out of the scan, in
   * the worker; held against this one on the same sheet of the same piece they differed by a median
   * of 3 parts in 255, in the GPU's favour — the old one worked a position out at every eighth pixel
   * and interpolated the rest, where this does it per pixel — and it is gone.
   *
   * Only this one can be pulled ALONG the papyrus.  The old one would have had to resample a whole
   * new picture for every row of the grid a hand passes, which is the cost this replaces.
   */
  const gpuShow = Number(new URLSearchParams(window.location.search).get("show") ?? 0);
  const gpuRef = useRef<Flat | undefined>(undefined);
  /*
   * The last march and chunk list the worker sent, kept so that a view attached afterwards can be
   * given them.  Both are sent once per piece and never again, so a view that missed them would
   * draw nothing for as long as the card stayed on that piece.
   */
  const lastField = useRef<Parameters<Flat["take"]>[0] | undefined>(undefined);
  const lastWant = useRef<Parameters<Flat["want"]>[0] | undefined>(undefined);
  const gpuBox = useRef<HTMLDivElement>(null);
  // The sheet the piece was based on, in the card's own windings: the card counts from where it was
  // opened and the field counts from the piece's base.
  const baseW = useRef(0);
  // What the card needs of the piece to work its own window out: how much papyrus the grid covers
  // each way, and the walk, for turning a winding into a distance through it.
  const piece = useRef<
    {
      alongU: number;
      alongV: number;
      // The grid the march was walked on, which is what a window on it is said in.
      nu: number;
      nv: number;
      walk: { sheets: number[]; walked: number[] };
    }
    | undefined
  >(undefined);
  // Both are set up once, in handlers that must still reach the ones of the render they run in.
  const glideRef = useRef<() => void>(() => {});
  /*
   * How much papyrus a pixel of a cut card is worth.
   *
   * `wide` is the voxels a pixel covers along the sheet, which is the axis the cut shows across its
   * width: the whole piece is drawn across the card, so it is the piece divided by the card.  And
   * `reach` is the length of the axis the cut does NOT show, which is what the pin runs along — so
   * `wide / reach` is a pixel of the hand said as a fraction of the pin.
   *
   * A pixel is worth the same in both directions, which is what draws a square of papyrus square.
   * The four places that need this must agree, or the hand, the papyrus and the winding points
   * would each be working to a different scale.
   */
  const cutScale = () => {
    const have = piece.current;
    const element = gpuBox.current;
    // A cut's scale, and only a cut's: the flat card shows both axes and has no pin.
    if (have === undefined || element === null || wantedPlane.current === "uv") return undefined;
    const across = wantedPlane.current === "uw";
    const reach = across ? have.alongV : have.alongU;
    if (!(reach > 0) || !(element.clientWidth > 0)) return undefined;
    return { reach, wide: (across ? have.alongU : have.alongV) / element.clientWidth };
  };

  const shownAcross = () => {
    const have = piece.current;
    const box = gpuBox.current;
    const scale = cutScale();
    if (have === undefined || box === null || scale === undefined) return undefined;
    const wide = scale.wide * box.clientHeight;
    const middle = far.current ?? farOf(have.walk, wanted.current - baseW.current);
    // A point's winding is counted from where the card was opened; this window is in the piece's
    // own, so the base comes off a winding before it is looked up.
    return { walk: have.walk, from: middle - wide / 2, wide, base: baseW.current, reach: scale.reach };
  };

  /*
   * Where the card is looking, said to the GPU.
   *
   * Two uniforms for a cut and one for the flat card, and nothing else: no drawing here, no message
   * to the worker, no data.  This is the whole of what a pull costs.
   */
  const showOnGpu = () => {
    const view = gpuRef.current;
    const element = gpuBox.current;
    const have = piece.current;
    if (view === undefined || element === null || have === undefined) return;
    const own = wanted.current - baseW.current;
    /*
     * The new renderer is told an affine window on the flattening rather than which of three planes.
     *
     * The three planes are then three sets of constants, which is what they always were: the old
     * `mapping` worked them out a pixel at a time because the drawing was a pixel at a time.  A
     * fourth way of cutting the piece — oblique, or along a chain — needs no new code here and none
     * at all in the shader.
     */
    const lastU = have.nu - 1;
    const lastV = have.nv - 1;
    if (wantedPlane.current === "uv") {
      if (ON_GPU2) {
        view.show({
          at: [0, 0, own],
          right: [lastU, 0, 0],
          down: [0, lastV, 0],
          show: gpuShow,
        });
      } else {
        view.show({ plane: "uv", w: own, from: 0, across: 1, pin: pin.current, show: gpuShow });
      }
      shown.current = wanted.current;
      return;
    }
    const scale = cutScale();
    if (scale === undefined) return;
    const across = scale.wide * element.clientHeight;
    const middle = far.current ?? farOf(have.walk, own);
    if (ON_GPU2) {
      // A cut: one axis of the grid across the card, the sheets down it by distance, the other axis
      // held where the pin says.
      const alongU = wantedPlane.current === "uw";
      view.show({
        at: [alongU ? 0 : pin.current * lastU, alongU ? pin.current * lastV : 0, 0],
        right: alongU ? [lastU, 0, 0] : [0, lastV, 0],
        down: [0, 0, 0],
        through: { from: middle - across / 2, across },
        show: gpuShow,
      });
    } else {
      view.show({
        plane: wantedPlane.current,
        w: own,
        from: middle - across / 2,
        across,
        pin: pin.current,
        show: gpuShow,
      });
    }
    /*
     * The window, kept where a measurement can read it.
     *
     * This is the only place the picture's position exists any more: it used to be the source
     * rectangle of a `drawImage`, which a harness could watch, and now it is two uniforms inside the
     * GPU.  A pull that does not move the papyrus as far as the hand is the one fault a cut card can
     * have that nothing else shows, so it is worth three lines to keep it measurable.
     */
    if (DEBUG) {
      // With the scale it was worked out from, so that a measurement can say whether the papyrus
      // moved as far as the hand without having to guess at the piece's size.
      ((window as unknown as { __shown?: unknown[] }).__shown ??= []).push({
        at: performance.now(),
        perPixel: scale.wide / scale.reach,
        plane: wantedPlane.current,
        w: own,
        pin: pin.current,
        from: middle - across / 2,
        across,
      });
    }
    // What the card is showing, which is what the sheet line and the winding points are drawn against.
    shown.current = wanted.current;
  };

  // The picture where the hand has got to.
  const glide = () => {
    showOnGpu();
    markSheets();
  };

  glideRef.current = glide;

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
        /*
         * How big a voxel is, which the fit needs whether or not there is a prediction: every length
         * it uses is in µm or in sheets, so that it means the same thing on a 1.1 µm scan and on a
         * 9.4 µm one.  The prediction says it where there is one; otherwise the scan's own name does.
         */
        const micron = lasagna?.micron ?? (source === undefined ? null : sourceMicron(source));
        if (micron === null) {
          setStatus("no-prediction");
          return;
        }
        /*
         * And where the direction across the sheets comes from: the prediction where there is one,
         * worked out of the scan where there is not — which is most scans, so this is what lets a
         * card be opened on them at all.  `?normals=scan` asks for the scan even where there is a
         * prediction, which is how the two are held against each other.
         */
        const asked = new URLSearchParams(window.location.search).get("normals");
        engine.open(
          {
            id,
            scanSourceId: sourceId,
            micron,
            chains,
            lasagna,
            normals: lasagna === null || asked === "scan" ? "scan" : "prediction",
            charts: new URLSearchParams(window.location.search).get("charts") !== "no",
            march: new URLSearchParams(window.location.search).get("march") !== "cpu",
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
            // Where the sheet is goes straight to the slice cards, not through this one.
            if (event.type === "sheet") return;
            if (event.type === "field") {
              if (DEBUG) {
                const look = new Float32Array(event.data);
                const middle = ((event.layers >> 1) * event.nv * event.nu + ((event.nv >> 1) * event.nu) + (event.nu >> 1)) * 4;
                console.info(
                  `${id}: field ${event.nu}x${event.nv}x${event.layers}, baseW ${event.baseW}` +
                    ` · middle node at (z y x) ${look[middle].toFixed(0)} ${look[middle + 1].toFixed(0)} ${look[middle + 2].toFixed(0)}` +
                    ` a ${look[middle + 3]}`,
                );
              }
              const field = {
                nu: event.nu,
                nv: event.nv,
                layers: event.layers,
                per: event.per,
                K: event.K,
                data: new Float32Array(event.data),
                walk: new Float32Array(event.walk),
                lo: event.lo,
                hi: event.hi,
              };
              // Kept where a measurement can reach it: this is the march itself, and the one way to
              // know that running it elsewhere gave the same answer is to hold the two side by side.
              if (DEBUG) ((window as unknown as { __march?: unknown[] }).__march ??= []).push(field);
              lastField.current = field;
              gpuRef.current?.take(field);
              baseW.current = event.baseW;
              piece.current = {
                alongU: event.alongU,
                alongV: event.alongV,
                nu: event.nu,
                nv: event.nv,
                walk: {
                  sheets: Array.from(new Float32Array(event.sheets)),
                  walked: Array.from(new Float32Array(event.walked)),
                },
              };
              showOnGpu();
              setDrawn(true);
              return;
            }
            if (event.type === "want") {
              if (DEBUG) console.info(`${id}: want ${event.wanted.map((o) => `level ${o.level}: ${new Float32Array(o.chunks).length / 3} chunks`).join(", ")}`);
              // The sheets could not be followed as far as the wheel went, so the board is told where
              // the card really came to rest.
              if (event.limited) dispatch({ type: "setSurfaceLayer", id, w: event.w });
              /*
               * And where the cut is taken, if the piece moved along the papyrus to meet it
               * (`along` in the worker): the row the card was asking for is the middle of the new
               * piece, so it counts from there now.
               *
               * A hand may still be down while that happens.  A pull reads from where it took hold,
               * so that base is carried by the same amount — the papyrus goes on following the hand
               * across the join instead of snapping back to where the hand started.
               */
              if (Math.abs(event.pin - pin.current) > 1e-6) {
                if (pulling.current !== undefined) {
                  pulling.current.pin += event.pin - pin.current;
                  const scale = cutScale();
                  if (scale !== undefined) pulling.current.perPixel = scale.wide / scale.reach;
                }
                pin.current = event.pin;
                far.current = undefined;
                showOnGpu();
                markSheets();
              }
              const wanted = event.wanted.map((one) => ({
                level: one.level,
                factor: one.factor,
                chunks: new Float32Array(one.chunks),
              }));
              lastWant.current = wanted;
              gpuRef.current?.want(wanted);
              return;
            }
            if (event.type === "place") {
              // Answers about the winding points, which are asked for one at a time and told apart
              // by the token they carry.
              if (event.token !== undefined) {
                if (event.token === "put") {
                  if (event.voxel !== null) {
                    const [z, y, x] = event.voxel;
                    const made = onPlaceRef.current({ x, y, z });
                    /*
                     * The card asked where this press was and has the answer in its hand, so the new
                     * point is filed from it there and then.  Nothing is asked of the piece: it would
                     * be answering a different question — the nearest place of the piece to a voxel,
                     * which where a piece comes back round close to itself is a different wrap.
                     */
                    const point = made?.points[made.points.length - 1];
                    if (point !== undefined && event.spot !== null) {
                      dots.current.set(point.id, event.spot);
                      setSpots(id, dots.current);
                    }
                  }
                  setSpotted((count) => count + 1);
                } else {
                  if (event.spot === null) dots.current.delete(event.token);
                  else dots.current.set(event.token, event.spot);
                  setSpots(id, dots.current);
                  setSpotted((count) => count + 1);
                }
                return;
              }
              // Where the group's mark falls on this piece, which is what puts the cross on it.
              if (event.spot !== null) {
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
    wanted.current = w;
    wantedPlane.current = plane;
    // Somebody else said where to look, so the card's own place gives way to theirs.
    far.current = undefined;
    // The cut the card holds already covers this sheet, so it is shown before anybody is asked.
    glideRef.current();
    surfaceEngine().show(id, w, plane, pin.current);
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
  /*
   * A wheel on a cut, in the card's own pixels: it moves the cut along the papyrus, as a pull does,
   * and by the same amount for the same movement.
   */
  const sweep = (by: number) => {
    const scale = cutScale();
    if (scale === undefined) return;
    pin.current = Math.min(1, Math.max(0, pin.current + (by * scale.wide) / scale.reach));
    glide();
    surfaceEngine().show(id, wanted.current, wantedPlane.current, pin.current);
    waitFor();
  };

  const askFor = (next: number) => {
    wanted.current = next;
    far.current = undefined;
    // The picture goes there straight away, out of the cut the card holds; the sharp one follows.
    glide();
    surfaceEngine().show(id, next, wantedPlane.current, pin.current);
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
   * Alt and the wheel moves the card: through the sheets on the flat card, where a notch is an
   * eighth of one, and along the papyrus on a cut, where there is nothing through it to go to.
   * Without Alt the board takes the wheel, as it does over a slice card.
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
      /*
       * Counted in the card's own pixels, and turned into a place only at the end.
       *
       * A wheel on the flat card travels through the sheets, and on a cut it travels ALONG the
       * papyrus — a cut already shows the whole stack, so there is nothing through it to go to, and
       * the row of the grid it is taken at is the one thing it cannot show.  Both are the same
       * gesture of the same size; what they mean is the plane's.
       */
      // A notch, and the most one gesture may move: a sheet's worth on the flat card, and the card's
      // own worth on a cut.  A trackpad is left at one for one either way, which is what makes it
      // read as the same gesture as taking hold of the line.
      const tall = gpuBox.current?.clientHeight ?? 0;
      const cut = wantedPlane.current !== "uv";
      const notch = cut ? CUT_NOTCH * tall : NOTCH_PIXELS;
      const cap = cut ? CUT_GESTURE * tall : GESTURE_PIXELS;
      let by = pixels ? delta : Math.sign(delta) * notch;
      const left = cap - scroll.spent;
      if (left <= 0) return;
      by = Math.sign(by) * Math.min(Math.abs(by), left);
      scroll.spent += Math.abs(by);
      if (!cut) {
        askFor(Math.round((wanted.current + by * PER_PIXEL) * 1000) / 1000);
        return;
      }
      sweep(by);
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
    // Which wrap this card is on, which is what every distance through the papyrus is measured from.
    const sheet = shown.current ?? wanted.current;
    /*
     * The winding points, wherever they fall on this piece.  On a card of the sheet laid flat they
     * fade as the card turns away from the sheet they were put on — which is the plainest answer
     * there is to "are these really the same sheet": they are the ones that stay.
     */
    // Not while a hand is pulling: every one of these is a scan over every chain of the scan, and
    // the hand is watching the papyrus, not the dots.  They are put back when it lets go.
    if (shown.current !== undefined && pulling.current === undefined) {
      // The window the picture was drawn with, asked once rather than once a dot.
      const held = shownAcross();
      drawnDots.current = [];
      for (const one of chainsOf(scan)) {
        const colour = chainColour(one);
        const apart = one.kind === "step";
        const loud = one.id === lit || one.id === picked?.chain;
        // Where this chain's points landed on the card, so that a relative winding can be drawn as
        // the link it is: the places it holds apart, joined, and the join cut through the middle.
        const seen: { x: number; y: number }[] = [];
        for (const point of one.points) {
          const found = dots.current.get(point.id);
          if (found === undefined) continue;
          /*
           * Where that winding falls across the cut: out of the same window the picture was drawn
           * with, so a dot cannot come apart from the papyrus under it.  On the flat card there is
           * no across to speak of, and before the first cut arrives there is nothing drawn to pin a
           * dot to either.
           */
          if (held === undefined && wantedPlane.current !== "uv") continue;
          const sideways =
            held === undefined ? 0.5 : (farOf(held.walk, found.w - held.base) - held.from) / held.wide;
          const at =
            wantedPlane.current === "uv"
              ? [found.fu, found.fv]
              : wantedPlane.current === "uw"
                ? [found.fu, sideways]
                : [found.fv, sideways];
          if (at[0] < 0 || at[0] > 1 || at[1] < 0 || at[1] > 1) continue;
          /*
           * How far along the papyrus the place is from the cut itself, in voxels.
           *
           * A cut shows one row of the grid and nothing either side of it, so where a place sits
           * along the row it does NOT show is the one thing its two coordinates on the card cannot
           * say — and a place a hundred voxels along the papyrus drawn as though it were on the cut
           * is a place drawn somewhere it is not.  It was: the coordinate was dropped, and every
           * point of every chain on the piece was drawn on every cut of it.
           *
           * So it fades with that distance and goes beyond half a card's worth of it.  Half a
           * CARD's, because a cut draws a square of papyrus square: the same amount of papyrus the
           * other way would be half off the picture.
           */
          let off = 0;
          if (held !== undefined) {
            const hidden = wantedPlane.current === "uw" ? found.fv : found.fu;
            off = Math.abs(hidden - pin.current) * held.reach;
            if (off > held.wide / 2) continue;
          }
          /*
           * On a flat card the sheets are not drawn, so how far away one is has to be said by fading.
           * But never to nothing: a point on another wrap is still a point, and a person looking at
           * one wrap needs to see the annotations on the others — to press one and join it, to see
           * where the next wrap was said to be.  So they ghost instead of going, small and faint, and
           * "on this wrap" is said by the ones that are solid.  A relative winding ghosts less: its
           * points are on different wraps, which is the whole of what it says.
           */
          const away = Math.max(0, 1 - Math.abs(found.w - sheet) / 0.5);
          const near =
            wantedPlane.current !== "uv"
              ? Math.max(apart ? GHOST_APART : GHOST, held === undefined ? 1 : 1 - off / (held.wide / 2))
              : Math.max(apart ? GHOST_APART : GHOST, away);
          const here = away > 0;
          const x = at[0] * width, y = at[1] * height;
          drawnDots.current.push({ chain: one.id, point: point.id, x: x / density, y: y / density, near: away });
          seen.push({ x, y });
          context.save();
          if (!one.on) context.globalAlpha = 0.35;
          drawDot(
            context,
            x,
            y,
            density,
            near,
            point.turn,
            (picked?.chain === one.id && picked.point === point.id) ||
              (over?.chain === one.id && over.point === point.id),
            colour,
            apart,
            loud && here,
          );
          context.restore();
        }
        if (apart && seen.length > 1) {
          context.save();
          context.globalAlpha = one.on ? 0.85 : 0.35;
          context.strokeStyle = colour;
          context.lineWidth = 1.8 * density;
          context.beginPath();
          context.moveTo(seen[0].x, seen[0].y);
          for (const place of seen.slice(1)) context.lineTo(place.x, place.y);
          context.stroke();
          for (let k = 0; k + 1 < seen.length; k++) {
            const [a, b] = [seen[k], seen[k + 1]];
            const far = Math.hypot(b.x - a.x, b.y - a.y) || 1;
            const [ux, uy] = [(b.x - a.x) / far, (b.y - a.y) / far];
            const [mx, my] = [(a.x + b.x) / 2, (a.y + b.y) / 2];
            const arm = 2.6 * density;
            context.beginPath();
            context.moveTo(mx - uy * arm, my + ux * arm);
            context.lineTo(mx + uy * arm, my - ux * arm);
            context.lineWidth = 1.7 * density;
            context.stroke();
          }
          context.restore();
        }
      }
      setDrawnDots(id, drawnDots.current);
    }
    if (wantedPlane.current === "uv" || shown.current === undefined) return;
    /*
     * One line: where the card itself is in the stack, which is the middle of a cut.  Its neighbours
     * are only a ruler, and a ruler over the papyrus is in the way of reading it.
     *
     * Across the card, because the sheets stack downwards on both cuts (`mapping` in `render.ts`).
     */
    context.lineCap = "round";
    context.beginPath();
    context.moveTo(0, height / 2);
    context.lineTo(width, height / 2);
    context.strokeStyle = SHEET_LINE_EDGE;
    context.lineWidth = 3.4 * density;
    context.stroke();
    context.strokeStyle = SHEET_LINE;
    context.lineWidth = 1.4 * density;
    context.stroke();
  };

  useEffect(markSheets, [plane, card.width, card.height, drawn, spotted, lit, picked, over]);


  /*
   * And where each winding point of this scan is on this piece.  Asked again whenever the points
   * change or the piece is rebuilt, since only the worker knows where the piece is; the answers are
   * kept by point, so one that has gone is forgotten and one the piece cannot reach is dropped.
   *
   * While a winding tool is in hand, only the points there is no answer for yet — which is the one
   * just put down.  A press then costs a single lookup instead of a hundred and sixty, and the dot
   * appears on the cuts at once; the piece itself is left alone until the tool is put down (`said` in
   * `App.tsx`), so the rest of the answers are still good and there is nothing to ask again.
   *
   * With the arrow back, every point is asked about afresh: the piece has been rebuilt by then, and
   * an answer about the piece before it is an answer about a different piece.
   */
  const askAbout = useCallback((onlyNew: boolean) => {
    const engine = surfaceEngine();
    const living = new Set<string>();
    for (const one of chainsOf(scan))
      for (const point of one.points) {
        living.add(point.id);
        if (!onlyNew || !dots.current.has(point.id)) {
          engine.point(id, [point.at.z, point.at.y, point.at.x], point.id);
        }
      }
    for (const was of [...dots.current.keys()]) if (!living.has(was)) dots.current.delete(was);
    setSpotted((count) => count + 1);
  }, [id, scan]);
  // A new piece: every answer about the old one is about a different piece.
  useEffect(() => {
    if (status === "ready") askAbout(false);
  }, [status, askAbout]);
  // And the points as they are put down.
  useEffect(() => {
    if (status === "ready") askAbout(tool !== "look");
  }, [chainsMoved, tool, status, askAbout]);

  /*
   * The viewer's side of a card drawn on the GPU: one surface view, for as long as the card shows
   * this scan.  It joins the same context and the same shared canvas as every slice card, so the
   * two kinds of card cost one GPU context between them and read the same chunk textures.
   */
  useEffect(() => {
    if (session === null || sourceId === null || gpuBox.current === null) return;
    const volume = session.volumes.get(sourceId);
    /*
     * The renderer being built to replace the one below (`?gpu2=yes`): one atlas, a TSL function,
     * and — the part that matters here — a march that is not let go of until the one replacing it
     * can be drawn, which is what a card going blank for half a second was.
     */
    /*
     * Whether the card is still waiting, answered by the one thing that knows.
     *
     * It used to come from the worker, which drew the papyrus and so could say when it had drawn all
     * of it.  The papyrus is drawn on the GPU now, so what is left to wait for is chunks arriving —
     * which only the view can see, because the view is what asked for them.
     */
    const attach = (view: Flat) => {
      view.onSettled = (settled) => {
        if (!settled) return;
        clearTimeout(waiting.current);
        setLoading(false);
      };
      gpuRef.current = view;
    };
    if (!ON_GPU2) {
      const view = session.viewer.addSurfaceView(gpuBox.current, { volume });
      attach(view);
      return () => {
        gpuRef.current = undefined;
        view.dispose();
      };
    }
    // The WebGPU device is started once for the page and awaited by whichever card gets there first.
    let current = true;
    let view: Flat | undefined;
    // Both: the device has to be there, and the volume's scales have to be known.
    Promise.all([session.viewer.startGpu(), volume.loaded]).then(([could]) => {
      if (!current || !could || gpuBox.current === null) return;
      view = session.viewer.addFlatView(gpuBox.current, { volume });
      attach(view);
      // Whatever the worker said while the device was starting is said again now.
      if (lastField.current !== undefined) view.take(lastField.current);
      if (lastWant.current !== undefined) view.want(lastWant.current);
      showOnGpu();
    });
    return () => {
      current = false;
      gpuRef.current = undefined;
      view?.dispose();
    };
  }, [session, sourceId]);

  /*
   * Putting a winding point down on the papyrus, and pulling a sheet on a cut.  Both are a press on
   * the drawing, so they are listened for together and the tool decides which it is.
   *
   * A card of a sheet laid flat is the one place where saying "these are the same sheet" needs no
   * eye: the card is that sheet, so every press on it is on it.
   */
  useEffect(() => {
    const element = lines.current;
    if (element === null) return;
    // Both cuts stack their sheets downwards, so a pull is a pull up or down on either of them.
    /*
     * Where a press is on the card, in the card's OWN pixels.
     *
     * The board draws its cards at whatever it is zoomed to, so a press arrives in screen pixels and
     * the card is laid out in its own: on a board zoomed to half, one screen pixel is two of the
     * card's.  Everything below works in the card's, as the drawing does.
     */
    const spot = (event: PointerEvent) => {
      const box = element.getBoundingClientRect();
      const zoomed = box.width / element.clientWidth || 1;
      return {
        x: (event.clientX - box.left) / zoomed,
        y: (event.clientY - box.top) / zoomed,
        // And the same place as a fraction of the frame, which is what the piece is asked about.
        fx: (event.clientX - box.left) / box.width,
        fy: (event.clientY - box.top) / box.height,
        zoomed,
      };
    };
    // The winding point under the pointer, in the card's own pixels.
    const dotUnder = (x: number, y: number, within = GRAB + 3) => {
      let found;
      let nearest = within;
      for (const dot of drawnDots.current) {
        const away = Math.hypot(dot.x - x, dot.y - y);
        if (away < nearest) {
          nearest = away;
          found = { chain: dot.chain, point: dot.point };
        }
      }
      return found;
    };
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey) return;
      const here = spot(event);
      /*
       * A press on the line pulls the sheets, even where a winding point is sitting on it.
       *
       * The line marks the sheet the card is on, so the points on THAT sheet are drawn along it —
       * which on an annotated card is most of its length.  Taking the point every time left the line
       * impossible to grab: the pull simply never started, and the card read as frozen.  A press
       * the line reads as frozen.  So near the line the line wins, and the points on every other wrap
       * — which is nearly all of them — are picked as before.
       */
      const online =
        plane !== "uv" &&
        toolRef.current === "look" &&
        Math.abs(here.y - element.clientHeight / 2) <= LINE;
      const under = online ? undefined : dotUnder(here.x, here.y);
      if (toolRef.current !== "look") {
        event.stopPropagation();
        event.preventDefault();
        // A press on a point already down says that place is on what is being drawn too, and the two
        // chains are one winding; anywhere else puts another point down.  Taking hold of a point is
        // the arrow tool's press.
        if (under !== undefined) onJoinRef.current(under);
        else {
          onPickRef.current(undefined);
          // Asked loosely: the places most worth saying something about are the ones the fit itself
          // has given up on.
          surfaceEngine().where(id, here.fx, here.fy, "put", true);
        }
        return;
      }
      // The arrow takes hold of a point, and lets go of one when the press lands anywhere else.
      if (under !== undefined) {
        event.stopPropagation();
        event.preventDefault();
        onPickRef.current(under);
        return;
      }
      onPickRef.current(undefined);
      if (!online) return;
      event.stopPropagation();
      /*
       * The pull moves the cut ALONG the papyrus, and it moves it as far as the hand.
       *
       * One pixel of the card is worth so many voxels — the along-the-sheet axis covers the whole
       * piece across the card — and the axis being travelled is the same length, so a pull of the
       * card's height sweeps the card's height of papyrus.  The board's own zoom divides out, since
       * the hand moves in screen pixels and this is the card's.
       */
      const scale = cutScale();
      if (scale === undefined) return;
      pulling.current = {
        from: event.clientY,
        zoomed: here.zoomed,
        pin: pin.current,
        perPixel: scale.wide / scale.reach,
      };
      let waiting = false;
      // The worker is not in this loop.  The picture comes from the flattened papyrus on this thread;
      // the worker is only told now and then, so that it is drawing the right sheet by the time the
      // hand lets go.
      let told = 0;
      const move = (moved: PointerEvent) => {
        const hold = pulling.current;
        if (hold === undefined) return;
        moved.preventDefault();
        const now = moved.clientY;
        pin.current = Math.min(
          1,
          Math.max(0, hold.pin + ((now - hold.from) / hold.zoomed) * hold.perPixel),
        );
        if (waiting) return;
        waiting = true;
        requestAnimationFrame(() => {
          waiting = false;
          if (pulling.current === undefined) return;
          glideRef.current();
          if (performance.now() - told > TELL_MS) {
            told = performance.now();
            surfaceEngine().show(id, wanted.current, wantedPlane.current, pin.current);
          }
        });
      };
      const stop = () => {
        window.removeEventListener("pointermove", move, true);
        window.removeEventListener("pointerup", stop, true);
        window.removeEventListener("pointercancel", stop, true);
        pulling.current = undefined;
        glideRef.current();
        // And the sheet the hand came to rest on, which is the one worth drawing properly.
        surfaceEngine().show(id, wanted.current, wantedPlane.current, pin.current);
        dispatch({ type: "setSurfaceLayer", id, w: wanted.current });
      };
      window.addEventListener("pointermove", move, true);
      window.addEventListener("pointerup", stop, true);
      window.addEventListener("pointercancel", stop, true);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (pulling.current !== undefined) return;
      const here = spot(event);
      const online =
        plane !== "uv" &&
        toolRef.current === "look" &&
        Math.abs(here.y - element.clientHeight / 2) <= LINE;
      const under = online ? undefined : dotUnder(here.x, here.y);
      setOver((was) => (was?.chain === under?.chain && was?.point === under?.point ? was : under));
      if (under !== undefined) {
        element.style.cursor = "pointer";
        return;
      }
      if (toolRef.current !== "look") {
        element.style.cursor = "crosshair";
        return;
      }
      element.style.cursor = online ? "ns-resize" : "";
    };
    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("pointermove", onPointerMove);
    element.addEventListener("pointerleave", () => setOver(undefined));
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
         * slice card: the worker is asked which voxel this point of the card is, and the answer
         * goes to the board.
         */
        onDoubleClick={(event) => {
          const element = gpuBox.current;
          if (element === null) return;
          const box = element.getBoundingClientRect();
          const fx = (event.clientX - box.left) / box.width;
          const fy = (event.clientY - box.top) / box.height;
          if (fx < 0 || fx > 1 || fy < 0 || fy > 1) return;
          surfaceEngine().where(id, fx, fy);
        }}
      >
        <div className="card-gpu" ref={gpuBox} />
        <canvas className="card-lines card-sheets" ref={lines} />
        {message !== undefined && (
          <div className="card-overlay">
            <div className="card-message">{message}</div>
          </div>
        )}
        <div className="card-resize" title="Resize" />
      </div>

      <div className="card-bottom">
        {/*
          * Whole numbers are the papyrus, halves the gap between one wrap and the next.  It is worth
          * saying out loud: the wheel moves through them without stopping, so a card is as often
          * resting in a gap as on a wrap — and a card resting in a gap looks like a wrap full of
          * pits, which is a fault of where you are standing and not of the flattening.
          */}
        <span
          className={`card-layer${loading ? " loading" : ""}`}
          title="Wraps from the one this card was opened on; whole numbers are the papyrus, halves the gap between two wraps"
        >
          {formatLayer(w)}
        </span>
        {/*
          * Said but not yet taken in.  The piece is left alone while a winding tool is in hand, so
          * that a run of annotations is not interrupted by a rebuild after each one — and a card that
          * is quietly a few annotations out of date looks exactly like one that has ignored them.
          */}
        {behind && (
          <span className="card-waiting" title="The surface is left alone while you are annotating">
            Enter to take it in
          </span>
        )}
        <span className="card-centre">{formatVoxel(seed)}</span>
      </div>
    </div>
  );
}

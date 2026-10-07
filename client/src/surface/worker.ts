/**
 * @file The surface worker: for each surface card, reads the scan's Lasagna prediction around the
 * voxel the card was opened on (`field.ts`), builds the piece of sheet there (`patch.ts`), and draws
 * it from the scan (`render.ts`).
 *
 * The sheet is drawn coarse as soon as there is anything to draw and again as finer chunks arrive,
 * as a slice card does.  A piece holds `K` sheets either side of the one it was built on; moving past
 * them builds another piece around the sheet reached, so a card can go on through the scroll for as
 * long as the sheets can be followed, while `w` keeps counting from the sheet it was opened on.
 */

import { SERVER_API_ENDPOINT, SERVER_DATA_ENDPOINT } from "../config";
import type { ChartOf } from "./chart";
import { chartId, readChart, writeChart } from "./chart";
import { chunksFor, LasagnaField, normalLevel, ScanField, scanChunksFor } from "./field";
import type { Vec3 } from "./field";
import type { Patch, PatchGrid } from "./patch";
import { buildPatch, coverageAt, layerGrid, nearestOn, outward, patchFacts, positionAt, walkOut, walkReach, wrapGap } from "./patch";
import type { SurfacePlane } from "./render";
import { acrossSheets, acrossWalk, acrossWanted, pieceAt, planeChunks } from "./render";
import { ZarrLevel } from "./store";
import { fieldOf } from "./gpu/field";
import { marchOnGpu } from "./gpu/march";
import type { ChainSaid, OpenRequest, PieceSpot, SurfaceEvent, SurfaceRequest } from "./types";


// Sheets each side of the one the card sits on, and table layers per sheet.
/*
 * How many sheets either side of the one fitted the table holds.
 *
 * Five rather than three because of the cut cards: a cut is drawn at the same scale both ways
 * (`spanFor`), and on a card of the usual size that wants about five wraps either side.  Capped at
 * what is here, three left the picture half again too tall and smeared with it.  It costs: measured,
 * a piece took 723 ms to build at three and 998 ms at five, and the box of prediction read for it is
 * half as deep again.
 */
/*
 * How many whole sheets each side of its own a piece holds.
 *
 * This is not a quality setting, it is the room a hand has to move.  A cut card draws a square of
 * papyrus as a square, so how much of the stack it shows is decided by its own shape, not by this —
 * on a card of the usual size at 2.4 µm that is seven and a half wraps at once.  A piece of five
 * sheets each way therefore left about a wrap and a quarter of travel, which is fifty pixels of
 * dragging before the picture simply ran out, and the card read as jammed.  Fourteen leaves ten
 * wraps of travel each way, which no single gesture reaches.
 *
 * It costs a deeper march — two and a half times the samples — but only once: the march is kept
 * (`chart.ts`), so the price is paid the first time a piece is seen and never again.
 */
const K = 14;
const PER = 8;
// Sheets either side of the one fitted first, and how much room to leave for them in the box.
const REACH_SHEETS = K + 1;

const worker = self as unknown as {
  onmessage: ((message: MessageEvent<SurfaceRequest>) => void) | null;
  postMessage(message: SurfaceEvent, transfer?: Transferable[]): void;
};

const dataUrl = (sourceId: string) => `${SERVER_DATA_ENDPOINT}/api/data/${sourceId}`;

/*
 * Pieces by everything that decides one: the scan, the voxel, the way w grows, the zoom and the
 * grid.  Cards of a pair ask for the very same piece, and so does a copy of a card, and building it
 * again would be several seconds of reading and fitting for an answer already in hand — or being
 * worked out at that moment, which is why what is kept here is the work and not only its result.
 *
 * And one at a time.  Three cards building at once read three boxes of prediction into a store that
 * holds 128 MB, and the chunks of one card's box are dropped to make room for another's before it
 * has copied them out — which leaves cards saying there is no sheet where there plainly is one.
 */
type Piece = { patch: Patch; spacing: number; read: number; walked: number; fitted: number; kept: boolean };
const pieces = new Map<string, Promise<Piece | "too-coarse" | undefined>>();
const PIECES_KEPT = 6;
let building: Promise<unknown> = Promise.resolve();

// Lasagna's arrays and the scan's levels, opened once per source.
const opened = new Map<string, Promise<ZarrLevel>>();
const scans = new Map<string, Promise<ZarrLevel[]>>();

// The scan's levels, from its OME-Zarr attributes.
function scanLevels(sourceId: string) {
  let levels = scans.get(sourceId);
  if (levels === undefined) {
    levels = (async () => {
      const response = await fetch(`${dataUrl(sourceId)}/.zattrs`);
      if (!response.ok) throw new Error(`The scan has no .zattrs (${response.status})`);
      const datasets: { path: string; coordinateTransformations?: { scale?: number[] }[] }[] =
        (await response.json()).multiscales?.[0]?.datasets ?? [];
      if (datasets.length === 0) throw new Error("The scan lists no levels");
      const scaleOf = (i: number) => {
        const scale = datasets[i].coordinateTransformations?.find((t) => t.scale)?.scale;
        return scale?.[scale.length - 1];
      };
      return Promise.all(
        datasets.map((dataset, i) => {
          const one = scaleOf(i), first = scaleOf(0);
          const factor = one !== undefined && first ? Math.round(one / first) : 2 ** i;
          return ZarrLevel.open(`${dataUrl(sourceId)}/${dataset.path}`, factor);
        }),
      );
    })();
    levels.catch(() => scans.delete(sourceId));
    scans.set(sourceId, levels);
  }
  return levels;
}

/**
 * The level of the surface prediction to read a box of `micron` µm across: fine enough that a sheet's
 * face is more than a voxel thick (10 µm), coarse enough that the box is a couple of hundred voxels
 * across.  A card twice as wide covers four times the area, and at one fixed level that is four times
 * the downloading — which is what left a large card waiting for minutes.
 */
function channelLevel(sourceId: string, level: number) {
  const key = `${sourceId}@${level}`;
  let array = opened.get(key);
  if (array === undefined) {
    array = ZarrLevel.open(dataUrl(sourceId), 2 ** level);
    array.catch(() => opened.delete(key));
    opened.set(key, array);
  }
  return array;
}

// How far from its own sheet a piece is used before another is built around the sheet reached.
/*
 * How far the card may wander from the piece's own sheet before the next piece is started.
 *
 * Early enough that the next one is ready before the picture runs out: a cut shows about four wraps
 * either side of where it is, so this leaves a wrap or so of warning.
 */
const REBASE_AT = K - 5;
/*
 * How far from the piece a voxel may be and still be a place on it, in voxels.  A point inside the
 * slab of papyrus the piece covers comes back a fraction of a voxel away; one outside comes back as
 * far away as the edge it was measured to, which is the answer "not on this piece".
 */
const ON_PIECE = 3;
// The level drawn first while the one asked for arrives: this many levels coarser.
const PREVIEW_LEVELS = 2;
/*
 * How long a sheet has to be the one asked for before the card goes and fetches what it needs to
 * draw it sharply.  While a hand is still turning the wheel, the sharp frame is thrown away before
 * anyone sees it, and the chunks it asks for are most of what the turning costs: of the second and
 * a half a sixteen-notch turn took, a second was spent waiting for data nobody looked at.
 */
const RESTING_MS = 110;

/**
 * The grid of a patch covering `width` × `height` pixels at `zoom` voxels per pixel.  The points are
 * about eight voxels apart, which is what the sheet's own undulations need — a coarser grid cannot
 * follow them and the flattening suffers — but no more than 65 a side, which caps what building one
 * costs.
 */
// Voxels either side of the seed read before the rest, to find the normal and the sheet spacing.
const NEAR = 96;
/*
 * The least a sheet may be worth, in voxels, for there to be anything to flatten.
 *
 * A scan that cannot show the sheets cannot be flattened, however good the fit is: the 45.5 µm
 * overviews of Scroll 1 put a whole winding inside two voxels, so the grid a piece is laid out on —
 * six voxels to a cell — is three windings wide.  Said plainly rather than attempted, because what
 * attempting it looks like is a box of prediction the size of the scroll and a browser out of memory.
 */
const SPACING_LEAST = 6;
/*
 * And how much of the scan the normal may be worked out over at once, in voxels of the level it is
 * read at.  The structure tensor keeps six numbers a voxel, so this is about fifty megabytes; a card
 * asking for more is read at a coarser level instead, which is always available and is the thing to
 * give up first.
 */
const NORMAL_VOXELS = 2e6;

/**
 * How far apart the sheets are at `p`, in voxels: measured along the normal from the prediction, and
 * where that finds nothing, guessed from the density — which is only ever right to within a few
 * times, so it is a last resort.
 */
/*
 * What one sheet is worth in voxels while nobody has said.
 *
 * It is a guess and is meant to look like one.  The fit reads nothing but the normal, and a direction
 * cannot say how far across the sheets anything is; the prediction's own answer to that is out by half
 * (`field.ts`).  So the number that matters comes from a relative winding — "these two places are
 * different sheets" — and this stands in until there is one (`spacingSaid` in `patch.ts`).
 */
const SPACING_UM = 96;

function gridFor(width: number, height: number, zoom: number): PatchGrid {
  const spacing = Math.min(24, Math.max(6, zoom * 4));
  const count = (extent: number) => {
    const n = Math.min(65, Math.max(5, Math.ceil(extent / spacing) + 1));
    return n % 2 === 1 ? n : n + 1;
  };
  const across = count(width * zoom), down = count(height * zoom);
  return { nu: across, nv: down, hu: (width * zoom) / (across - 1), hv: (height * zoom) / (down - 1) };
}

class Card {
  private closed = false;
  private patch: Patch | undefined;
  private scan: ZarrLevel[] | undefined;
  private channels: { grad_mag: ZarrLevel; nx: ZarrLevel; ny: ZarrLevel } | undefined;
  // The sheet the piece was built on, counted from the one the card was opened on.
  private baseW = 0;
  private wanted: number;
  private plane: SurfacePlane;
  // Whether a run is in flight, so that asking for another sheet joins it rather than starting a second.
  private drawing = false;
  // The sheet whose line the page has, so that it is sent once rather than with every sheet shown.
  private sent: string | undefined;
  // How far through the papyrus each sheet of the piece is, walked once (`acrossWalk`).
  private walked: { patch: Patch; walk: { sheets: number[]; walked: number[] } } | undefined;
  // When a sheet was last asked for, which says whether the hand has come to rest.
  private askedAt = 0;
  /*
   * Whether a hand is still moving, which is the whole rule for what this card may do.
   *
   * Asked of the clock rather than said by the page, so that nothing has to remember to say it: a
   * sheet asked for less than a rest ago is one of a run, and a run means the sheet in hand is
   * already old.  While that is true the card sends the line and NOTHING else — no rebuilding, no
   * picture, no fetching — because every one of those is work for a sheet the hand has left, and the
   * line standing still under a moving hand is the one thing a drag must never do.
   */
  private get moving() {
    return performance.now() - this.askedAt < RESTING_MS;
  }
  // The piece whose march has already been handed to the card as a texture.
  private gave?: Patch;
  // Where along the axis a cut does not show it is taken (`mapping` in `render.ts`).
  private pin = 0.5;
  // How many voxels apart the sheets are here, as the piece was built with.
  private spacing = 40;

  constructor(private request: OpenRequest) {
    this.wanted = request.w;
    this.plane = request.plane;
    request.width = Math.max(1, Math.round(request.width));
    request.height = Math.max(1, Math.round(request.height));
  }

  /*
   * Where each equal step across one of this card's cuts falls, in sheets.
   *
   * Two things at once, and they are the same thing: how far across the sheets the cut reaches, which
   * is however much papyrus the other axis of the card is showing (`acrossWanted`), and how that is
   * spread, which is by distance rather than by winding (`acrossSheets`).  Asked for in every place
   * that maps between the frame and the piece, so that they cannot disagree.
   */
  private across(patch: Patch, plane: SurfacePlane, sheet: number) {
    // The flat card has no way across the sheets to spread.
    if (plane === "uv") return [sheet];
    // Walked once for the piece and kept: a lookup afterwards, however often it is asked.
    if (this.walked?.patch !== patch) this.walked = { patch, walk: acrossWalk(patch) };
    return acrossSheets(this.walked.walk, sheet, acrossWanted(patch, plane, this.request.width, this.request.height));
  }

  show(w: number, plane: SurfacePlane, pin = 0.5) {
    this.wanted = w;
    this.plane = plane;
    this.pin = pin;
    this.askedAt = performance.now();
    if (!this.drawing) this.run().catch((error) => this.fail(error));
  }

  /*
   * Where a voxel of the scan sits on this piece, so that a place pointed at on another card can be
   * shown here — and nothing, honestly, when the piece does not reach it or has a hole there.
   */
  point(at: [number, number, number], token?: string) {
    const { patch } = this;
    const found = patch === undefined ? undefined : nearestOn(patch, at);
    const on =
      patch !== undefined &&
      found !== undefined &&
      found.away <= ON_PIECE &&
      coverageAt(patch, found.w, found.gi, found.gj) >= 0.5;
    this.post({
      type: "place",
      id: this.request.id,
      token,
      spot: on
        ? { w: found!.w + this.baseW, fu: found!.gj / (patch!.nu - 1), fv: found!.gi / (patch!.nv - 1) }
        : null,
      voxel: null,
    });
  }

  // And the other way: the voxel under a point of the card, `fx` and `fy` across and down its frame.
  where(fx: number, fy: number, token?: string, loose = false) {
    const { patch } = this;
    const out = new Float64Array(3);
    let voxel: [number, number, number] | null = null;
    let on: PieceSpot | null = null;
    if (patch !== undefined) {
      const sheet = this.wanted - this.baseW;
      const spot = pieceAt(patch, this.plane, sheet, fx, fy, this.across(patch, this.plane, sheet));
      const there = positionAt(patch, spot.w, spot.gi, spot.gj, out);
      if (there && (loose || coverageAt(patch, spot.w, spot.gi, spot.gj) >= 0.5)) {
        voxel = [out[0], out[1], out[2]];
        /*
         * And where on the piece that was, which the card asked about and so already knows.  Finding
         * it again from the voxel is not the same question: the nearest place of the piece to a voxel
         * is not always the place the voxel came from, because a piece can come back round close to
         * itself — measured on a real one, a press on the flat card came back nearly two wraps away.
         * Asking the card is the one answer that cannot be wrong, since the card is the sheet.
         */
        on = {
          w: spot.w + this.baseW,
          fu: spot.gj / (patch.nu - 1),
          fv: spot.gi / (patch.nv - 1),
        };
      }
    }
    this.post({ type: "place", id: this.request.id, token, spot: on, voxel });
  }

  private fail(error: unknown) {
    console.error("Surface card failed:", error);
    this.post({ type: "status", id: this.request.id, status: "failed", message: String(error) });
  }

  close() {
    this.closed = true;
  }

  private post(event: SurfaceEvent, transfer?: Transferable[]) {
    if (!this.closed) worker.postMessage(event, transfer);
  }

  async start() {
    const { id, scanSourceId, lasagna, seed } = this.request;
    try {
      this.post({ type: "status", id, status: "loading" });
      const started = performance.now();
      const scan = scanLevels(scanSourceId);
      // The prediction's channels, where the fit is going to read them.  Nothing is downloaded for a
      // card working the direction out of the scan, which is every card on a scan that has none.
      this.channels =
        lasagna === null || this.request.normals === "scan"
          ? undefined
          : {
              grad_mag: await channelLevel(lasagna.channels.grad_mag.sourceId, lasagna.channels.grad_mag.level),
              nx: await channelLevel(lasagna.channels.nx.sourceId, lasagna.channels.nx.level),
              ny: await channelLevel(lasagna.channels.ny.sourceId, lasagna.channels.ny.level),
            };
      const at: Vec3 = [seed.z, seed.y, seed.x];
      // Before the piece is built, not after: the fit reads the scan itself where the prediction has
      // nothing to say, and a scan it does not have yet is a fit that never asks.
      this.scan = await scan;
      const built = await this.build(at, outward(lasagna?.umbilicus ?? null, at));
      if (this.closed) return;
      if (built === undefined || built === "too-coarse") {
        this.post({ type: "status", id, status: built ?? "no-sheet" });
        return;
      }
      this.patch = built.patch;
      this.spacing = built.spacing;
      if (this.closed) return;
      this.post({
        type: "status",
        id,
        status: "ready",
        facts: {
          spacing: built.spacing,
          across: built.patch.nu,
          down: built.patch.nv,
          step: Math.round(Math.max(built.patch.hu, built.patch.hv)),
          read: Math.round(built.read),
          walked: Math.round(built.walked),
          built: Math.round(built.fitted),
          kept: built.kept,
          ...patchFacts(built.patch),
        },
      });
      await this.run();
    } catch (error) {
      this.fail(error);
    }
  }

  /**
   * Reads the prediction around `seed` and builds the piece of sheet there, w growing along the
   * normal that agrees with `towards` — away from the scroll's axis, or the way the last piece went.
   */
  private async build(seed: Vec3, towards: Vec3 | undefined): Promise<Piece | "too-coarse" | undefined> {
    const { width, height, zoom, density } = this.request;
    // What the card covers does not change with how many pixels it is drawn with.
    const across = width / density, down = height / density;
    const grid = gridFor(across, down, zoom);
    const round = (value: number) => Math.round(value * 100) / 100;
    const key = [
      this.request.scanSourceId,
      seed.map(Math.round).join(","),
      (towards ?? [0, 1, 0]).map(round).join(","),
      zoom,
      `${grid.nu}x${grid.nv}`,
      `${round(grid.hu)},${round(grid.hv)}`,
      // What was said about the sheets here is part of what the piece is: two cards told the same
      // thing share one, and a piece built before a chain was drawn is not that piece any more.
      this.request.chains.map((chain) => `${chain.id}.${chain.rev}`).join(","),
    ].join("|");
    let shared = pieces.get(key);
    const fresh = shared === undefined;
    if (shared === undefined) {
      // Behind whatever is already reading, so that two boxes of prediction are never in the store
      // at once, and kept before it finishes so that the cards asking meanwhile wait for this one.
      shared = building.then(() => this.make(seed, towards, grid));
      building = shared.catch(() => undefined);
      pieces.set(key, shared);
      for (const old of pieces.keys()) {
        if (pieces.size <= PIECES_KEPT) break;
        pieces.delete(old);
      }
    }
    const made = await shared;
    // Somewhere with no sheet is not worth remembering: the reading is what costs, and a card
    // asking again later — at another zoom, after another card moved — should get a fresh answer.
    if (made === undefined || made === "too-coarse") {
      if (pieces.get(key) === shared) pieces.delete(key);
      return made;
    }
    // Only the card that started it did the work; the others were handed the answer.
    return fresh ? made : { ...made, read: 0, walked: 0, fitted: 0 };
  }

  // Reads what the piece needs and fits it; `build` is what says whether it has to be done at all.
  private async make(seed: Vec3, towards: Vec3 | undefined, grid: PatchGrid): Promise<Piece | "too-coarse" | undefined> {
    const { zoom, density, width, height } = this.request;
    const across = width / density, down = height / density;
    const micron = this.request.micron;
    const started = performance.now();
    const spacing = SPACING_UM / micron;
    if (spacing < SPACING_LEAST) return "too-coarse";

    /*
     * The march first, if this one has already been walked.
     *
     * Looked for before anything is read, because a chart that answers means nothing has to be read
     * at all: the normal field is what the march needs, and it is the only thing that needs it.  The
     * name is asked of the REQUESTED direction rather than the one the field gives back, so that the
     * question can be put before the field exists; the two agree, since the field is itself decided
     * by the scan, the resolution and the level, all of which are in the name.
     */
    const of: ChartOf = {
      source: this.request.scanSourceId,
      micron,
      normals: this.request.normals,
      seed,
      towards: towards ?? [0, 1, 0],
      zoom,
      nu: grid.nu,
      nv: grid.nv,
      hu: grid.hu,
      hv: grid.hv,
      reach: walkReach(K, PER),
      per: PER,
      spacing,
      steps: this.request.chains
        .filter((chain) => chain.kind === "step")
        .map((chain) => `${chain.id}.${chain.rev}`),
    };
    const name = await chartId(of);
    const kept = this.request.charts ? await readChart(name).catch(() => undefined) : undefined;
    if (kept !== undefined) {
      const read = performance.now() - started;
      const patch = buildPatch(kept, K, this.request.chains, micron);
      const gap = wrapGap(patch);
      return { patch, spacing: Number.isNaN(gap) ? spacing : gap, read, walked: 0, fitted: performance.now() - started - read, kept: true };
    }

    /*
     * Only the normal field is read: `nx`, `ny` for the direction and `grad_mag` for how much of a
     * winding a voxel of it is worth.  The phase and the surface mask are not downloaded at all —
     * measured on Scroll 1 neither says where a sheet is well enough to be worth the bytes, and the
     * fit no longer asks either of them (`patch.ts`).
     */
    const channels = this.channels;
    /*
     * Or the scan itself, which is where this is going: of the twenty-three scans in the app, five
     * have a Lasagna prediction and every one of them is a 2.4 µm scan, so a card cannot be opened on
     * any of the others at all.  `?normals=scan` works the direction out of the scan instead
     * (`ScanField`), which is the only way the same piece of papyrus can be read at 1.1 µm and at
     * 9.4 µm.  Here while the two are held against each other on a scan that has both.
     */
    const scan = this.scan!;
    let which = normalLevel(scan, micron);
    const load = async (lo: Vec3, hi: Vec3) => {
      if (channels === undefined) {
        await scan[which].loadAll(scanChunksFor(scan[which], lo, hi, micron));
        return new ScanField(scan[which], lo, hi, micron);
      }
      const all = [channels.grad_mag, channels.nx, channels.ny];
      await Promise.all(all.map((level) => level.loadAll(chunksFor(level, lo, hi))));
      return new LasagnaField(channels, lo, hi);
    };

    /*
     * A small box first, for the normal and the sheet spacing, which decide how much is needed.  The
     * prediction is read at its finest here: it is a small box, and the spacing measured on it sets
     * the scale of everything after.
     */
    const near = await load(seed.map((v) => v - NEAR) as Vec3, seed.map((v) => v + NEAR) as Vec3);
    const reference = towards ?? [0, 1, 0];
    if (!near.normal(seed[0], seed[1], seed[2], reference[0], reference[1], reference[2])) {
      return undefined;
    }
    const n: Vec3 = [near.out[0], near.out[1], near.out[2]];

    // The whole box: the card on the tangent plane, and the depth the streamlines may reach along
    // the normal, with room for the sheet to curve.
    const depth = (REACH_SHEETS + 0.5) * spacing;
    const tangent = Math.hypot(across, down) * zoom * 0.6;
    const half = n.map((c) => Math.abs(c) * depth + Math.sqrt(Math.max(0, 1 - c * c)) * tangent + 0.15 * depth + 48);
    // A coarser level for the normal where the box is too big to hold at this one.
    const fits = (f: number) => half.reduce((all, v) => all * ((2 * v) / f + 4), 1) <= NORMAL_VOXELS;
    while (which + 1 < scan.length && !fits(scan[which].factor)) which++;
    const field = await load(seed.map((v, i) => v - half[i]) as Vec3, seed.map((v, i) => v + half[i]) as Vec3);
    const read = performance.now() - started;
    /*
     * Marched on the GPU where there is one and the prediction is what is being read: the box is
     * already in hand as bytes, and the march is two and a half million node-steps that each read it
     * twice.  Working the normals out of the scan itself (`ScanField`) has no box to hand over, so it
     * marches here, as it always has.
     */
    const box =
      this.request.march && field instanceof LasagnaField
        ? { data: field.packed, dims: field.dims, origin: field.origin, factor: field.factor }
        : undefined;
    const walked = await walkOut(
      field,
      seed,
      n,
      grid,
      K,
      PER,
      spacing,
      this.request.chains,
      box === undefined
        ? undefined
        : (X, n0, reach, per, apart) => marchOnGpu(box, X, n0, grid, reach, per, apart),
    );
    if (walked === undefined) return undefined;
    const marched = performance.now() - started - read;
    const patch = buildPatch(walked, K, this.request.chains, micron);
    const fitted = performance.now() - started - read - marched;
    // Kept for the next time this is asked for, which is every reload, every winding taken in, and
    // every pull that reaches this far out again.  Nothing waits for it.
    writeChart(name, walked, of, seed).catch((error) => console.warn("Could not keep the march:", error));
    // The card is told how far apart the wraps CAME OUT, not how far apart the prediction said they
    // would be: it is what sets the card's scale, and what a point on a slice is faded by.
    const gap = wrapGap(patch);
    return { patch, spacing: Number.isNaN(gap) ? spacing : gap, read, walked: marched, fitted, kept: false };
  }

  /**
   * Hands the march to the card as something a GPU can read, once per piece.
   *
   * Ten megabytes, and the only part of drawing that still crosses out of this worker.  After it the
   * card can draw any sheet of this piece without asking: `positionAt` becomes a texture read, and
   * moving the window becomes a uniform.
   */
  private giveField(patch: Patch) {
    if (this.gave === patch) return;
    if (this.walked?.patch !== patch) this.walked = { patch, walk: acrossWalk(patch) };
    this.gave = patch;
    const field = fieldOf(patch, this.walked.walk);
    const sheets = Float32Array.from(this.walked.walk.sheets);
    const walked = Float32Array.from(this.walked.walk.walked);
    this.post(
      {
        type: "field",
        id: this.request.id,
        nu: field.nu,
        nv: field.nv,
        layers: field.layers,
        per: field.per,
        K: field.K,
        baseW: this.baseW,
        data: field.data.buffer as ArrayBuffer,
        walk: field.walk.buffer as ArrayBuffer,
        lo: field.lo,
        hi: field.hi,
        alongU: (patch.nu - 1) * patch.hu,
        alongV: (patch.nv - 1) * patch.hv,
        sheets: sheets.buffer,
        walked: walked.buffer,
      },
      [
        field.data.buffer as ArrayBuffer,
        field.walk.buffer as ArrayBuffer,
        sheets.buffer,
        walked.buffer,
      ],
    );
  }

  /**
   * Which chunks of the scan the sheet lands in, which is the one question the viewer cannot answer
   * for a flattening: its geometry is the march, and the march is here.
   *
   * The same `planeChunks` the CPU path has always used to decide what to fetch — it already handles
   * all three planes, which is why the cut had no need of a lattice of its own.
   */
  private async giveWanted(
    patch: Patch,
    plane: SurfacePlane,
    sheet: number,
    spread: number[],
    // The sheet actually reached, and whether that is short of the one asked for — the papyrus can
    // run out, or the prediction can.  It rides here because this is the one thing still sent once
    // per sheet shown, and a card that is not told goes on showing a sheet it never got to.
    reached: number,
    limited: boolean,
  ) {
    const scan = this.scan;
    if (scan === undefined) return;
    const { width, height, zoom } = this.request;
    const fine = Math.max(0, Math.min(scan.length - 1, Math.floor(Math.log2(zoom) + 1e-6)));
    const preview = Math.min(scan.length - 1, fine + PREVIEW_LEVELS);
    const wanted: { level: number; factor: number; chunks: ArrayBuffer }[] = [];
    /*
     * Finest first.  The card draws them in this order and the depth buffer stands in for a stencil:
     * the first fragment at a pixel wins, so the finest scale that has arrived is the one seen and a
     * coarser one only fills in where it has not.  The other way round the coarse scale wins
     * everywhere and the fine one is never seen at all.
     */
    for (const level of preview === fine ? [fine] : [fine, preview]) {
      const chunks = planeChunks(patch, plane, sheet, width, height, scan[level], spread, this.pin);
      const flat = new Float32Array(chunks.length * 3);
      /*
       * Turned round on the way out.  Everything on this side counts (z, y, x) — the order the zarr
       * array is stored in and the order the march is written in — and the viewer counts (x, y, z),
       * because its data source reverses the axes when it places a volume in the world.  A chunk
       * asked for the wrong way round is not refused: it is a chunk of empty space somewhere else
       * entirely, which arrives, uploads, and draws as nothing at all.
       */
      chunks.forEach(([cz, cy, cx], at) => flat.set([cx, cy, cz], at * 3));
      wanted.push({ level, factor: scan[level].factor, chunks: flat.buffer as ArrayBuffer });
    }
    this.post(
      { type: "want", id: this.request.id, w: reached, limited, wanted },
      wanted.map((one) => one.chunks),
    );
  }

  /**
   * The sheet this piece can show of the one asked for, building further out first where it has to.
   *
   * What a build costs, measured: a march read back from the server is 120 to 200 ms and the table
   * on top of it another 200 to 470; a piece nobody has walked before is 170 to 260 ms of marching on
   * the GPU, or 840 to 1190 on this thread where there is no GPU to run it on (`gpu/march.ts`).  The
   * table is work on THIS thread whichever way the march went, so while it happens nothing else here
   * runs — no line is sent, and no chunks are asked for.
   */
  private async reach(w: number) {
    let left = 4;
    /*
     * Under a moving hand too, on a cut.
     *
     * It used not to be: a rebuild was the better part of a second on this thread, and this thread
     * sends the line.  But a cut card now draws from a picture it holds, so a hand is not waiting on
     * this thread at all — and refusing to rebuild while the hand moves is exactly what let the card
     * run out of piece in the middle of a pull with no way to continue.  The flat card still waits,
     * because there the drawing IS on this thread.
     */
    while (
      (!this.moving || this.plane !== "uv") &&
      this.patch !== undefined &&
      left-- > 0 &&
      Math.abs(w - this.baseW) > REBASE_AT
    ) {
      const patch: Patch = this.patch;
      const step = Math.max(-K, Math.min(K, Math.round(w - this.baseW)));
      // The centre of that sheet, or of the nearest one back towards this piece's own.
      let found: { k: number; at: Vec3 } | undefined;
      for (let k = step; k !== 0 && found === undefined; k -= Math.sign(k)) {
        const grid = layerGrid(patch, k);
        const centre = (((patch.nv - 1) / 2) * patch.nu + (patch.nu - 1) / 2) * 3;
        if (!Number.isNaN(grid[centre])) found = { k, at: [grid[centre], grid[centre + 1], grid[centre + 2]] };
      }
      if (found === undefined) break;
      /*
       * Signed like the piece it continues, so that w keeps growing the same way — and solved afresh
       * from the tangent plane at that wrap's centre, NOT started from the wrap itself.
       *
       * Starting from the wrap is the obvious thing and it was wrong.  That wrap is already in the
       * table, so it costs nothing and the piece does not shift the moment it is rebuilt — but its
       * grid is not a grid any more.  Streamlines of a normal field converge where the sheet is
       * concave, and `hold` pulls each node a little towards its neighbours twelve times a wrap, so
       * the nodes come out of a walk closer together than they went in; carry that into the next
       * piece and the next and it compounds.  Measured, dragging the line out to the eighteenth wrap
       * left the closest pair of neighbouring nodes 0.7 voxels apart where the grid was laid out at
       * 6 — that patch of the sheet drawn eight times over, which is the smear a long drag ended in.
       * Solved afresh each time there is nothing to carry: at the eighteenth wrap the nodes come out
       * 5.8 to 5.9 apart and the sheet leans 1° off its own normal, against 10° and falling apart.
       * It is also no slower — a build from the plane took 870 ms against 1900 from a crumpled grid.
       */
      const next = await this.build(found.at, patch.normal);
      if (this.closed || next === undefined || next === "too-coarse") break;
      this.patch = next.patch;
      this.spacing = next.spacing;
      this.baseW += found.k;
      if (found.k !== step) break;
    }
    return Math.max(this.baseW - K, Math.min(this.baseW + K, w));
  }

  /**
   * Draws the sheet asked for with whatever chunks have arrived, then loads the ones it is missing —
   * the coarse level first, so that there is something to look at — and draws it again as they come
   * in, until the sheet asked for stops changing.  Another sheet asked for stops the waiting at once;
   * what was being fetched still arrives, into the cache.
   */
  private async run() {
    if (this.patch === undefined || this.scan === undefined) return;
    this.drawing = true;
    try {
      let drawn: string | undefined;
      while (!this.closed && drawn !== `${this.wanted} ${this.plane}`) {
        const w = this.wanted, plane = this.plane;
        const asked = `${w} ${plane}`;
        const reached = await this.reach(w);
        if (this.closed) return;
        const patch = this.patch!;
        const { id } = this.request;
        const sheet = reached - this.baseW;
        // Where each equal step across a cut falls, which the chunks are worked out from: once per
        // sheet shown, not once per anything else.
        const spread = this.across(patch, plane, sheet);

        // The sheet itself, for the slice cards to draw the line where it cuts them.
        const line = `${this.baseW} ${sheet}`;
        if (this.sent !== line) {
          this.sent = line;
          const grid = layerGrid(patch, sheet);
          this.post(
            {
              type: "sheet",
              id,
              w: reached,
              nu: patch.nu,
              nv: patch.nv,
              grid: grid.buffer,
              normal: patch.normal,
              spacing: this.spacing,
            },
            [grid.buffer],
          );
        }
        if (this.wanted !== w || this.plane !== plane) continue;
        /*
         * And that is all this thread owes the card.
         *
         * The card holds the march as a texture and works out every pixel of the papyrus itself, so
         * what is left here is the two things only this side knows: the march, and which chunks of
         * the scan the sheet lands in.  Neither is a picture, and neither is per-frame.
         */
        drawn = asked;
        this.giveField(patch);
        await this.giveWanted(patch, plane, sheet, spread, reached, reached !== w);
      }
    } finally {
      this.drawing = false;
    }
  }
}

const cards = new Map<string, Card>();

worker.onmessage = ({ data: request }) => {
  switch (request.type) {
    case "open": {
      cards.get(request.id)?.close();
      const card = new Card(request);
      cards.set(request.id, card);
      void card.start();
      break;
    }
    case "show":
      cards.get(request.id)?.show(request.w, request.plane, request.pin);
      break;
    case "point":
      cards.get(request.id)?.point(request.at, request.token);
      break;
    case "where":
      cards.get(request.id)?.where(request.fx, request.fy, request.token, request.loose);
      break;
    case "close":
      cards.get(request.id)?.close();
      cards.delete(request.id);
      break;
  }
};

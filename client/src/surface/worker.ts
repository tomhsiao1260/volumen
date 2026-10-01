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
import { chunksFor, LasagnaField } from "./field";
import type { Vec3 } from "./field";
import type { Patch, PatchGrid } from "./patch";
import { buildPatch, coverageAt, layerGrid, nearestOn, outward, patchFacts, positionAt, wrapGap } from "./patch";
import type { SurfacePlane } from "./render";
import { drawPlane, LevelReader, pieceAt, planeChunks } from "./render";
import { ZarrLevel } from "./store";
import type { ChainSaid, FrameEvent, OpenRequest, SurfaceEvent, SurfaceRequest } from "./types";
import { SPAN } from "./types";

// Sheets each side of the one the card sits on, and table layers per sheet.
const K = 3;
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
type Piece = { patch: Patch; spacing: number; read: number; fitted: number };
const pieces = new Map<string, Promise<Piece | undefined>>();
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
const REBASE_AT = K - 0.75;
/*
 * How far from the piece a voxel may be and still be a place on it, in voxels.  A point inside the
 * slab of papyrus the piece covers comes back a fraction of a voxel away; one outside comes back as
 * far away as the edge it was measured to, which is the answer "not on this piece".
 */
const ON_PIECE = 3;
// The level drawn first while the one asked for arrives: this many levels coarser.
const PREVIEW_LEVELS = 2;
// While chunks arrive, the sheet is drawn again at most this often.
const REDRAW_MS = 120;
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
const SPACING = 40;

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
  private drawing = false;
  // Resolves the wait of the drawing in progress when another sheet is asked for.
  private changed: (() => void) | undefined;
  private stale = false;
  // The sheet whose line the page has, so that it is sent once rather than with every frame.
  private sent: string | undefined;
  // When a sheet was last asked for, which says whether the hand has come to rest.
  private askedAt = 0;
  // How many voxels apart the sheets are here, as the piece was built with.
  private spacing = 40;

  constructor(private request: OpenRequest) {
    this.wanted = request.w;
    this.plane = request.plane;
    request.width = Math.max(1, Math.round(request.width));
    request.height = Math.max(1, Math.round(request.height));
  }

  show(w: number, plane: SurfacePlane) {
    this.wanted = w;
    this.plane = plane;
    this.askedAt = performance.now();
    this.changed?.();
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
    if (patch !== undefined) {
      const spot = pieceAt(patch, this.plane, this.wanted - this.baseW, fx, fy);
      const there = positionAt(patch, spot.w, spot.gi, spot.gj, out);
      if (there && (loose || coverageAt(patch, spot.w, spot.gi, spot.gj) >= 0.5)) {
        voxel = [out[0], out[1], out[2]];
      }
    }
    this.post({ type: "place", id: this.request.id, token, spot: null, voxel });
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
      this.channels = {
        grad_mag: await channelLevel(lasagna.channels.grad_mag.sourceId, lasagna.channels.grad_mag.level),
        nx: await channelLevel(lasagna.channels.nx.sourceId, lasagna.channels.nx.level),
        ny: await channelLevel(lasagna.channels.ny.sourceId, lasagna.channels.ny.level),
      };
      const at: Vec3 = [seed.z, seed.y, seed.x];
      // Before the piece is built, not after: the fit reads the scan itself where the prediction has
      // nothing to say, and a scan it does not have yet is a fit that never asks.
      this.scan = await scan;
      const built = await this.build(at, outward(lasagna.umbilicus, at));
      if (this.closed) return;
      if (built === undefined) {
        this.post({ type: "status", id, status: "no-sheet" });
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
          built: Math.round(built.fitted),
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
  private async build(seed: Vec3, towards: Vec3 | undefined) {
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
    if (made === undefined) {
      if (pieces.get(key) === shared) pieces.delete(key);
      return undefined;
    }
    // Only the card that started it did the work; the others were handed the answer.
    return fresh ? made : { ...made, read: 0, fitted: 0 };
  }

  // Reads what the piece needs and fits it; `build` is what says whether it has to be done at all.
  private async make(seed: Vec3, towards: Vec3 | undefined, grid: PatchGrid): Promise<Piece | undefined> {
    const { zoom, density, width, height } = this.request;
    const across = width / density, down = height / density;
    const channels = this.channels!;
    const lasagna = this.request.lasagna;
    const started = performance.now();
    /*
     * Only the normal field is read: `nx`, `ny` for the direction and `grad_mag` for how much of a
     * winding a voxel of it is worth.  The phase and the surface mask are not downloaded at all —
     * measured on Scroll 1 neither says where a sheet is well enough to be worth the bytes, and the
     * fit no longer asks either of them (`patch.ts`).
     */
    const all = [channels.grad_mag, channels.nx, channels.ny];
    const load = async (lo: Vec3, hi: Vec3) => {
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
    const spacing = SPACING;

    // The whole box: the card on the tangent plane, and the depth the streamlines may reach along
    // the normal, with room for the sheet to curve.
    const depth = (REACH_SHEETS + 0.5) * spacing;
    const tangent = Math.hypot(across, down) * zoom * 0.6;
    const half = n.map((c) => Math.abs(c) * depth + Math.sqrt(Math.max(0, 1 - c * c)) * tangent + 0.15 * depth + 48);
    const field = await load(seed.map((v, i) => v - half[i]) as Vec3, seed.map((v, i) => v + half[i]) as Vec3);
    const read = performance.now() - started;
    const patch = buildPatch(field, seed, n, grid, K, PER, spacing, this.request.chains);
    const fitted = performance.now() - started - read;
    if (patch === undefined) return undefined;
    // The card is told how far apart the wraps CAME OUT, not how far apart the prediction said they
    // would be: it is what sets the card's scale, and what a point on a slice is faded by.
    const gap = wrapGap(patch);
    return { patch, spacing: Number.isNaN(gap) ? spacing : gap, read, fitted };
  }

  /**
   * The sheet this piece can show of the one asked for, building further out first where it has to.
   *
   * Building is synchronous work on this thread, so while it happens nothing else here runs — no line
   * is sent and no frame is drawn.  Measured, a build is 650 to 870 ms, which is why nothing should
   * ask for a sheet many wraps away once per frame.
   */
  private async reach(w: number) {
    let left = 4;
    while (this.patch !== undefined && left-- > 0 && Math.abs(w - this.baseW) > REBASE_AT) {
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
      if (this.closed || next === undefined) break;
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
      // The sheet the quick look is already showing, so that the sharp frame does not draw it twice.
      let sketched: string | undefined;
      while (!this.closed && (this.stale || drawn !== `${this.wanted} ${this.plane}`)) {
        this.stale = false;
        const w = this.wanted, plane = this.plane;
        const asked = `${w} ${plane}`;
        const changed = new Promise<void>((resolve) => (this.changed = resolve));
        const reached = await this.reach(w);
        if (this.closed) return;
        const patch = this.patch!, scan = this.scan!;
        const { id, width, height, zoom, density } = this.request;
        // The level whose voxels are about the size of a pixel of the card's layout, and a coarser
        // one to start with.  The card is drawn with more pixels than that on a dense screen, which
        // keeps it sharp without asking for four times the data.
        const fine = Math.max(0, Math.min(scan.length - 1, Math.floor(Math.log2(zoom) + 1e-6)));
        const preview = Math.min(scan.length - 1, fine + PREVIEW_LEVELS);
        const sheet = reached - this.baseW;

        /*
         * Nothing at all is not worth sending: the card goes on saying that it is loading.  The
         * quick look is drawn from a coarser level as well as from fewer pixels — most of what a
         * frame costs is reaching into the scan, and a sheet cuts through it at an angle, so every
         * pixel of a fine level is its own trip to memory.  A coarse level is small enough to stay
         * near the processor, and while the wheel is turning nobody is reading the papyrus.
         */
        const send = (scale = 1, at = fine, settled = false) => {
          const across = Math.max(1, Math.ceil(width / scale));
          const down = Math.max(1, Math.ceil(height / scale));
          const pixels = new Uint8ClampedArray(across * down * 4);
          const began = performance.now();
          const { coarser, drawn: painted } = drawPlane(patch, plane, sheet, SPAN, across, down, scan, at, pixels);
          const drew = performance.now() - began;
          // Nothing drawn is not worth sending — unless it is the last word, and the last word has
          // to be said even when it is that there is no sheet here at all.
          if (painted === 0 && !settled) return coarser;
          const frame: FrameEvent = {
            type: "frame",
            id,
            w: reached,
            plane,
            limited: reached !== w,
            width,
            height,
            scale,
            pixels: pixels.buffer,
            // `settled` is the last word on a sheet: what could not be fetched never will be, and a
            // card that says it is still loading for ever is worse than one that shows what it has.
            loading: !settled && (coarser > 0 || scale > 1 || at !== fine),
            drew,
          };
          this.post(frame, [frame.pixels]);
          return coarser;
        };

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
        if (sketched !== asked) {
          send(2, preview);
          sketched = asked;
        }
        if (this.wanted !== w || this.plane !== plane) continue;
        // Still moving: leave the sharp frame, and the fetching it leads to, until the hand rests.
        const resting = RESTING_MS - (performance.now() - this.askedAt);
        if (resting > 0) {
          await Promise.race([new Promise((resolve) => setTimeout(resolve, resting)), changed]);
          continue;
        }
        drawn = asked;
        if (send() > 0) {
          for (const level of preview === fine ? [fine] : [preview, fine]) {
            const chunks = planeChunks(patch, plane, sheet, SPAN, width, height, scan[level]);
            let arrived = false, last = performance.now();
            const loads = chunks.map((chunk) =>
              // A chunk that fails to arrive is drawn from a coarser level.
              scan[level].load(...chunk).catch(() => {}).then(() => {
                arrived = true;
                if (this.wanted === w && this.plane === plane && performance.now() - last > REDRAW_MS) {
                  last = performance.now();
                  arrived = false;
                  send();
                }
              }),
            );
            await Promise.race([Promise.all(loads), changed]);
            if (this.closed || this.wanted !== w || this.plane !== plane) break;
            if (arrived) send();
          }
        }
        // Everything this sheet can have has been fetched, so this frame is the last word on it.
        if (!this.closed && this.wanted === w && this.plane === plane) send(1, fine, true);
        if (this.closed || this.wanted !== w || this.plane !== plane) continue;
        // The sheets half a step either side, which the wheel most likely asks for next; the
        // cross-sections already cover them.
        if (plane === "uv") {
          for (const next of [sheet + 0.5, sheet - 0.5]) {
            if (Math.abs(next) > K) continue;
            for (const chunk of planeChunks(patch, plane, next, SPAN, width, height, scan[fine])) {
              scan[fine].load(...chunk).catch(() => {});
            }
          }
        }
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
      cards.get(request.id)?.show(request.w, request.plane);
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

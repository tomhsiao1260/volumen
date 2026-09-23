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

import { SERVER_API_ENDPOINT } from "../config";
import { chunksFor, LasagnaField, readMask } from "./field";
import type { Vec3 } from "./field";
import type { Patch, PatchGrid } from "./patch";
import { buildPatch, layerGrid, outward, patchFacts } from "./patch";
import type { SurfacePlane } from "./render";
import { drawPlane, planeChunks } from "./render";
import { ZarrLevel } from "./store";
import type { FrameEvent, OpenRequest, SurfaceEvent, SurfaceRequest } from "./types";

// Sheets each side of the one the card sits on, and table layers per sheet.
const K = 3;
const PER = 8;
// Sheets either side of the one fitted first, and how much room to leave for them in the box.
const REACH_SHEETS = K + 1;

const worker = self as unknown as {
  onmessage: ((message: MessageEvent<SurfaceRequest>) => void) | null;
  postMessage(message: SurfaceEvent, transfer?: Transferable[]): void;
};

const dataUrl = (sourceId: string) => `${SERVER_API_ENDPOINT}/api/data/${sourceId}`;

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
function maskLevel(mask: { sourceId: string; base: number; micron: number }, micron: number) {
  const wanted = Math.max(10, Math.min(20, micron / 220));
  const level = Math.max(0, Math.min(5, Math.round(Math.log2(wanted / mask.micron))));
  return channelLevel(`${mask.sourceId}/${level}`, mask.base + level);
}

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
// Sheets either side of the one the card is on that the cross-sections show.
const SPAN = 2;
// The level drawn first while the one asked for arrives: this many levels coarser.
const PREVIEW_LEVELS = 2;
// While chunks arrive, the sheet is drawn again at most this often.
const REDRAW_MS = 120;

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
function sheetSpacing(field: LasagnaField, p: Vec3, n: Vec3) {
  const guess = Math.min(150, Math.max(15, 1 / (field.density(p[0], p[1], p[2]) || 1 / 60)));
  const measured = field.spacingAt(p[0], p[1], p[2], n[0], n[1], n[2], NEAR);
  return Number.isNaN(measured) ? guess : Math.min(300, Math.max(15, measured));
}

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
  private channels: { cos: ZarrLevel; grad_mag: ZarrLevel; nx: ZarrLevel; ny: ZarrLevel } | undefined;
  // The sheet the piece was built on, counted from the one the card was opened on.
  private baseW = 0;
  private wanted: number;
  private plane: SurfacePlane;
  private drawing = false;
  // Resolves the wait of the drawing in progress when another sheet is asked for.
  private changed: (() => void) | undefined;

  constructor(private request: OpenRequest) {
    this.wanted = request.w;
    this.plane = request.plane;
    request.width = Math.max(1, Math.round(request.width));
    request.height = Math.max(1, Math.round(request.height));
  }

  show(w: number, plane: SurfacePlane) {
    this.wanted = w;
    this.plane = plane;
    this.changed?.();
    if (!this.drawing) this.run().catch((error) => this.fail(error));
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
        cos: await channelLevel(lasagna.channels.cos.sourceId, lasagna.channels.cos.level),
        grad_mag: await channelLevel(lasagna.channels.grad_mag.sourceId, lasagna.channels.grad_mag.level),
        nx: await channelLevel(lasagna.channels.nx.sourceId, lasagna.channels.nx.level),
        ny: await channelLevel(lasagna.channels.ny.sourceId, lasagna.channels.ny.level),
      };
      const at: Vec3 = [seed.z, seed.y, seed.x];
      const built = await this.build(at, outward(lasagna.umbilicus, at));
      if (this.closed) return;
      if (built === undefined) {
        this.post({ type: "status", id, status: "no-sheet" });
        return;
      }
      this.patch = built.patch;
      this.scan = await scan;
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
          built: Math.round(performance.now() - started - built.read),
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
    const channels = this.channels!;
    const lasagna = this.request.lasagna;
    const started = performance.now();
    // Without a surface prediction the phase has to say where the sheets are; with one it is never
    // read, and reading it would be most of the card's downloading for nothing.
    const withPhase = lasagna.mask === null;
    const all = [channels.grad_mag, channels.nx, channels.ny, ...(withPhase ? [channels.cos] : [])];
    const load = async (lo: Vec3, hi: Vec3, mask?: ZarrLevel) => {
      const [box] = await Promise.all([
        mask === undefined ? undefined : readMask(mask, lo, hi),
        ...all.map((level) => level.loadAll(chunksFor(level, lo, hi))),
      ]);
      return new LasagnaField(withPhase ? channels : { ...channels, cos: undefined }, lo, hi, box);
    };

    /*
     * A small box first, for the normal and the sheet spacing, which decide how much is needed.  The
     * prediction is read at its finest here: it is a small box, and the spacing measured on it sets
     * the scale of everything after.
     */
    const near = await load(
      seed.map((v) => v - NEAR) as Vec3,
      seed.map((v) => v + NEAR) as Vec3,
      lasagna.mask === null ? undefined : await maskLevel(lasagna.mask, 2 * NEAR * lasagna.micron),
    );
    if (this.closed) return undefined;
    const reference = towards ?? [0, 1, 0];
    if (!near.normal(seed[0], seed[1], seed[2], reference[0], reference[1], reference[2])) {
      return undefined;
    }
    const n: Vec3 = [near.out[0], near.out[1], near.out[2]];
    const spacing = sheetSpacing(near, seed, n);

    // The whole box: the card on the tangent plane, and the depth the streamlines may reach along
    // the normal, with room for the sheet to curve.
    const depth = (REACH_SHEETS + 0.5) * spacing;
    const tangent = Math.hypot(across, down) * zoom * 0.6;
    const half = n.map((c) => Math.abs(c) * depth + Math.sqrt(Math.max(0, 1 - c * c)) * tangent + 0.15 * depth + 48);
    const field = await load(
      seed.map((v, i) => v - half[i]) as Vec3,
      seed.map((v, i) => v + half[i]) as Vec3,
      lasagna.mask === null
        ? undefined
        : await maskLevel(lasagna.mask, 2 * Math.max(...half) * lasagna.micron),
    );
    if (this.closed) return undefined;
    const read = performance.now() - started;
    const patch = buildPatch(field, seed, n, gridFor(across, down, zoom), K, PER, spacing);
    return patch === undefined ? undefined : { patch, spacing, read };
  }

  /**
   * Makes the piece cover `w`, building pieces around the sheets reached on the way; returns the
   * nearest sheet it could reach, which is `w` unless the sheets ran out.
   */
  private async reach(w: number) {
    while (this.patch !== undefined && Math.abs(w - this.baseW) > REBASE_AT) {
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
      // Signed like the piece it continues, so that w keeps growing the same way.
      const next = await this.build(found.at, patch.normal);
      if (this.closed || next === undefined) break;
      this.patch = next.patch;
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

        // Nothing at all is not worth sending: the card goes on saying that it is loading.
        const send = (step = 1) => {
          const pixels = new Uint8ClampedArray(width * height * 4);
          const { coarser, drawn: painted } = drawPlane(patch, plane, sheet, SPAN, width, height, scan, fine, pixels, step);
          if (painted === 0) return coarser;
          const frame: FrameEvent = {
            type: "frame",
            id,
            w: reached,
            plane,
            limited: reached !== w,
            width,
            height,
            pixels: pixels.buffer,
            loading: coarser > 0 || step > 1,
          };
          this.post(frame, [frame.pixels]);
          return coarser;
        };

        drawn = asked;
        // A quick half-resolution look first, so that turning the wheel keeps up, then the whole
        // thing; another sheet asked for in between leaves the whole one for it instead.
        send(2);
        if (this.wanted !== w || this.plane !== plane) continue;
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
    case "close":
      cards.get(request.id)?.close();
      cards.delete(request.id);
      break;
  }
};

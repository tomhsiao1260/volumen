/**
 * The march, kept: reading and writing a `Walk` as a chart on the server (`server/utils/charts.ts`).
 *
 * A piece is built in two halves (`patch.ts`).  The first marches a grid of nodes out through the
 * sheets and is what the whole thing costs — some three hundred normal samples a node, behind a
 * structure tensor read out of the scan.  The second takes what a person said and resamples each
 * node's own path at a shifted winding, and costs almost nothing.  Only the first half is in here,
 * which is why one chart serves every annotation ever drawn on it: a `same` winding cannot reach the
 * march at all, and a `relative` one reaches it only through `apart`, which is part of the name.
 *
 * It is a small uncompressed zarr v2 store, so anything that reads zarr can open one and the page
 * can write one without a compressor — the page carries blosc's decoder and not its encoder.
 */
import { SERVER_DATA_ENDPOINT } from "../config";
import type { Vec3 } from "./field";
import type { Walk } from "./patch";

/*
 * The version of the fit a chart was walked by.
 *
 * It is part of a chart's name, so changing it abandons every chart on disk rather than reading back
 * marches that were walked by maths that no longer exists.  ANY change to how the march comes out
 * must change this: `HOLD`, `MARGIN`, `STEP_OF_WRAP`, `baseSurface`'s passes or sweeps, `walk`
 * itself, `spacingSaid`, or the structure tensor behind the normals (`NORMAL_UM`, `AROUND_UM`,
 * `ONE_WAY` in `field.ts`).  Nothing checks this for you.
 */
export const FIT = 1;

// Layers to a chunk.  The grid is at most 65 a side today, so a chunk holds whole rows and columns
// and only the sheets are split: 7 chunks of about 400 kB each, and no padding worth the name.  When
// the grid one day grows for panning, the writer picks a smaller tile and nothing else changes — the
// shape is in the `.zarray`, and the reader reads it from there.
const PER_CHUNK = 16;

// Everything the march depends on.  What is NOT here is what a chart is allowed to outlive: the
// `same` windings, the sheet being shown, the plane, the card's size on screen.
export interface ChartOf {
  source: string;
  micron: number;
  normals: string;
  seed: Vec3;
  towards: Vec3;
  zoom: number;
  nu: number;
  nv: number;
  hu: number;
  hv: number;
  reach: number;
  per: number;
  spacing: number;
  // The relative windings by id and revision, sorted: they set `apart`, which is the step the march
  // takes, so a chart walked before one of them was drawn is not this chart.
  steps: string[];
}

export async function chartId(of: ChartOf) {
  const said = [
    FIT,
    of.source,
    of.micron,
    of.normals,
    of.seed.map((v) => Math.round(v)).join(","),
    of.towards.map((v) => v.toFixed(2)).join(","),
    of.zoom,
    `${of.nu}x${of.nv}`,
    `${of.hu.toFixed(3)},${of.hv.toFixed(3)}`,
    of.reach,
    of.per,
    of.spacing.toFixed(3),
    [...of.steps].sort().join(","),
  ].join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(said));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}

interface ChartMeta {
  version: 1;
  fit: number;
  layers: number;
  reach: number;
  per: number;
  nu: number;
  nv: number;
  hu: number;
  hv: number;
  apart: number;
  anchor: Vec3;
  right: Vec3;
  down: Vec3;
  normal: Vec3;
  origin: { u: number; v: number; w: number };
  /*
   * How this chart's own grid sits in a shared one, once there is a shared one.  Null means "itself",
   * which is every chart today.  Stitching neighbouring regions will fill this in — and because the
   * positions below are absolute scan voxels rather than offsets, stitching only ever rewrites this
   * line and never a single number of the march.
   */
  frame: null;
  of: ChartOf;
}

const at = (id: string, key: string) => `${SERVER_DATA_ENDPOINT}/api/charts/${id}/${key}`;

const zarray = (shape: number[], chunks: number[], dtype: string, fill: string | number) =>
  JSON.stringify({
    zarr_format: 2,
    shape,
    chunks,
    dtype,
    compressor: null,
    fill_value: fill,
    order: "C",
    filters: null,
    dimension_separator: "/",
  });

/*
 * The bytes of a typed array are written and read as they sit in memory, and `<f4` says little
 * endian.  Every machine a browser runs on today is little endian; this says so out loud rather than
 * producing a chart full of nonsense on one that is not.
 */
const LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

async function put(id: string, key: string, body: BodyInit) {
  const answer = await fetch(at(id, key), {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body,
  });
  if (!answer.ok) throw new Error(`Could not write chart ${id}/${key}: ${answer.status}`);
}

/**
 * The march kept under this name, or nothing.  `meta.json` is written last, so a chart that answers
 * is a chart that is whole.
 */
export async function readChart(id: string): Promise<Walk | undefined> {
  if (!LITTLE) return undefined;
  const answer = await fetch(at(id, "meta.json")).catch(() => undefined);
  if (answer === undefined || !answer.ok) return undefined;
  const meta = (await answer.json()) as ChartMeta;
  // The name already says all of this; it is read back anyway, because a chart is a file on a disk
  // that something else may have written.
  if (meta.version !== 1 || meta.fit !== FIT) return undefined;
  const { layers, nu, nv, reach, per } = meta;
  if (layers !== 2 * reach + 1) return undefined;

  const count = nu * nv;
  const P = new Float32Array(layers * count * 3);
  const A = new Float32Array(layers * count);
  const shape = (await (await fetch(at(id, "pos/.zarray"))).json()) as { chunks: number[] };
  const block = shape.chunks[0];
  // Every chunk at once.  They are four hundred kilobytes each off a disk on this machine, so what
  // the reading costs is the asking, and asking seven times in a row costs seven times as much.
  const want: Promise<ArrayBuffer | undefined>[] = [];
  for (let cw = 0; cw * block < layers; cw++)
    want.push(
      fetch(at(id, `pos/${cw}/0/0/0`)).then((one) => (one.ok ? one.arrayBuffer() : undefined)),
      fetch(at(id, `cover/${cw}/0/0`)).then((one) => (one.ok ? one.arrayBuffer() : undefined)),
    );
  const all = await Promise.all(want);
  for (let cw = 0; cw * block < layers; cw++) {
    const pos = all[cw * 2], cover = all[cw * 2 + 1];
    if (pos === undefined || cover === undefined) return undefined;
    const from = new Float32Array(pos);
    const was = new Uint8Array(cover);
    // The last chunk of a chart is padded out to a whole chunk, as zarr's are; only the layers the
    // chart actually has are taken from it.
    const here = Math.min(block, layers - cw * block);
    if (from.length < here * count * 3 || was.length < here * count) return undefined;
    P.set(from.subarray(0, here * count * 3), cw * block * count * 3);
    for (let k = 0; k < here * count; k++) A[cw * block * count + k] = was[k];
  }
  return {
    nu,
    nv,
    hu: meta.hu,
    hv: meta.hv,
    P,
    A,
    reach,
    per,
    apart: meta.apart,
    n0: meta.normal,
    right: meta.right,
    down: meta.down,
  };
}

/** Keeps a march under this name.  `meta.json` goes last, which is what makes the chart whole. */
export async function writeChart(id: string, walk: Walk, of: ChartOf, anchor: Vec3) {
  if (!LITTLE) return;
  const { nu, nv, reach, per, P, A } = walk;
  const layers = 2 * reach + 1;
  const count = nu * nv;
  const block = Math.min(PER_CHUNK, layers);
  await put(id, "pos/.zarray", zarray([layers, nv, nu, 3], [block, nv, nu, 3], "<f4", "NaN"));
  await put(id, "cover/.zarray", zarray([layers, nv, nu], [block, nv, nu], "|u1", 0));
  for (let cw = 0; cw * block < layers; cw++) {
    const here = Math.min(block, layers - cw * block);
    // A whole chunk every time, the tail of the last one left as the fill value says.
    const pos = new Float32Array(block * count * 3).fill(NaN);
    pos.set(P.subarray(cw * block * count * 3, (cw * block + here) * count * 3));
    const cover = new Uint8Array(block * count);
    for (let k = 0; k < here * count; k++) cover[k] = A[cw * block * count + k] > 0.5 ? 1 : 0;
    await put(id, `pos/${cw}/0/0/0`, pos.buffer as ArrayBuffer);
    await put(id, `cover/${cw}/0/0`, cover.buffer as ArrayBuffer);
  }
  const meta: ChartMeta = {
    version: 1,
    fit: FIT,
    layers,
    reach,
    per,
    nu,
    nv,
    hu: walk.hu,
    hv: walk.hv,
    apart: walk.apart,
    anchor,
    right: walk.right,
    down: walk.down,
    normal: walk.n0,
    origin: { u: (nu - 1) / 2, v: (nv - 1) / 2, w: 0 },
    frame: null,
    of,
  };
  await put(id, "meta.json", JSON.stringify(meta, null, 2));
}

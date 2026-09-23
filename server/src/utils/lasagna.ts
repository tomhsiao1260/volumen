/**
 * What a surface card flattens the papyrus with.  The Lasagna prediction gives the sheet normals:
 *
 *   s3://vesuvius-challenge-open-data/<sample>/representations/predictions/lasagna/<scanId>-lasagna-<model>[-L2]/
 *     <name>.lasagna.json          which array holds each channel, and at which level
 *     <name>_cos.ome.zarr/3        phase: 1 on a sheet, 0 halfway between two
 *     <name>_grad_mag.ome.zarr/4   sheets crossed per voxel (u8 / 4000)
 *     <name>_nx.ome.zarr/4, _ny    the sheet normal's x and y (unsigned)
 *
 * the surface prediction says where the sheets themselves are, far more finely than the phase does:
 *
 *   s3://…/<sample>/representations/predictions/surfaces/<scanId>-surface-<model>-L<n>-th<t>.zarr/<level>
 *
 * and the scroll's axis tells which way is outward:
 *
 *   s3://…/<sample>/representations/umbilicus/<scanId>-umbilicus-<date>.json
 *
 * All are found by the scan's id, the timestamp its folder name starts with.  Each array becomes a
 * source of its own, so that its chunks are downloaded once and kept like a scan's.
 */

import { upsertSource } from "./sources";

const BUCKET_URL = "https://vesuvius-challenge-open-data.s3.amazonaws.com";
const CACHE_MS = 10 * 60 * 1000;

export const CHANNELS = ["cos", "grad_mag", "nx", "ny"] as const;
export type Channel = (typeof CHANNELS)[number];

export interface Lasagna {
  // The source serving each channel's array, and the scan level the array is on.
  channels: Record<Channel, { sourceId: string; level: number }>;
  // The surface prediction, 255 where the model has a sheet's face: the source serving the whole
  // store, and which scan level its own level 0 is — the folder's `-L<n>`, since the arrays all
  // claim a scale of 1 whatever they are.  A card picks the level it needs from that.  Null where
  // the bucket has none for this scan, and then the phase has to say where the sheets are instead.
  mask: { sourceId: string; base: number; micron: number } | null;
  // How big a voxel of the full-resolution scan is, in µm: what a card needs to turn the size it
  // covers into a level to read the prediction at.
  micron: number;
  // The scroll's axis, in voxels of the full-resolution scan and in order of z, or null where there
  // is none.
  umbilicus: { x: number; y: number; z: number }[] | null;
}

const cache = new Map<string, { at: number; value: Lasagna | null }>();

// The folders and the files directly under `prefix`.
async function list(prefix: string) {
  const url = `${BUCKET_URL}/?list-type=2&delimiter=%2F&prefix=${encodeURIComponent(prefix)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Listing ${prefix} failed: ${response.status} ${response.statusText}`);
  }
  const xml = await response.text();
  const folders = [...xml.matchAll(/<Prefix>([^<]*)<\/Prefix>/g)]
    .map((match) => match[1])
    .filter((found) => found !== prefix)
    .map((found) => found.slice(prefix.length).replace(/\/$/, ""));
  const files = [...xml.matchAll(/<Key>([^<]*)<\/Key>/g)].map((match) =>
    match[1].slice(prefix.length),
  );
  return { folders, files };
}

async function getJson(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return response.json();
}

// `.../PHercParis4/volumes/20260411134726-2.400um-0.2m-78keV-masked.zarr` -> PHercParis4, 20260411134726, 2.4
function parseScanUrl(url: string) {
  const match = url.match(/^(.*)\/([^/]+)\/volumes\/(\d+)-([\d.]+)um-[^/]*\.zarr$/);
  if (match === null || match[1] !== BUCKET_URL) return undefined;
  return { sample: match[2], scanId: match[3], micron: Number(match[4]) };
}

/**
 * The surface prediction for a scan: the whole store, and which scan level its own level 0 is.  The
 * folder name says that (`-L2`) and nothing else does — every level's `.zattrs` claims a scale of 1 —
 * so it is read from there and passed on, for a card to pick a level against how much it covers.
 */
async function findMask(sample: string, scanId: string, micron: number) {
  const prefix = `${sample}/representations/predictions/surfaces/`;
  const { folders } = await list(prefix);
  const folder = folders
    .filter((name) => name.startsWith(`${scanId}-surface-`) && name.endsWith(".zarr"))
    .sort((a, b) => Number(/-L(\d)/.exec(a)?.[1] ?? 9) - Number(/-L(\d)/.exec(b)?.[1] ?? 9))[0];
  if (folder === undefined) return null;
  const source = await upsertSource({
    local: "",
    http: `${BUCKET_URL}/${prefix}${folder}`,
    name: `${sample} · surfaces`,
  });
  const base = Number(/-L(\d)/.exec(folder)?.[1] ?? 0);
  return { sourceId: source.id, base, micron: micron * 2 ** base };
}

async function findUmbilicus(sample: string, scanId: string) {
  const prefix = `${sample}/representations/umbilicus/`;
  const { files } = await list(prefix);
  const file = files
    .filter((name) => name.startsWith(`${scanId}-umbilicus-`) && name.endsWith(".json"))
    .sort()
    .pop();
  if (file === undefined) return null;
  const json = await getJson(`${BUCKET_URL}/${prefix}${file}`);
  const points = Array.isArray(json?.control_points) ? json.control_points : [];
  return points
    .filter((p: any) => [p?.x, p?.y, p?.z].every((v) => typeof v === "number"))
    .map((p: any) => ({ x: p.x, y: p.y, z: p.z }))
    .sort((a: { z: number }, b: { z: number }) => a.z - b.z);
}

async function find(scanUrl: string): Promise<Lasagna | null> {
  const scan = parseScanUrl(scanUrl);
  if (scan === undefined) return null;
  const { sample, scanId } = scan;
  const root = `${sample}/representations/predictions/lasagna/`;
  const { folders } = await list(root);
  const folder = folders.filter((name) => name.startsWith(`${scanId}-lasagna-`)).sort().pop();
  if (folder === undefined) return null;
  const { files } = await list(`${root}${folder}/`);
  const manifestFile = files.find((name) => name.endsWith(".lasagna.json"));
  if (manifestFile === undefined) return null;
  const base = `${BUCKET_URL}/${root}${folder}`;
  const manifest = await getJson(`${base}/${manifestFile}`);
  const channels = {} as Lasagna["channels"];
  for (const channel of CHANNELS) {
    const group = manifest?.groups?.[channel];
    if (typeof group?.zarr !== "string" || typeof group?.scaledown !== "number") return null;
    const source = await upsertSource({
      local: "",
      http: `${base}/${group.zarr}`,
      name: `${sample} · lasagna ${channel}`,
    });
    channels[channel] = { sourceId: source.id, level: group.scaledown };
  }
  return {
    channels,
    mask: await findMask(sample, scanId, scan.micron),
    micron: scan.micron,
    umbilicus: await findUmbilicus(sample, scanId),
  };
}

/**
 * The Lasagna prediction of the scan at `scanUrl`, or null if the bucket has none for it (a scan
 * from elsewhere, or a sample without one).
 */
export async function getLasagna(scanUrl: string): Promise<Lasagna | null> {
  const cached = cache.get(scanUrl);
  if (cached !== undefined && Date.now() - cached.at < CACHE_MS) return cached.value;
  const value = await find(scanUrl);
  cache.set(scanUrl, { at: Date.now(), value });
  return value;
}

/**
 * The Lasagna prediction of a scan, which a surface card flattens the papyrus with:
 *
 *   s3://vesuvius-challenge-open-data/<sample>/representations/predictions/lasagna/<scanId>-lasagna-<model>[-L2]/
 *     <name>.lasagna.json          which array holds each channel, and at which level
 *     <name>_cos.ome.zarr/3        phase: 1 on a sheet, 0 halfway between two
 *     <name>_grad_mag.ome.zarr/4   sheets crossed per voxel (u8 / 4000)
 *     <name>_nx.ome.zarr/4, _ny    the sheet normal's x and y (unsigned)
 *
 * and the scroll's axis, which tells which way is outward:
 *
 *   s3://vesuvius-challenge-open-data/<sample>/representations/umbilicus/<scanId>-umbilicus-<date>.json
 *
 * Both are found by the scan's id, the timestamp its folder name starts with.  Each channel becomes a
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

// `.../PHercParis4/volumes/20260411134726-2.400um-0.2m-78keV-masked.zarr` -> PHercParis4, 20260411134726
function parseScanUrl(url: string) {
  const match = url.match(/^(.*)\/([^/]+)\/volumes\/(\d+)-[^/]*\.zarr$/);
  if (match === null || match[1] !== BUCKET_URL) return undefined;
  return { sample: match[2], scanId: match[3] };
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
  return { channels, umbilicus: await findUmbilicus(sample, scanId) };
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

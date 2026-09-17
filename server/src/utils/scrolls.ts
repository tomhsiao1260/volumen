/**
 * The scrolls of the Vesuvius Challenge, read from its open data bucket:
 *
 *   s3://vesuvius-challenge-open-data/<sample>/volumes/<scan>.zarr/
 *
 * The bucket allows anonymous listing, so the page can offer what is actually there rather than a
 * list kept by hand.  Listings are cached for a while, because they are the same all day.
 */

const BUCKET_URL = "https://vesuvius-challenge-open-data.s3.amazonaws.com";

const CACHE_MS = 10 * 60 * 1000;

// The names the Vesuvius Challenge uses for the samples that have one; the rest go by their id.
const SCROLL_NAMES: Record<string, string> = {
  PHercParis4: "Scroll 1",
  PHercParis3: "Scroll 2",
  PHerc0332: "Scroll 3",
  PHerc1667: "Scroll 4",
  PHerc0172: "Scroll 5",
};

export interface Scroll {
  // The folder in the bucket, e.g. `PHercParis4`.
  id: string;
  // What to call it: `Scroll 1` where there is such a name, otherwise the id.
  name: string;
  // A whole scroll or a fragment of one; the page shows them with different symbols.
  kind: "scroll" | "fragment";
}

export interface ScrollVolume {
  // The folder of the scan within the scroll, e.g. `20260411134726-2.400um-0.2m-78keV-masked.zarr`.
  path: string;
  // Where the scan is, ready to be used as a source.
  url: string;
  // Size of a voxel in micrometres, and the energy of the scan in keV, read from the folder name.
  voxelSize: number | null;
  energy: number | null;
  // Whether the air around the scroll has been masked away, which makes the files much smaller.
  masked: boolean;
}

interface Cached<T> {
  at: number;
  value: T;
}

let scrolls: Cached<Scroll[]> | undefined;
const volumes = new Map<string, Cached<ScrollVolume[]>>();

// The folders directly under `prefix`, e.g. `PHercParis4/` for the bucket's root.
async function listFolders(prefix: string): Promise<string[]> {
  const url = `${BUCKET_URL}/?list-type=2&delimiter=%2F&prefix=${encodeURIComponent(prefix)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Listing ${prefix || "the bucket"} failed: ${response.status} ${response.statusText}`,
    );
  }
  const xml = await response.text();
  return [...xml.matchAll(/<Prefix>([^<]*)<\/Prefix>/g)]
    .map((match) => match[1])
    .filter((found) => found !== prefix)
    .map((found) => found.slice(prefix.length).replace(/\/$/, ""));
}

export async function getScrolls(): Promise<Scroll[]> {
  if (scrolls !== undefined && Date.now() - scrolls.at < CACHE_MS) {
    return scrolls.value;
  }
  const ids = (await listFolders("")).filter((id) => !id.startsWith("_"));
  const value = ids
    .map((id): Scroll => ({
      id,
      name: SCROLL_NAMES[id] ?? id,
      // The fragments are named after the crate and fragment they come from.
      kind: /Fr\d/.test(id) ? "fragment" : "scroll",
    }))
    // The named scrolls first, in their own order, then the rest as the bucket lists them.
    .sort((a, b) => {
      const named = (scroll: Scroll) =>
        scroll.name === scroll.id ? 1 : 0;
      return named(a) - named(b) || (named(a) === 0 ? a.name.localeCompare(b.name) : 0);
    });
  scrolls = { at: Date.now(), value };
  return value;
}

// `20260411134726-2.400um-0.2m-78keV-masked.zarr` -> 2.4 µm, 78 keV, masked.
function describe(path: string): Omit<ScrollVolume, "path" | "url"> {
  const voxelSize = path.match(/-([\d.]+)um-/);
  const energy = path.match(/-([\d.]+)keV/);
  return {
    voxelSize: voxelSize === null ? null : Number(voxelSize[1]),
    energy: energy === null ? null : Number(energy[1]),
    masked: path.includes("-masked"),
  };
}

export async function getVolumes(scrollId: string): Promise<ScrollVolume[]> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(scrollId)) {
    throw new Error(`Not a scroll: ${scrollId}`);
  }
  const cached = volumes.get(scrollId);
  if (cached !== undefined && Date.now() - cached.at < CACHE_MS) {
    return cached.value;
  }
  const prefix = `${scrollId}/volumes/`;
  const paths = (await listFolders(prefix)).filter((path) =>
    path.endsWith(".zarr"),
  );
  const value = paths
    .map((path): ScrollVolume => ({
      path,
      url: `${BUCKET_URL}/${prefix}${path}`,
      ...describe(path),
    }))
    // The finest scan first: it is the one most people want.
    .sort((a, b) => (a.voxelSize ?? 1e9) - (b.voxelSize ?? 1e9));
  volumes.set(scrollId, { at: Date.now(), value });
  return value;
}

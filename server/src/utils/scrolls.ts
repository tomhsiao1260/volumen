/**
 * The scrolls of the Vesuvius Challenge, read from the two places it keeps them.
 *
 *   s3://vesuvius-challenge-open-data/<sample>/volumes/<scan>.zarr/
 *   https://dl.ash2txt.org/full-scrolls/<ScrollN>/<sample>.volpkg/volumes_zarr_…/<scan>.zarr/
 *
 * Both, because neither holds all of it.  The bucket has the newest scans — 1.1 and 2.4 µm — and the
 * full-scroll mirror, which is what the Challenge's own data browser reads, has the older 7.91 µm
 * ones that are the whole of some scrolls: Scroll 5 is 7.91 µm and the bucket has no prediction for
 * it at all.  A scan missing from one is simply not in the list, and nobody can open it.
 *
 * Neither allows a proper listing of the other's kind — the bucket answers S3's own listing, the
 * mirror an HTML index — so there is a reader for each.  Listings are cached for a while, because
 * they are the same all day, and the mirror is given a short deadline of its own so that a slow day
 * there does not hold up the scans the bucket has.
 */

const BUCKET_URL = "https://vesuvius-challenge-open-data.s3.amazonaws.com";
const MIRROR_URL = "https://dl.ash2txt.org";
const MIRROR_MS = 8000;
/*
 * Which folder of the mirror is which sample of the bucket.  Said here rather than worked out,
 * because the two do not spell them the same: the bucket's `PHerc0332` is the mirror's
 * `Scroll3/PHerc332.volpkg`, and `PHerc0172` is `Scroll5/PHerc172.volpkg`.
 */
const MIRROR_FOLDER: Record<string, string> = {
  PHercParis4: "Scroll1",
  PHercParis3: "Scroll2",
  PHerc0332: "Scroll3",
  PHerc1667: "Scroll4",
  PHerc0172: "Scroll5",
};

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

/*
 * `20260411134726-2.400um-0.2m-78keV-masked.zarr` -> 2.4 µm, 78 keV, masked, and the mirror's
 * `54keV_7.91um_Scroll1A.zarr` just as well: it says the same things with underscores.
 */
function describe(path: string): Omit<ScrollVolume, "path" | "url"> {
  const voxelSize = path.match(/[-_]([\d.]+)um[-_]/);
  // At the start of the name as well as inside it: the mirror writes `54keV_7.91um_Scroll1A.zarr`.
  const energy = path.match(/(?:^|[-_])([\d.]+)keV/);
  return {
    voxelSize: voxelSize === null ? null : Number(voxelSize[1]),
    energy: energy === null ? null : Number(energy[1]),
    masked: path.includes("-masked"),
  };
}

// The folders directly under a path of the mirror, which answers an HTML index and not a listing.
async function listMirror(path: string): Promise<string[]> {
  const response = await fetch(`${MIRROR_URL}/${path}`, { signal: AbortSignal.timeout(MIRROR_MS) });
  if (!response.ok) throw new Error(`Listing ${path} failed: ${response.status}`);
  const html = await response.text();
  return [...html.matchAll(/href="([^"]+)\/"/g)].map((match) => match[1]).filter((name) => name !== "..");
}

/*
 * And what a scan of the mirror is, where its folder does not say.
 *
 * The standardised ones are named for what they are; the rest are named for when they were taken,
 * and the volume package keeps a `meta.json` beside each with the voxel size written out.
 */
async function mirrorMeta(path: string) {
  const response = await fetch(`${MIRROR_URL}/${path}`, { signal: AbortSignal.timeout(MIRROR_MS) });
  if (!response.ok) return undefined;
  const meta = (await response.json()) as { voxelsize?: number; name?: string };
  if (typeof meta.voxelsize !== "number") return undefined;
  const energy = (meta.name ?? "").match(/([\d.]+)\s*keV/);
  return { voxelSize: meta.voxelsize, energy: energy === null ? null : Number(energy[1]), masked: false };
}

// The scans of one scroll the mirror has, or none at all where it is slow or has nothing.
async function mirrorVolumes(scrollId: string): Promise<ScrollVolume[]> {
  const folder = MIRROR_FOLDER[scrollId];
  if (folder === undefined) return [];
  try {
    const pkg = (await listMirror(`full-scrolls/${folder}/`)).find((name) => name.endsWith(".volpkg"));
    if (pkg === undefined) return [];
    const out: ScrollVolume[] = [];
    for (const held of ["volumes_zarr_standardized", "volumes_zarr"]) {
      const base = `full-scrolls/${folder}/${pkg}/${held}/`;
      const names = await listMirror(base).catch(() => []);
      for (const name of names.filter((one) => one.endsWith(".zarr"))) {
        const said = describe(name);
        const known =
          said.voxelSize !== null
            ? said
            : ((await mirrorMeta(
                `full-scrolls/${folder}/${pkg}/volumes/${name.replace(/\.zarr$/, "")}/meta.json`,
              ).catch(() => undefined)) ?? said);
        out.push({ path: name, url: `${MIRROR_URL}/${base}${name}`, ...known });
      }
    }
    return out;
  } catch (error) {
    console.error(`The full-scroll mirror did not answer for ${scrollId}:`, error);
    return [];
  }
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
  const [paths, mirrored] = await Promise.all([
    listFolders(prefix).then((all) => all.filter((path) => path.endsWith(".zarr"))),
    mirrorVolumes(scrollId),
  ]);
  const value = paths
    .map((path): ScrollVolume => ({
      path,
      url: `${BUCKET_URL}/${prefix}${path}`,
      ...describe(path),
    }))
    /*
     * And the mirror's, less any scan the bucket already has.  The two name the same scan differently
     * — `20241024131838.zarr` there against `20241024131838-7.910um-53keV-masked.zarr` here — so they
     * are told apart by the timestamp they both start with, and the bucket's is the one kept: it is
     * the masked copy, which is a fraction of the size for the same papyrus.
     */
    .concat(
      mirrored.filter((one) => {
        const when = one.path.match(/^(\d{14})\b/);
        return when === null || !paths.some((path) => path.startsWith(when[1]));
      }),
    )
    // The finest scan first: it is the one most people want.
    .sort((a, b) => (a.voxelSize ?? 1e9) - (b.voxelSize ?? 1e9));
  volumes.set(scrollId, { at: Date.now(), value });
  return value;
}

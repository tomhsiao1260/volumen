/**
 * @file The data sources the server serves (see `server/src/utils/sources.ts`): a folder on the
 * server's disk, a remote store, or both.  A card names one, and every card that names the same
 * source shows the same volume, so its chunks are downloaded and uploaded once.
 */

import type { Viewer, Volume } from "viewer";
import { SERVER_API_ENDPOINT, SERVER_DATA_ENDPOINT } from "../config";
import { round } from "./catalog";

export interface Source {
  id: string;
  // What to call it on a card, e.g. `PHercParis4 · 45.5 µm`; empty for a source given by hand.
  name: string;
  local: string;
  http: string;
  // Where the server keeps this source's files: its folder, or a cache folder of its own.
  root: string;
}

/**
 * What to call a source: a scan of the Vesuvius Challenge bucket by its sample and its own numbers,
 * as the data itself names it (`PHercParis4 · 45.5 µm · 110 keV`), otherwise the name it was chosen
 * under or the folder it reads.  The url is read rather than trusted to the stored name, which an
 * older version of this app may have written as `Scroll 1`.
 */
/**
 * How big a voxel of a source is, in µm, read out of the name the bucket gives it
 * (`…-45.532um-11.0m-110keV-masked.zarr`); null for a source that does not say.
 *
 * Asked of the source rather than of the Lasagna prediction, because most scans have no prediction:
 * of the twenty-three in the app only five do, and every one of those is a 2.4 µm scan.  The fit
 * states its lengths in µm so that it means the same thing on any of them, and this is where the µm
 * comes from when there is nothing else to ask.
 */
export function sourceMicron({ http, local }: Source) {
  // Either separator: the open-data bucket writes `-7.910um-`, and the full-scroll mirror the
  // Vesuvius Challenge's own data browser reads writes `54keV_7.91um_Scroll1A.zarr`.
  const found = (http || local).match(/[-_]([\d.]+)um[-_]/);
  return found === null ? null : Number(found[1]);
}

export function sourceLabel({ name, local, http }: Source) {
  /*
   * `.../PHercParis4/volumes/20260310173927-45.532um-11.0m-110keV-masked.zarr` from the bucket, or
   * `.../PHercParis4.volpkg/volumes_zarr_standardized/54keV_7.91um_Scroll1A.zarr` from the full-scroll
   * mirror — the same scroll said two ways (`describe` in `server/src/utils/scrolls.ts`).
   */
  const of =
    http.match(/\/([^/]+)\/volumes\//) ?? http.match(/\/([^/]+)\.volpkg\/volumes[^/]*\//);
  if (of !== null) {
    const voxelSize = http.match(/[-_]([\d.]+)um[-_]/);
    // At the start of the name as well as inside it: the mirror writes `54keV_7.91um_Scroll1A.zarr`.
    const energy = http.match(/(?:[-_]|\/)([\d.]+)keV/);
    const parts = [sample(of[1])];
    if (voxelSize !== null) parts.push(`${round(Number(voxelSize[1]))} µm`);
    if (energy !== null) parts.push(`${Number(energy[1])} keV`);
    return parts.join(" · ");
  }
  if (name !== "") return name;
  const path = local !== "" ? local : http;
  return path.replace(/\/+$/, "").split(/[/\\]/).pop() || path;
}

/**
 * The scan a source is of, as `sample/scanId` — `PHercParis4/20260411134726` — or "" for a source
 * that is not a scan of the bucket.  It is what annotations about the papyrus are filed under: the
 * source's own id is a hash of the paths this machine reads it through, so it names the same scan
 * differently on another machine, or after a local copy is added.
 */
export function scanOf({ http }: Source) {
  const bucket = http.match(/\/([^/]+)\/volumes\/(\d+)-/);
  if (bucket !== null) return `${sample(bucket[1])}/${bucket[2]}`;
  /*
   * And the full-scroll mirror, which names the same things differently:
   *
   *   …/Scroll1/PHercParis4.volpkg/volumes_zarr_standardized/54keV_7.91um_Scroll1A.zarr
   *
   * The sample is the volume package and the scan is the array, since the mirror's older scans have
   * no timestamp in their name.  Without this a scan of the mirror is filed under nothing, and
   * nothing can be said about it at all — which is what a scroll whose only scan is 7.91 µm amounts
   * to.
   */
  const mirror = http.match(/\/([^/]+)\.volpkg\/volumes[^/]*\/([^/]+)\.zarr/);
  return mirror === null ? "" : `${sample(mirror[1])}/${mirror[2]}`;
}

/*
 * The sample as the bucket spells it.  The mirror drops the padding — its `PHerc332` and `PHerc172`
 * are the bucket's `PHerc0332` and `PHerc0172` — and annotations about one scroll should sit together
 * whichever of the two a scan came from.
 */
function sample(name: string) {
  const padded = name.match(/^PHerc(\d+)$/);
  return padded === null ? name : `PHerc${padded[1].padStart(4, "0")}`;
}

export async function listSources(): Promise<Source[]> {
  const response = await fetch(`${SERVER_API_ENDPOINT}/api/sources`);
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()).sources;
}

// Returns the source for this pair of paths, adding it if the server does not have it yet.
export async function upsertSource(local: string, http: string, name = "") {
  const response = await fetch(`${SERVER_API_ENDPOINT}/api/sources`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ local, http, name }),
  });
  if (!response.ok) {
    throw new Error(((await response.json()) as { error: string }).error);
  }
  return (await response.json()) as Source;
}

export class VolumeRegistry {
  private volumes = new Map<string, Volume>();

  constructor(private viewer: Viewer) {}

  /**
   * The volume of `sourceId`, loaded the first time it is asked for.  Volumes are kept until the
   * page is closed, so a card that names a source again draws it at once; the chunk manager drops
   * the chunks of a volume nothing looks at when it needs the memory.
   */
  get(sourceId: string) {
    let volume = this.volumes.get(sourceId);
    if (volume === undefined) {
      volume = this.viewer.addVolume({
        kind: "http",
        url: `${SERVER_DATA_ENDPOINT}/api/data/${sourceId}`,
      });
      this.volumes.set(sourceId, volume);
    }
    return volume;
  }
}

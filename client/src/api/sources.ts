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
export function sourceLabel({ name, local, http }: Source) {
  // `.../PHercParis4/volumes/20260310173927-45.532um-11.0m-110keV-masked.zarr`, as the server reads
  // it too (`describe` in `server/src/utils/scrolls.ts`).
  const sample = http.match(/\/([^/]+)\/volumes\//);
  if (sample !== null) {
    const voxelSize = http.match(/-([\d.]+)um-/);
    const energy = http.match(/-([\d.]+)keV/);
    const parts = [sample[1]];
    if (voxelSize !== null) parts.push(`${round(Number(voxelSize[1]))} µm`);
    if (energy !== null) parts.push(`${Number(energy[1])} keV`);
    return parts.join(" · ");
  }
  if (name !== "") return name;
  const path = local !== "" ? local : http;
  return path.replace(/\/+$/, "").split(/[/\\]/).pop() || path;
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

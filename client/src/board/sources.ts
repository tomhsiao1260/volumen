/**
 * @file The data sources the server serves (see `server/src/utils/sources.ts`): a folder on the
 * server's disk, a remote store, or both.  A card names one, and every card that names the same
 * source shows the same volume, so its chunks are downloaded and uploaded once.
 */

import type { Viewer, Volume } from "viewer";
import { SERVER_API_ENDPOINT } from "../config";

export interface Source {
  id: string;
  // What to call it on a card, e.g. `Scroll 1 · 45.5 µm`; empty for a source given by hand.
  name: string;
  local: string;
  http: string;
  // Where the server keeps this source's files: its folder, or a cache folder of its own.
  root: string;
}

/**
 * What to call a source: the name it was chosen under, or the folder or scan it reads.  A scan of
 * the Vesuvius Challenge bucket is named after its sample and the size of a voxel.
 */
export function sourceLabel({ name, local, http }: Source) {
  if (name !== "") return name;
  const bucket = http.match(/\/([^/]+)\/volumes\/[^/]*?-([\d.]+)um-/);
  if (bucket !== null) return `${bucket[1]} · ${Number(bucket[2])} µm`;
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
        url: `${SERVER_API_ENDPOINT}/api/data/${sourceId}`,
      });
      this.volumes.set(sourceId, volume);
    }
    return volume;
  }
}

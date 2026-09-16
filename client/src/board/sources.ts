/**
 * @file The data sources the server serves (see `server/src/utils/sources.ts`): a folder on the
 * server's disk, a remote store, or both.  A card names one, and every card that names the same
 * source shows the same volume, so its chunks are downloaded and uploaded once.
 */

import type { MissingChunkHandler, Viewer, Volume } from "viewer";
import { SERVER_API_ENDPOINT } from "../config";

export interface Source {
  id: string;
  local: string;
  http: string;
  // Where the server keeps this source's files: its folder, or a cache folder of its own.
  root: string;
}

// A short name for a source: the folder it reads, or the remote store it downloads from.
export function sourceLabel({ local, http }: Source) {
  const path = local !== "" ? local : http;
  return path.replace(/\/+$/, "").split(/[/\\]/).pop() || path;
}

export async function listSources(): Promise<Source[]> {
  const response = await fetch(`${SERVER_API_ENDPOINT}/api/sources`);
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()).sources;
}

// Returns the source for this pair of paths, adding it if the server does not have it yet.
export async function upsertSource(local: string, http: string) {
  const response = await fetch(`${SERVER_API_ENDPOINT}/api/sources`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ local, http }),
  });
  if (!response.ok) {
    throw new Error(((await response.json()) as { error: string }).error);
  }
  return (await response.json()) as Source;
}

export class VolumeRegistry {
  private volumes = new Map<string, Volume>();

  constructor(
    private viewer: Viewer,
    private onMissingChunk: MissingChunkHandler,
  ) {}

  /**
   * The volume of `sourceId`, loaded the first time it is asked for.  Volumes are kept until the
   * page is closed, so a card that names a source again draws it at once; the chunk manager drops
   * the chunks of a volume nothing looks at when it needs the memory.
   */
  get(sourceId: string) {
    let volume = this.volumes.get(sourceId);
    if (volume === undefined) {
      volume = this.viewer.addVolume(
        { kind: "http", url: `${SERVER_API_ENDPOINT}/api/data/${sourceId}` },
        { onMissingChunk: this.onMissingChunk },
      );
      this.volumes.set(sourceId, volume);
    }
    return volume;
  }
}

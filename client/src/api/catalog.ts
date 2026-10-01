/**
 * @file What there is to look at: the scrolls in the Vesuvius Challenge data bucket and the folders
 * of this machine, both listed by the server (see `server/src/utils/scrolls.ts` and `folders.ts`).
 */

import { SERVER_API_ENDPOINT } from "../config";

export interface Scroll {
  id: string;
  name: string;
  kind: "scroll" | "fragment";
}

export interface ScrollVolume {
  path: string;
  url: string;
  voxelSize: number | null;
  energy: number | null;
  masked: boolean;
}

export interface FolderListing {
  path: string;
  parent: string | null;
  folders: { name: string; path: string }[];
  isZarr: boolean;
}

async function get<T>(path: string): Promise<T> {
  const response = await fetch(`${SERVER_API_ENDPOINT}${path}`);
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? response.statusText);
  }
  return response.json();
}

export async function listScrolls() {
  return (await get<{ scrolls: Scroll[] }>("/api/scrolls")).scrolls;
}

export async function listVolumes(scrollId: string) {
  return (
    await get<{ volumes: ScrollVolume[] }>(
      `/api/scrolls/${encodeURIComponent(scrollId)}/volumes`,
    )
  ).volumes;
}

export async function listFolders(path?: string) {
  const query = path === undefined ? "" : `?path=${encodeURIComponent(path)}`;
  return get<FolderListing>(`/api/folders${query}`);
}

export async function createFolder(parent: string, name: string) {
  const response = await fetch(`${SERVER_API_ENDPOINT}/api/folders`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parent, name }),
  });
  if (!response.ok) {
    throw new Error(
      ((await response.json()) as { error: string }).error ?? response.statusText,
    );
  }
  return (await response.json()) as FolderListing;
}

// `45.5` for 45.532, `1.13` for 1.129: enough to tell the scans of one scroll apart.
export function round(micrometres: number) {
  return String(Number(micrometres.toFixed(micrometres >= 10 ? 1 : 2)));
}

/*
 * `2.4 µm · 78 keV`, from what the folder name says about a scan.
 *
 * Not whether the air around the scroll has been masked away, which nearly every scan has and which
 * changes nothing about what is in it.
 */
export function describeVolume({ voxelSize, energy }: ScrollVolume) {
  const parts = [];
  if (voxelSize !== null) parts.push(`${round(voxelSize)} µm`);
  if (energy !== null) parts.push(`${energy} keV`);
  return parts.join(" · ");
}

// What a card calls this scan: the sample first, as the data itself names it.
export function volumeName(scroll: Scroll, volume: ScrollVolume) {
  const parts = [scroll.id];
  if (volume.voxelSize !== null) parts.push(`${round(volume.voxelSize)} µm`);
  if (volume.energy !== null) parts.push(`${volume.energy} keV`);
  return parts.join(" · ");
}

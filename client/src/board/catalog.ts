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

// `2.4 µm · 78 keV · masked`, from what the folder name says about a scan.
export function describeVolume({ voxelSize, energy, masked }: ScrollVolume) {
  const parts = [];
  if (voxelSize !== null) parts.push(`${voxelSize} µm`);
  if (energy !== null) parts.push(`${energy} keV`);
  if (masked) parts.push("masked");
  return parts.join(" · ");
}

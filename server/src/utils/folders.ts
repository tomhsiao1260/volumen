import os from "os";
import path from "path";
import fsp from "fs/promises";

/**
 * Browsing this machine's folders, so that a card's local copy can be pointed at one by clicking
 * rather than by typing a path.  Only folders are listed: the files inside a zarr store are of no
 * interest here, and there can be millions of them.
 */
export interface FolderListing {
  // The folder being listed, as an absolute path.
  path: string;
  // The folder above it, or null at the root.
  parent: string | null;
  folders: { name: string; path: string }[];
  // Whether this folder already holds a zarr store, which is what the page is usually looking for.
  isZarr: boolean;
}

export const HOME = os.homedir();

export async function listFolders(at?: string): Promise<FolderListing> {
  const here = path.resolve(at === undefined || at === "" ? HOME : at);
  const entries = await fsp.readdir(here, { withFileTypes: true });
  const folders = entries
    // Hidden folders are noise here, except that a zarr store is recognised by its own dot files.
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => ({ name: entry.name, path: path.join(here, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const parent = path.dirname(here);
  return {
    path: here,
    parent: parent === here ? null : parent,
    folders,
    isZarr: entries.some((entry) => entry.name === ".zattrs"),
  };
}

// Makes a folder to download a scroll into.  The name is a single folder, not a path.
export async function createFolder(parent: string, name: string) {
  if (!/^[^/\\:*?"<>|]{1,64}$/.test(name) || name === "." || name === "..") {
    throw new Error(`Not a folder name: ${name}`);
  }
  const folder = path.join(path.resolve(parent), name);
  await fsp.mkdir(folder, { recursive: true });
  return folder;
}

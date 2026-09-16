import crypto from "crypto";
import path from "path";
import fsp from "fs/promises";

/**
 * Where one card's data comes from: a folder on this machine, a remote store, or both.
 *
 *   local only: the folder is read and nothing is downloaded
 *   remote only: files are downloaded into a folder of this source's own, under `db/cache`
 *   both: the folder is read first, and what it does not have is downloaded into it
 *   neither: no data (the page does not ask for such a source)
 */
export interface Source {
  // Hash of the pair below, so that the same pair is always the same source: two cards that name it
  // share one download and one set of textures, and its cache folder is the same after a restart.
  id: string;
  // The `.zarr` folder on this machine, or empty.
  local: string;
  // The remote `.zarr` store, or empty.
  http: string;
  // Where this source's files are: `local`, or its own folder under `db/cache`.
  root: string;
}

const DB_PATH = path.join(process.cwd(), "db");
const SOURCE_PATH = path.join(DB_PATH, "json", "sources.json");

// Written one after another, so that two requests adding a source cannot lose each other's write.
let writing: Promise<unknown> = Promise.resolve();

interface StoredSource {
  local: string;
  http: string;
}

function makeSource(id: string, { local, http }: StoredSource): Source {
  return {
    id,
    local,
    http,
    root: local === "" ? path.join(DB_PATH, "cache", id) : path.resolve(local),
  };
}

// Trailing slashes and a relative local path would otherwise make the same data two sources.
function normalize({ local, http }: StoredSource): StoredSource {
  local = local.trim();
  return {
    local: local === "" ? "" : path.resolve(local),
    http: http.trim().replace(/\/+$/, ""),
  };
}

async function readStored(): Promise<Record<string, StoredSource>> {
  try {
    const stored = JSON.parse(await fsp.readFile(SOURCE_PATH, "utf-8"));
    const sources: Record<string, StoredSource> = {};
    for (const [id, value] of Object.entries(stored)) {
      const { local, http } = value as StoredSource;
      if (typeof local === "string" && typeof http === "string") {
        sources[id] = { local, http };
      }
    }
    return sources;
  } catch {
    return {};
  }
}

export async function getSources(): Promise<Source[]> {
  const stored = await readStored();
  return Object.entries(stored).map(([id, source]) => makeSource(id, source));
}

export async function getSource(id: string): Promise<Source | undefined> {
  if (!/^[0-9a-f]{12}$/.test(id)) return undefined;
  const stored = await readStored();
  const source = stored[id];
  return source === undefined ? undefined : makeSource(id, source);
}

/**
 * Returns the source for `local` and `http`, adding it if it is new.  Asking twice for the same pair
 * returns the same source.
 */
export async function upsertSource(pair: StoredSource): Promise<Source> {
  const { local, http } = normalize(pair);
  const id = crypto
    .createHash("sha256")
    .update(`${local}\0${http}`)
    .digest("hex")
    .slice(0, 12);
  writing = writing.then(async () => {
    const stored = await readStored();
    if (stored[id] !== undefined) return;
    stored[id] = { local, http };
    await fsp.mkdir(path.dirname(SOURCE_PATH), { recursive: true });
    await fsp.writeFile(SOURCE_PATH, JSON.stringify(stored, null, 2), "utf-8");
  });
  await writing;
  return makeSource(id, { local, http });
}

/**
 * Returns the path of `key` (e.g. `0/52/24/18`) under `root`, or `undefined` if the key points
 * outside of it.
 */
export function resolveWithin(root: string, key: string) {
  const file = path.resolve(root, key);
  const relative = path.relative(root, file);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    key.includes("\0") ||
    key.endsWith(".part")
  ) {
    return undefined;
  }
  return file;
}

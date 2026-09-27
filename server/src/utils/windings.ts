import path from "path";
import fsp from "fs/promises";

/**
 * Winding annotations: what a person has said about which sheet is which, kept per scan rather than
 * per board.  A chain of points says either "these are all on the same wrap of the papyrus" or "these
 * are one wrap apart, counted outward" — the two constraints the Vesuvius Challenge asks for
 * (scrollprize.org/open_problems/winding_annotations), and the two that a flattening can be told.
 *
 * They are kept apart from the board on purpose.  The board is one document with one revision, saved
 * whole, and a single clash stops it saving for the rest of the session; annotations are many small
 * records that two people — or two windows — may add to at once, so they are merged one at a time by
 * their own revision.  They also outlive the board: a card is closed and re-opened, a scan is opened
 * in another window, and what was said about the papyrus is still true.
 *
 * The field names are chosen to map one for one onto the community's exchange format
 * (`vc_pointcollections_json_version: "1"`): `at` is its `p`, `turn` its `wind_a`, `madeAt` its
 * `creation_time`.  Exporting is then a rename and a change of units, not a translation.
 */
export interface WindPoint {
  id: string;
  // The voxel, (x, y, z) in the scan's own full-resolution grid.
  at: { x: number; y: number; z: number };
  // Which wrap, counted along the chain: 0, 1, 2, … for a chain that counts outward, and null for
  // one that only says "the same wrap".  Only the differences mean anything.
  turn: number | null;
  madeAt: number;
}

export interface WindChain {
  id: string;
  /*
   * The scan this is about, as `sample/scanId` — `PHercParis4/20260411134726`.  Not the source id:
   * that is a hash of the paths this machine happens to read the scan through, so the same scan is a
   * different source on another machine, and annotations would silently come unstuck from it.
   */
  scan: string;
  kind: "same" | "step";
  points: WindPoint[];
  // Turned off, to see what it was doing.  Off is not deleted: the chain is still a record.
  on: boolean;
  note: string;
  author: string;
  // Raised on every change; the higher revision wins a merge.
  rev: number;
  madeAt: number;
  // A deleted chain is kept as a tombstone, so that deleting it also merges.
  deletedAt?: number;
}

const ROOT = path.join(process.cwd(), "db", "json", "windings");

// `sample/scanId`, and nothing that could name a file anywhere else.
const SCAN = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function scanPath(scan: string) {
  if (!SCAN.test(scan)) return undefined;
  return path.join(ROOT, `${scan.replace("/", "__")}.json`);
}

function number(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function text(value: unknown) {
  return typeof value === "string" ? value : "";
}

function parsePoint(value: any): WindPoint | undefined {
  const at = value?.at;
  const finite = (v: unknown) => typeof v === "number" && Number.isFinite(v);
  if (text(value?.id) === "" || ![at?.x, at?.y, at?.z].every(finite)) return undefined;
  return {
    id: text(value.id),
    at: { x: at.x, y: at.y, z: at.z },
    turn: value.turn == null ? null : number(value.turn, 0),
    madeAt: number(value.madeAt, 0),
  };
}

export function parseChain(value: any, scan: string): WindChain | undefined {
  if (typeof value !== "object" || value === null || text(value.id) === "") return undefined;
  const points = (Array.isArray(value.points) ? value.points : [])
    .map(parsePoint)
    .filter((point: WindPoint | undefined): point is WindPoint => point !== undefined);
  return {
    id: text(value.id),
    scan,
    kind: value.kind === "same" ? "same" : "step",
    points,
    on: value.on !== false,
    note: text(value.note),
    author: text(value.author),
    rev: Math.max(0, Math.round(number(value.rev, 0))),
    madeAt: number(value.madeAt, 0),
    ...(value.deletedAt == null ? {} : { deletedAt: number(value.deletedAt, 0) }),
  };
}

export async function getChains(scan: string): Promise<WindChain[]> {
  const file = scanPath(scan);
  if (file === undefined) return [];
  try {
    const stored = JSON.parse(await fsp.readFile(file, "utf-8"));
    const chains = Array.isArray(stored?.chains) ? stored.chains : [];
    return chains
      .map((chain: unknown) => parseChain(chain, scan))
      .filter((chain: WindChain | undefined): chain is WindChain => chain !== undefined);
  } catch {
    return [];
  }
}

let writing: Promise<unknown> = Promise.resolve();

/**
 * Merges `changed` into what is stored for `scan`, one chain at a time: the higher revision wins, and
 * a chain nobody has touched is left alone.  Returns everything the scan now has.
 */
export async function saveChains(scan: string, changed: unknown): Promise<WindChain[]> {
  const file = scanPath(scan);
  if (file === undefined) throw new Error("That is not a scan");
  let result: WindChain[] = [];
  writing = writing.then(async () => {
    const stored = await getChains(scan);
    const byId = new Map(stored.map((chain) => [chain.id, chain]));
    for (const value of Array.isArray(changed) ? changed : []) {
      const chain = parseChain(value, scan);
      if (chain === undefined) continue;
      const had = byId.get(chain.id);
      if (had === undefined || chain.rev >= had.rev) byId.set(chain.id, chain);
    }
    result = [...byId.values()];
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify({ version: 1, chains: result }, null, 2), "utf-8");
  });
  await writing;
  return result;
}

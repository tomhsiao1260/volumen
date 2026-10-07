/**
 * Charts: the marches the surface cards have already walked, kept on disk.
 *
 * A surface card reads the papyrus around a seed and marches a grid of nodes out through the sheets
 * (`client/src/surface/patch.ts`).  That march is what a piece costs — some three hundred field
 * samples per node, behind a fifty-megabyte structure tensor read out of the scan — and it is walked
 * again from nothing every time the page is loaded, every time a winding is taken in, and every time
 * a pull reaches past the end of the table.  None of those marches differ from the one before.
 *
 * So a card writes its march here and looks for it first.  What a person SAID about the sheets is
 * not in here: that is applied afterwards by resampling each node's own path, which costs nothing
 * worth keeping, and leaving it out is what lets one chart serve every annotation drawn on it.
 *
 * The format is a small uncompressed zarr v2 store, so it can be opened by anything that reads zarr
 * and so the page can write it without a compressor (the page only has blosc's decoder).  One folder
 * per chart, named by a hash of everything the march depends on — including a version of the fit
 * itself, so that changing the maths abandons every chart rather than quietly reusing wrong ones:
 *
 *   db/charts/<chartId>/meta.json      the frame it was laid out on; written LAST, so its presence
 *                                      is what says the chart is whole
 *   db/charts/<chartId>/pos/.zarray    [layers, nv, nu, 3] of "<f4": the scan voxel each node is at
 *   db/charts/<chartId>/pos/<cw>/0/0/0
 *   db/charts/<chartId>/cover/.zarray  [layers, nv, nu] of "|u1": whether the march got there
 *   db/charts/<chartId>/cover/<cw>/0/0
 *
 * The positions are absolute scan voxels, not offsets from the seed.  That is deliberate: when
 * charts of neighbouring regions are one day stitched, they are already in the same space, so the
 * stitching changes how their grids correspond and never has to rewrite a single number.
 */
import fsp from "fs/promises";
import path from "path";
import { resolveWithin } from "./sources";

const ROOT = path.join(process.cwd(), "db", "charts");
// 12 lowercase hex, as a source id is (`sources.ts`).
const ID = /^[0-9a-f]{12}$/;

/*
 * How many charts to keep.  One is about five megabytes, and a person makes a new one for every
 * seed, every zoom and every change to a relative winding, so without a limit this grows without
 * end.  The least recently used go: `meta.json` is touched whenever a chart is read, so "recently
 * used" is when it was last of use and not when it was made.
 */
const KEPT = 12;

export function chartFile(id: string, key: string) {
  if (!ID.test(id)) return undefined;
  return resolveWithin(path.join(ROOT, id), key);
}

let writing: Promise<unknown> = Promise.resolve();

export async function writeChartFile(id: string, key: string, data: Buffer) {
  const file = chartFile(id, key);
  if (file === undefined) return false;
  // One writer at a time, as the board and the windings do: two cards finishing the same march
  // together would otherwise interleave their bytes.
  const done = writing.then(async () => {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    // Under a name of its own first, so a half-written chunk is never served (`download.ts`).
    const temporary = `${file}.${process.pid}.${Date.now()}.part`;
    await fsp.writeFile(temporary, data);
    await fsp.rename(temporary, file);
  });
  writing = done.catch(() => {});
  await done;
  return true;
}

// Says a chart was of use just now, which is what keeps it from being the next one thrown away.
export async function touchChart(id: string) {
  const file = chartFile(id, "meta.json");
  if (file === undefined) return;
  const now = new Date();
  await fsp.utimes(file, now, now).catch(() => {});
}

/**
 * Throws away the charts nobody has used lately.  This is the only place the server deletes
 * anything, so it is careful: only folders directly under `db/charts` whose names are chart ids,
 * and never the one just written.
 */
export async function tidyCharts(keep: string) {
  const names = await fsp.readdir(ROOT).catch(() => [] as string[]);
  const mine = names.filter((name) => ID.test(name) && name !== keep);
  if (mine.length <= KEPT) return;
  const aged = await Promise.all(
    mine.map(async (name) => ({
      name,
      at: await fsp
        .stat(path.join(ROOT, name, "meta.json"))
        .then((s) => s.mtimeMs)
        // A chart with no `meta.json` was never finished, so it is the first to go.
        .catch(() => 0),
    })),
  );
  aged.sort((a, b) => b.at - a.at);
  for (const old of aged.slice(KEPT)) {
    const folder = path.join(ROOT, old.name);
    // Belt and braces: the name came from a listing of ROOT and matched the id pattern, and this
    // says so once more before anything is removed.
    if (path.dirname(folder) !== ROOT || !ID.test(path.basename(folder))) continue;
    await fsp.rm(folder, { recursive: true, force: true }).catch(() => {});
    console.log(`Forgot chart ${old.name}`);
  }
}

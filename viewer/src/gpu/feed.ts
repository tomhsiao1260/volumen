/**
 * @file One page of a chunk, cut out and put in the atlas.
 *
 * Pages are a fixed 64 voxels and chunks are whatever the store says — 256 at full resolution for
 * these scans and 64 below it — so a page is a box cut out of a larger box, and only its x runs
 * contiguously.
 *
 * It is one page at a time on purpose.  A chunk arriving used to be cut into all of its pages and
 * every one written, and for a full-resolution chunk that is sixty-four pages of which a sheet
 * cutting through it touches two or three: the atlas filled with papyrus nobody was looking at and
 * dropped what somebody was.  Now the shader says which page it wanted and did not find
 * (`sample.ts`), and only that page is written.
 */
import type { Atlas } from "#src/gpu/atlas.js";
import { PAGE } from "#src/gpu/atlas.js";

// One page's worth of bytes, reused rather than allocated per page.
const spare = new Uint8Array(PAGE ** 3);

/**
 * Cuts one page out of a chunk and puts it in.
 *
 * `at` is the page's place in its scale's grid of pages and `grid` the chunk's in its grid of
 * chunks, both counted (x, y, z); `data` is the chunk, with x fastest.
 *
 * Answers `false` if it could not be written — the atlas's texture may not exist on the GPU yet —
 * and the caller may simply let the shader ask again.
 */
export function putPage(
  atlas: Atlas,
  source: number,
  level: number,
  at: [number, number, number],
  grid: ArrayLike<number>,
  size: ArrayLike<number>,
  data: Uint8Array,
): boolean {
  // Where this page starts inside the chunk.
  const o0 = at[0] * PAGE - grid[0] * size[0];
  const o1 = at[1] * PAGE - grid[1] * size[1];
  const o2 = at[2] * PAGE - grid[2] * size[2];
  if (
    o0 < 0 || o1 < 0 || o2 < 0 ||
    o0 + PAGE > size[0] || o1 + PAGE > size[1] || o2 + PAGE > size[2]
  ) {
    return false;
  }
  if (size[0] === PAGE && size[1] === PAGE && size[2] === PAGE) {
    // The chunk is the page: handed straight through, which is the common scale.
    return atlas.put({ source, level, at }, data.subarray(0, PAGE ** 3));
  }
  for (let z = 0; z < PAGE; z++)
    for (let y = 0; y < PAGE; y++) {
      const from = ((o2 + z) * size[1] + (o1 + y)) * size[0] + o0;
      spare.set(data.subarray(from, from + PAGE), (z * PAGE + y) * PAGE);
    }
  return atlas.put({ source, level, at }, spare);
}

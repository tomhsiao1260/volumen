/**
 * @file A chunk arriving, cut into pages and put in the atlas.
 *
 * This is the whole of the seam between the part of the library that knows about zarr, priorities
 * and eviction — which is the larger part, and none of it cares what a GPU is — and the part that
 * draws.  Before, a chunk became a texture of its own; now it becomes some pages of one texture.
 *
 * The cutting is why pages are a fixed size and chunks are not.  On disk these scans are chunked
 * 256³ at full resolution and 64³ below it, so a full-resolution chunk is sixty-four pages and a
 * coarse one is a single page handed straight through.  Nothing above here has to know that, and a
 * scan chunked some third way would need no change at all.
 */
import type { Atlas } from "#src/gpu/atlas.js";
import { PAGE } from "#src/gpu/atlas.js";

/** A chunk as the atlas needs to see it. */
export interface Arrived {
  source: number;
  level: number;
  // Where the chunk sits in its scale's grid of chunks, counted (x, y, z).
  grid: ArrayLike<number>;
  // How many voxels a chunk is, the same way round, with x fastest in `data`.
  size: ArrayLike<number>;
  data: Uint8Array;
}

// One page's worth of bytes, reused between chunks rather than allocated per page.
const spare = new Uint8Array(PAGE ** 3);

/**
 * Puts a chunk in, as however many pages it is.
 *
 * Answers `false` if any page could not be written — which happens before the atlas's texture
 * exists on the GPU, since three.js makes it on first use — and the caller should offer the chunk
 * again on a later frame.
 */
export function putChunk(atlas: Atlas, chunk: Arrived): boolean {
  const { source, level, grid, size, data } = chunk;
  for (let axis = 0; axis < 3; axis++) {
    if (size[axis] % PAGE !== 0) {
      throw new Error(
        `A chunk of ${size[0]}x${size[1]}x${size[2]} does not divide into ${PAGE}-voxel pages.`,
      );
    }
  }
  const want = size[0] * size[1] * size[2];
  if (data.length < want) {
    throw new Error(`A chunk of ${size[0]}x${size[1]}x${size[2]} needs ${want} bytes, not ${data.length}.`);
  }
  const pages: [number, number, number] = [size[0] / PAGE, size[1] / PAGE, size[2] / PAGE];
  // Where this chunk's first page sits in the scale's own grid of pages.
  const first = [grid[0] * pages[0], grid[1] * pages[1], grid[2] * pages[2]];

  // A chunk that is already one page is handed straight through, which is the common scale.
  if (pages[0] === 1 && pages[1] === 1 && pages[2] === 1) {
    return atlas.put(
      { source, level, at: [first[0], first[1], first[2]] },
      data.length === PAGE ** 3 ? data : data.subarray(0, PAGE ** 3),
    );
  }

  let all = true;
  for (let pz = 0; pz < pages[2]; pz++)
    for (let py = 0; py < pages[1]; py++)
      for (let px = 0; px < pages[0]; px++) {
        // Row by row, because a page is a box cut out of a larger box and only x is contiguous.
        for (let z = 0; z < PAGE; z++)
          for (let y = 0; y < PAGE; y++) {
            const from =
              ((pz * PAGE + z) * size[1] + (py * PAGE + y)) * size[0] + px * PAGE;
            spare.set(data.subarray(from, from + PAGE), (z * PAGE + y) * PAGE);
          }
        all =
          atlas.put(
            { source, level, at: [first[0] + px, first[1] + py, first[2] + pz] },
            spare,
          ) && all;
      }
  return all;
}

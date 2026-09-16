// Entry point of the workers that decompress chunks (see `src/worker/decode_pool.ts`).
//
// Note: This file uses ".js" rather than ".ts" extension because we cannot rely
// on Node.js subpath imports to translate paths for Workers since those paths
// must be valid for use in `new URL` with multiple bundlers.
import "#src/worker/decode_blosc.js";

// Note: This file uses ".js" rather than ".ts" extension because we cannot rely
// on Node.js subpath imports to translate paths for Workers since those paths
// must be valid for use in `new URL` with multiple bundlers.
import "#src/worker/shared_watchable_value.js";
import "#datasource/zarr/backend";
import { RPC } from "#src/worker/worker_rpc.js";

const rpc = new RPC(self, /*waitUntilReady=*/ false);
rpc.sendReady();


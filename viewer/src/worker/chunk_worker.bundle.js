// Note: This file uses ".js" rather than ".ts" extension because we cannot rely
// on Node.js subpath imports to translate paths for Workers since those paths
// must be valid for use in `new URL` with multiple bundlers.
import "#src/worker/shared_watchable_value.js";
import "#datasource/zarr/backend";
// Registers the worker half of a surface view, which asks for the chunks a flattening lands in.
import "#src/render/surface_backend.js";
import { RPC } from "#src/worker/worker_rpc.js";

const rpc = new RPC(self, /*waitUntilReady=*/ false);
rpc.sendReady();


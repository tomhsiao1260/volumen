/** @license Copyright 2019 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * @file Chunk worker side of decompression in a pool of workers.
 *
 * Decompressing a chunk takes long enough to be worth moving out of the chunk worker, which also
 * schedules downloads: it runs in a pool of workers (`decode_worker.bundle.js`), so that several
 * chunks are decompressed at once, on several cores.  Workers are launched as needed, up to
 * `maxWorkers`; a request goes to a free worker, or waits until one is free.
 *
 * Neuroglancer has a general form of this, which runs any computation registered under a name in the
 * pool (`src/async_computation/` there); here the pool only decompresses blosc buffers.
 */

// Sent to a pool worker, which takes over `data`.
export interface DecodeRequest {
  id: number;
  data: Uint8Array<ArrayBuffer>;
}

// Its answer: the decompressed bytes, or the error that decompressing them threw.
export interface DecodeResponse {
  id: number;
  value?: Uint8Array<ArrayBuffer>;
  error?: any;
}

let numWorkers = 0;
const freeWorkers: Worker[] = [];
// Requests waiting for a free worker, by request id.
const pendingRequests = new Map<
  number,
  { msg: DecodeRequest; cleanup: () => void }
>();
// Requests not yet answered, by request id.
const requests = new Map<
  number,
  { resolve: (value: Uint8Array<ArrayBuffer>) => void; reject: (error: any) => void }
>();
// On Safari, `navigator.hardwareConcurrency` is not defined.
const maxWorkers =
  typeof navigator.hardwareConcurrency === "undefined"
    ? 4
    : Math.min(12, navigator.hardwareConcurrency);
let nextRequestId = 0;

function sendRequest(worker: Worker, msg: DecodeRequest) {
  worker.postMessage(msg, [msg.data.buffer]);
}

// Gives `worker` the request that has waited longest, or marks it as free.
function returnWorker(worker: Worker) {
  for (const [id, request] of pendingRequests) {
    pendingRequests.delete(id);
    request.cleanup();
    sendRequest(worker, request.msg);
    return;
  }
  freeWorkers.push(worker);
}

function launchWorker() {
  ++numWorkers;
  // Note: a browser-compatible URL must be used with `new URL`, which means a Node.js subpath
  // import like "#src/worker/decode_worker.bundle.js" cannot be used.
  const worker = new Worker(
    new URL("./decode_worker.bundle.js", import.meta.url),
    { type: "module" },
  );
  let ready = false;
  worker.onmessage = (msg) => {
    // The first message says that the worker is ready.
    if (!ready) {
      ready = true;
      returnWorker(worker);
      return;
    }
    const { id, value, error } = msg.data as DecodeResponse;
    returnWorker(worker);
    const callbacks = requests.get(id);
    requests.delete(id);
    if (callbacks === undefined) return;
    if (error !== undefined) {
      callbacks.reject(error);
    } else {
      callbacks.resolve(value!);
    }
  };
}

/**
 * Decompresses the blosc buffer `data` in a pool worker, which takes it over, and resolves to the
 * decompressed bytes.  Aborting `signal` rejects a request that is still waiting for a worker; once
 * a worker has started on it, it runs to completion.
 */
export function requestBloscDecode(
  data: Uint8Array<ArrayBuffer>,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  signal.throwIfAborted();
  const id = nextRequestId++;
  const msg: DecodeRequest = { id, data };
  const promise = new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
    requests.set(id, { resolve, reject });
  });
  const freeWorker = freeWorkers.pop();
  if (freeWorker !== undefined) {
    sendRequest(freeWorker, msg);
  } else {
    const abortHandler = () => {
      pendingRequests.delete(id);
      const request = requests.get(id)!;
      requests.delete(id);
      request.reject(signal.reason);
    };
    signal.addEventListener("abort", abortHandler, { once: true });
    pendingRequests.set(id, {
      msg,
      cleanup: () => signal.removeEventListener("abort", abortHandler),
    });
    if (requests.size > numWorkers && numWorkers < maxWorkers) {
      launchWorker();
    }
  }
  return promise;
}

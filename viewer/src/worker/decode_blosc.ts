/** @license Copyright 2023 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * @file Pool worker side of decompression (see `decode_pool.ts`): decompresses each blosc buffer it
 * is sent, and posts the result back, transferring it.
 */

import Blosc from "numcodecs/blosc";
import type { DecodeRequest } from "#src/worker/decode_pool.js";

// The blosc header stores the compressor, shuffle and type size, so decoding needs no
// configuration.
const codec = Blosc.fromConfig({ id: "blosc" });

// What this worker uses of its global scope (`DedicatedWorkerGlobalScope`).
const worker = self as unknown as {
  onmessage: ((msg: MessageEvent) => void) | null;
  postMessage(message: any, options?: { transfer?: Transferable[] }): void;
};

worker.onmessage = async (msg: MessageEvent) => {
  const { id, data } = msg.data as DecodeRequest;
  try {
    const value = (await codec.decode(data)) as Uint8Array<ArrayBuffer>;
    worker.postMessage({ id, value }, { transfer: [value.buffer] });
  } catch (error) {
    worker.postMessage({ id, error });
  }
};

// Tells the pool that this worker is ready for requests.
worker.postMessage(null);

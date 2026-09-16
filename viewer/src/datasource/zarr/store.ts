/** @license Copyright 2020 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * @file Where the files of a zarr store are read from.
 *
 * A file is addressed by its path relative to the root of the store, e.g. `.zattrs`, `0/.zarray` or
 * `0/52/24/18`.  The main thread reads the metadata and the worker reads the chunks, so a store is
 * described by a `ZarrStoreSpec`, which can be sent to the worker, and each thread creates its own
 * `ZarrStore` from it with `createZarrStore`.
 *
 * To read a store from anywhere else (a remote bucket, a custom server, ...), serve its files over
 * HTTP, answering 404 for missing files, and use an `http` spec.
 */

export interface ZarrStore {
  /**
   * Returns the contents of the file at `key`, or `undefined` if there is no such file.  Other
   * failures, such as network errors, reject.  Once `signal` is aborted, rejects with its reason.
   */
  get(key: string, signal?: AbortSignal): Promise<Uint8Array | undefined>;
}

export type ZarrStoreSpec =
  // Files served over HTTP; `url` is the URL of the store's root.
  | { kind: "http"; url: string }
  // Files in a local folder picked with the File System Access API.
  | { kind: "directory"; handle: FileSystemDirectoryHandle };

// Requests answered with 429 (too many requests), 503 (service unavailable) or 504 (gateway timeout)
// are retried, up to `MAX_ATTEMPTS` attempts in all, after a random delay that doubles with each
// attempt: 0.5-1 s, 1-2 s, 2-4 s, ..., at most 5-10 s.
const MAX_ATTEMPTS = 32;
const MIN_DELAY_MS = 500;
const MAX_DELAY_MS = 10000;

function pickDelay(attempt: number) {
  return Math.min(2 ** attempt * MIN_DELAY_MS, MAX_DELAY_MS / 2) * (1 + Math.random());
}

// Resolves after `ms` milliseconds, or rejects as soon as `signal` is aborted.
function sleep(ms: number, signal: AbortSignal | undefined) {
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class HttpStore implements ZarrStore {
  // `url` is the URL of the store's root, without a trailing slash.
  constructor(public url: string) {}

  async get(key: string, signal?: AbortSignal) {
    const url = `${this.url}/${key}`;
    for (let attempt = 1; ; ++attempt) {
      signal?.throwIfAborted();
      let response: Response;
      try {
        // Aborting `signal` also aborts reading the body below.
        response = await fetch(url, { signal });
      } catch {
        signal?.throwIfAborted();
        // The browser reports a response blocked by CORS the same way as a network error.
        throw new Error(
          `Could not fetch ${url}: network error, or the server does not allow ` +
            `cross-origin requests (no Access-Control-Allow-Origin header)`,
        );
      }
      const { status } = response;
      // S3 answers 403 rather than 404 for a missing file.
      if (status === 404 || status === 403) return undefined;
      if (
        (status === 429 || status === 503 || status === 504) &&
        attempt < MAX_ATTEMPTS
      ) {
        await sleep(pickDelay(attempt - 1), signal);
        continue;
      }
      if (!response.ok) {
        throw new Error(
          `Fetching ${url} failed: ${status} ${response.statusText}`,
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    }
  }
}

export class DirectoryStore implements ZarrStore {
  constructor(public handle: FileSystemDirectoryHandle) {}

  // Reading a local file cannot be interrupted, so `signal` is checked between the steps.
  async get(key: string, signal?: AbortSignal) {
    const parts = key.split("/");
    const fileName = parts.pop()!;
    let file: File;
    try {
      let directory = this.handle;
      for (const part of parts) {
        directory = await directory.getDirectoryHandle(part);
        signal?.throwIfAborted();
      }
      const fileHandle = await directory.getFileHandle(fileName);
      signal?.throwIfAborted();
      file = await fileHandle.getFile();
    } catch (e) {
      // `TypeMismatchError`: a path component is a file where a folder is expected, or vice versa.
      if (
        e instanceof DOMException &&
        (e.name === "NotFoundError" || e.name === "TypeMismatchError")
      ) {
        return undefined;
      }
      throw e;
    }
    signal?.throwIfAborted();
    const data = new Uint8Array(await file.arrayBuffer());
    signal?.throwIfAborted();
    return data;
  }
}

export function createZarrStore(spec: ZarrStoreSpec): ZarrStore {
  switch (spec.kind) {
    case "http":
      return new HttpStore(spec.url.replace(/\/+$/, ""));
    case "directory":
      return new DirectoryStore(spec.handle);
  }
}

import path from "path";
import fsp from "fs/promises";

export type DownloadResult = "downloaded" | "missing";

// Thrown for the answers the viewer retries by itself (see `HttpStore` in the viewer): the route
// passes them on as 503, rather than failing the chunk.
export class RetryableError extends Error {}

const RETRYABLE_STATUS = new Set([429, 503, 504]);

/**
 * Files downloaded at a time.  The viewer asks for up to 100 chunks at once, and a board can have
 * many cards, so without a limit of our own a remote store would answer 429 for everything.
 */
const MAX_CONCURRENT = 8;

// Downloads in flight, so that two cards asking for the same file download it once.
const inFlight = new Map<string, Promise<DownloadResult>>();
const waiting: (() => void)[] = [];
let active = 0;
let nextTemporaryName = 0;

async function acquire() {
  while (active >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiting.push(resolve));
  }
  ++active;
}

function release() {
  --active;
  waiting.shift()?.();
}

/**
 * Downloads `key` (e.g. `0/52/24/18`) from the remote store at `remoteUrl` into `file`, and reports
 * whether the remote store has it.  Two calls for the same file share one download.
 */
export function downloadFile(
  sourceId: string,
  remoteUrl: string,
  key: string,
  file: string,
): Promise<DownloadResult> {
  const inFlightKey = `${sourceId}\0${key}`;
  const existing = inFlight.get(inFlightKey);
  if (existing !== undefined) return existing;
  const download = (async () => {
    await acquire();
    try {
      return await fetchFile(remoteUrl, key, file);
    } finally {
      release();
      inFlight.delete(inFlightKey);
    }
  })();
  inFlight.set(inFlightKey, download);
  return download;
}

/**
 * The bytes of `url`, asking for the rest of the file again whenever the connection dies part way
 * through.  The bucket drops sockets on a poor line — a megabyte of prediction can take a minute and
 * arrive nine tenths of the way before it is cut — and starting over each time means such a line
 * never finishes anything at all.  `Range` picks up where the last attempt stopped; a store that
 * ignores it simply starts the file again.
 */
const ATTEMPTS = 8;

async function fetchBytes(url: string): Promise<Buffer | "missing"> {
  const pieces: Buffer[] = [];
  let got = 0;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** Math.min(attempt, 4)));
    let response: Response;
    try {
      response = await fetch(url, got > 0 ? { headers: { Range: `bytes=${got}-` } } : undefined);
    } catch (error) {
      if (attempt === ATTEMPTS - 1) {
        throw new RetryableError(`Fetching ${url} failed: ${(error as Error).message}`);
      }
      continue;
    }
    // S3 answers 403 rather than 404 for a missing file.
    if (response.status === 404 || response.status === 403) return "missing";
    if (RETRYABLE_STATUS.has(response.status)) {
      if (attempt === ATTEMPTS - 1) throw new RetryableError(`${url} answered ${response.status}`);
      continue;
    }
    if (!response.ok) {
      throw new Error(`Fetching ${url} failed: ${response.status} ${response.statusText}`);
    }
    // Asked for the rest and given the whole thing: the store does not do ranges, so start again.
    if (got > 0 && response.status !== 206) {
      pieces.length = 0;
      got = 0;
    }
    try {
      for await (const piece of response.body as unknown as AsyncIterable<Uint8Array>) {
        pieces.push(Buffer.from(piece));
        got += piece.length;
      }
      return Buffer.concat(pieces);
    } catch (error) {
      // The connection died part way: keep what arrived and ask for the rest.
      if (attempt === ATTEMPTS - 1) {
        throw new RetryableError(`Fetching ${url} stopped after ${got} bytes: ${(error as Error).message}`);
      }
    }
  }
  throw new RetryableError(`Fetching ${url} failed`);
}

async function fetchFile(
  remoteUrl: string,
  key: string,
  file: string,
): Promise<DownloadResult> {
  const url = `${remoteUrl}/${key}`;
  const bytes = await fetchBytes(url);
  if (bytes === "missing") return "missing";
  const data = bytes;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  // Written under a name of its own first, so that a partly written file is never served and two
  // writers of the same file cannot mix their bytes.
  const temporaryPath = `${file}.${process.pid}.${nextTemporaryName++}.part`;
  await fsp.writeFile(temporaryPath, data);
  await fsp.rename(temporaryPath, file);
  console.log(`Downloaded ${key}`);
  return "downloaded";
}

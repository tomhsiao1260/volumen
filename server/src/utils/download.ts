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

async function fetchFile(
  remoteUrl: string,
  key: string,
  file: string,
): Promise<DownloadResult> {
  const url = `${remoteUrl}/${key}`;
  const response = await fetch(url);
  // S3 answers 403 rather than 404 for a missing file.
  if (response.status === 404 || response.status === 403) return "missing";
  if (RETRYABLE_STATUS.has(response.status)) {
    throw new RetryableError(`${url} answered ${response.status}`);
  }
  if (!response.ok) {
    throw new Error(
      `Fetching ${url} failed: ${response.status} ${response.statusText}`,
    );
  }
  const data = Buffer.from(await response.arrayBuffer());
  await fsp.mkdir(path.dirname(file), { recursive: true });
  // Written under a name of its own first, so that a partly written file is never served and two
  // writers of the same file cannot mix their bytes.
  const temporaryPath = `${file}.${process.pid}.${nextTemporaryName++}.part`;
  await fsp.writeFile(temporaryPath, data);
  await fsp.rename(temporaryPath, file);
  console.log(`Downloaded ${key}`);
  return "downloaded";
}

import { Router, Request, Response } from "express";
import fs from "fs";
import { downloadFile, RetryableError } from "../utils/download";
import { getSettings } from "../utils/settings";
import type { Source } from "../utils/sources";
import { getSource, resolveWithin, upsertSource } from "../utils/sources";

const router = Router();

function isFile(file: string) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Serves one file of a source's zarr store, e.g.
 * http://localhost:3005/api/data/1f4c0a9b3e22/0/52/24/18
 *
 * A file the source's folder does not have is first downloaded from its remote store, if it has one.
 * A file neither has answers 404; the viewer then shows that chunk as empty.
 */
async function serveFile(source: Source, key: string, res: Response) {
  const file = resolveWithin(source.root, key);
  if (file === undefined) {
    res.status(400).json({ error: "Invalid key" });
    return;
  }

  if (!isFile(file) && source.http !== "") {
    try {
      await downloadFile(source.id, source.http, key, file);
    } catch (error) {
      console.error(`Failed to download ${key}:`, error);
      // The viewer retries a 503 by itself; any other failure fails the chunk, and the coarser
      // scale under it shows through.
      const retryable = error instanceof RetryableError;
      res
        .status(retryable ? 503 : 502)
        .set("Retry-After", "1")
        .json({ error: (error as Error).message });
      return;
    }
  }

  if (!isFile(file)) {
    // A file that is missing now may be added later, so it must not be remembered as missing.
    res.status(404).set("Cache-Control", "no-cache").end();
    return;
  }
  res.sendFile(file, { dotfiles: "allow" });
}

// The store of the source given in the path.
router.get("/:sourceId/*key", async (req: Request, res: Response) => {
  const sourceId = String(req.params.sourceId);
  const source = await getSource(sourceId);
  if (source === undefined) {
    res.status(400).json({ error: `Unknown source ${sourceId}` });
    return;
  }
  await serveFile(source, ([] as string[]).concat(req.params.key).join("/"), res);
});

// The store described by the settings, which is what the page used before cards had their own
// sources.  Kept so that links and scripts pointing at it keep working.
router.get("/zarr/*key", async (req: Request, res: Response) => {
  const { zarr_data_path, scroll_url_path } = await getSettings();
  if (zarr_data_path === "" && scroll_url_path === "") {
    res.status(500).json({ error: "No source is set in the settings" });
    return;
  }
  const source = await upsertSource({
    local: zarr_data_path,
    http: scroll_url_path,
  });
  await serveFile(source, ([] as string[]).concat(req.params.key).join("/"), res);
});

export default router;

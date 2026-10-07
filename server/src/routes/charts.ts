import { Router, Request, Response } from "express";
import express from "express";
import fs from "fs";
import { chartFile, tidyCharts, touchChart, writeChartFile } from "../utils/charts";

const router = Router();

// A chunk of a chart is about four hundred kilobytes and is sent as it sits in memory.
router.use(express.raw({ type: "application/octet-stream", limit: "32mb" }));

const keyOf = (req: Request) => ([] as string[]).concat(req.params.key).join("/");

function isFile(file: string) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// One file of a chart the card has already walked, e.g. /api/charts/1f4c0a9b3e22/pos/3/0/0/0
router.get("/:chartId/*key", async (req: Request, res: Response) => {
  const id = String(req.params.chartId);
  const key = keyOf(req);
  const file = chartFile(id, key);
  if (file === undefined) {
    res.status(400).json({ error: "Invalid chart" });
    return;
  }
  if (!isFile(file)) {
    // A chart that is not here yet is about to be walked and written, so this must not be remembered.
    res.status(404).set("Cache-Control", "no-cache").end();
    return;
  }
  // Asking for the metadata is what a card does before reading a chart, so it stands for using it.
  if (key === "meta.json") await touchChart(id);
  res.sendFile(file, { dotfiles: "allow" });
});

// And the card writing one it has just walked.
router.put("/:chartId/*key", async (req: Request, res: Response) => {
  const id = String(req.params.chartId);
  const key = keyOf(req);
  const body = req.body;
  if (!Buffer.isBuffer(body)) {
    res.status(400).json({ error: "Expected application/octet-stream" });
    return;
  }
  if (!(await writeChartFile(id, key, body))) {
    res.status(400).json({ error: "Invalid chart" });
    return;
  }
  // The metadata is written last, so that is the moment the chart became whole and the moment to
  // see whether there are now too many.
  if (key === "meta.json") await tidyCharts(id);
  res.status(204).end();
});

export default router;

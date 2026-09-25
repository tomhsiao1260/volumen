import { Router, Request, Response } from "express";
import { getChains, saveChains, scanPath } from "../utils/windings";

const router = Router();

// The scan is `sample/scanId`, which arrives as two path segments.
router.get("/:sample/:scanId", async (req: Request, res: Response) => {
  const scan = `${req.params.sample}/${req.params.scanId}`;
  if (scanPath(scan) === undefined) {
    res.status(400).json({ error: "That is not a scan" });
    return;
  }
  res.json({ chains: await getChains(scan) });
});

/*
 * Stores the chains in the body, merging them into what is already there rather than replacing it:
 * two windows may be annotating the same scan, and a chain nobody has touched must not be lost by
 * whichever one saves last.
 */
router.put("/:sample/:scanId", async (req: Request, res: Response) => {
  const scan = `${req.params.sample}/${req.params.scanId}`;
  if (scanPath(scan) === undefined) {
    res.status(400).json({ error: "That is not a scan" });
    return;
  }
  try {
    res.json({ chains: await saveChains(scan, req.body?.chains) });
  } catch (error) {
    console.error("Failed to write the winding annotations:", error);
    res.status(500).json({ error: "Failed to write the winding annotations" });
  }
});

export default router;

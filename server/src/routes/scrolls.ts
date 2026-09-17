import { Router, Request, Response } from "express";
import { getScrolls, getVolumes } from "../utils/scrolls";

const router = Router();

// The scrolls in the Vesuvius Challenge data bucket.
router.get("/", async (_req: Request, res: Response) => {
  try {
    res.json({ scrolls: await getScrolls() });
  } catch (error) {
    console.error("Failed to list the scrolls:", error);
    res.status(502).json({ error: (error as Error).message });
  }
});

// The scans of one scroll, each of which can become a card's source.
router.get("/:scrollId/volumes", async (req: Request, res: Response) => {
  try {
    res.json({ volumes: await getVolumes(String(req.params.scrollId)) });
  } catch (error) {
    console.error("Failed to list the volumes:", error);
    res.status(502).json({ error: (error as Error).message });
  }
});

export default router;

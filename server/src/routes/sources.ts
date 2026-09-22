import { Router, Request, Response } from "express";
import { getLasagna } from "../utils/lasagna";
import { getSource, getSources, upsertSource } from "../utils/sources";

const router = Router();

// The sources the cards can name.
router.get("/", async (_req: Request, res: Response) => {
  res.json({ sources: await getSources() });
});

// Adds a source, or returns the existing one for the same pair of paths.
router.post("/", async (req: Request, res: Response) => {
  const { local, http, name } = req.body ?? {};
  const pair = {
    local: typeof local === "string" ? local : "",
    http: typeof http === "string" ? http : "",
    name: typeof name === "string" ? name : "",
  };
  if (pair.local.trim() === "" && pair.http.trim() === "") {
    res.status(400).json({ error: "A source needs a folder, a URL, or both" });
    return;
  }
  res.json(await upsertSource(pair));
});

// The Lasagna prediction of a source's scan, which a surface card needs; null if there is none.
router.get("/:id/lasagna", async (req: Request, res: Response) => {
  const source = await getSource(String(req.params.id));
  if (source === undefined) {
    res.status(404).json({ error: `Unknown source ${req.params.id}` });
    return;
  }
  try {
    res.json({ lasagna: source.http === "" ? null : await getLasagna(source.http) });
  } catch (error) {
    console.error("Failed to find the Lasagna prediction:", error);
    res.status(502).json({ error: (error as Error).message });
  }
});

export default router;

import { Router, Request, Response } from "express";
import { getSources, upsertSource } from "../utils/sources";

const router = Router();

// The sources the cards can name.
router.get("/", async (_req: Request, res: Response) => {
  res.json({ sources: await getSources() });
});

// Adds a source, or returns the existing one for the same pair of paths.
router.post("/", async (req: Request, res: Response) => {
  const { local, http } = req.body ?? {};
  const pair = {
    local: typeof local === "string" ? local : "",
    http: typeof http === "string" ? http : "",
  };
  if (pair.local.trim() === "" && pair.http.trim() === "") {
    res.status(400).json({ error: "A source needs a folder, a URL, or both" });
    return;
  }
  res.json(await upsertSource(pair));
});

export default router;

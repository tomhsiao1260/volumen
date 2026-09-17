import { Router, Request, Response } from "express";
import { createFolder, listFolders } from "../utils/folders";

const router = Router();

// The folders inside `path`, or inside the home folder if none is given.
router.get("/", async (req: Request, res: Response) => {
  const at = typeof req.query.path === "string" ? req.query.path : undefined;
  try {
    res.json(await listFolders(at));
  } catch (error) {
    // A folder that cannot be read is answered as such, so the page can stay where it was.
    res.status(400).json({ error: (error as Error).message });
  }
});

// Makes a folder, so that a scroll can be downloaded into a new one.
router.post("/", async (req: Request, res: Response) => {
  const { parent, name } = req.body ?? {};
  if (typeof parent !== "string" || typeof name !== "string") {
    res.status(400).json({ error: "A parent folder and a name are needed" });
    return;
  }
  try {
    res.json(await listFolders(await createFolder(parent, name)));
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

export default router;

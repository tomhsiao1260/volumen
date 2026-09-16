import { Router, Request, Response } from "express";
import { getBoard, saveBoard } from "../utils/board";

const router = Router();

// The board as it was last saved; an empty board the first time.
router.get("/", async (_req: Request, res: Response) => {
  res.json(await getBoard());
});

// Stores the whole board.  The page sends the `rev` it last saw; if the board has been saved by
// somebody else since, it is answered with 409 and the newer board.
router.put("/", async (req: Request, res: Response) => {
  const result = await saveBoard(req.body);
  if (result.kind === "stale") {
    res.status(409).json({ error: "stale", board: result.board });
    return;
  }
  res.json({ rev: result.rev });
});

export default router;

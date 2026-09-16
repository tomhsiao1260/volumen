/**
 * Serves zarr stores to the viewer.  Each card on the board names a source (a folder on this
 * machine, a remote store, or both, see `utils/sources.ts`), and a file the folder does not have is
 * downloaded from the remote store, so only the parts of a scroll that are looked at are downloaded,
 * and only once.
 *
 * The board itself is kept in `db/json/board.json`, the sources in `db/json/sources.json` and the
 * values a new card starts with in `db/json/settings.json`; all three can be changed from the page.
 */

import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import settingsRouter from "./routes/settings";
import sourcesRouter from "./routes/sources";
import boardRouter from "./routes/board";
import dataRouter from "./routes/data";
import { createSettingsFileIfMissing } from "./utils/settings";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3005;

// Only pages served from this machine may talk to the server: a source names any folder on it, so
// any web page open in the browser could otherwise read files through the server.
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
app.use(
  cors({
    origin: (origin, callback) =>
      callback(null, origin === undefined || LOCAL_ORIGIN.test(origin)),
  }),
);
app.use(express.json());

app.use("/api/settings", settingsRouter);
app.use("/api/sources", sourcesRouter);
app.use("/api/board", boardRouter);
app.use("/api/data", dataRouter);

// For the same reason, the server listens on this machine only.
app.listen(Number(PORT), "127.0.0.1", async () => {
  console.log(`Server is running at http://localhost:${PORT}`);
  await createSettingsFileIfMissing();
});

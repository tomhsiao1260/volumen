import { Router, Request, Response } from "express";
import { getSettings, saveSettings, Settings } from "../utils/settings";

const router = Router();

const SETTING_NAMES: (keyof Settings)[] = ["zarr_data_path", "scroll_url_path"];

// Reads the settings, e.g. http://localhost:3005/api/settings
router.get("/", async (req: Request, res: Response) => {
  res.json(await getSettings());
});

// Changes the settings given in the JSON body; the others are kept.
router.post("/", async (req: Request, res: Response) => {
  const settings = await getSettings();
  for (const name of SETTING_NAMES) {
    const value = req.body?.[name];
    if (typeof value === "string") settings[name] = value.trim();
  }
  try {
    await saveSettings(settings);
  } catch (error) {
    console.error("Failed to write the settings file:", error);
    res.status(500).json({ error: "Failed to write the settings file" });
    return;
  }
  res.json({ message: "Settings updated successfully", success: true });
});

export default router;

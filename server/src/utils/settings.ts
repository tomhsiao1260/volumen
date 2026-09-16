import path from "path";
import fsp from "fs/promises";

/**
 * What a new card's source form starts with; a card's own source is in `utils/sources.ts`.
 */
export interface Settings {
  // A `.zarr` folder on this machine, which is read and downloaded into.
  zarr_data_path: string;
  // URL of the remote zarr store that missing files are downloaded from; empty to download nothing,
  // e.g. https://dl.ash2txt.org/full-scrolls/Scroll1/PHercParis4.volpkg/volumes_zarr_standardized/54keV_7.91um_Scroll1A.zarr
  scroll_url_path: string;
}

export const SETTING_PATH = path.join(
  process.cwd(),
  "db",
  "json",
  "settings.json",
);

const DEFAULT_SETTINGS: Settings = {
  zarr_data_path: "",
  scroll_url_path: "",
};

// Only the settings above are read; anything else in the file is ignored.
export async function getSettings(): Promise<Settings> {
  try {
    const saved = JSON.parse(await fsp.readFile(SETTING_PATH, "utf-8"));
    const settings = { ...DEFAULT_SETTINGS };
    for (const name of Object.keys(settings) as (keyof Settings)[]) {
      if (typeof saved[name] === "string") settings[name] = saved[name];
    }
    return settings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(settings: Settings) {
  await fsp.mkdir(path.dirname(SETTING_PATH), { recursive: true });
  await fsp.writeFile(SETTING_PATH, JSON.stringify(settings, null, 2), "utf-8");
}

// Writes the default settings if there is no settings file yet, so that there is a file to edit.
export async function createSettingsFileIfMissing() {
  try {
    await fsp.access(SETTING_PATH);
  } catch {
    await saveSettings(DEFAULT_SETTINGS);
  }
  return getSettings();
}


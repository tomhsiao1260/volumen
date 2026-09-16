/**
 * @file The values a new card's source form starts with, kept in the server's settings so that they
 * survive a reload (see `server/src/utils/settings.ts`).
 */

import { SERVER_API_ENDPOINT } from "../config";

const DEFAULT_SCROLL_URL =
  "https://dl.ash2txt.org/full-scrolls/Scroll1/PHercParis4.volpkg/volumes_zarr_standardized/54keV_7.91um_Scroll1A.zarr/";

export interface SourceDefaults {
  local: string;
  http: string;
}

/**
 * Reads the defaults from the server and lets `panel` change them.  Cards created afterwards start
 * with the new values; the cards already on the board keep their own sources.
 */
export function createDefaultSourceForm(button: HTMLElement, panel: HTMLElement) {
  const local = panel.querySelector<HTMLInputElement>("#source-local")!;
  const url = panel.querySelector<HTMLInputElement>("#source-url")!;
  const save = panel.querySelector<HTMLButtonElement>("#source-save")!;
  url.placeholder = DEFAULT_SCROLL_URL;
  let defaults: SourceDefaults = { local: "", http: "" };

  const load = async () => {
    try {
      const response = await fetch(`${SERVER_API_ENDPOINT}/api/settings`);
      const settings = await response.json();
      defaults = {
        local: settings.zarr_data_path ?? "",
        http: settings.scroll_url_path ?? "",
      };
      local.value = defaults.local;
      url.value = defaults.http;
    } catch (error) {
      console.error("Failed to read the settings:", error);
    }
  };
  load();

  button.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) local.focus();
  });

  save.addEventListener("click", async () => {
    save.disabled = true;
    defaults = { local: local.value.trim(), http: url.value.trim() };
    try {
      const response = await fetch(`${SERVER_API_ENDPOINT}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          zarr_data_path: defaults.local,
          scroll_url_path: defaults.http,
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      panel.hidden = true;
    } catch (error) {
      console.error("Failed to save the settings:", error);
      alert("Could not save the defaults. See the browser console for details.");
    } finally {
      save.disabled = false;
    }
  });

  return { get: () => defaults };
}

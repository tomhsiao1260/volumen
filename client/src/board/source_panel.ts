/**
 * @file The form a card shows until it has a source: a folder on the server, a remote store, or
 * both, and the sources the server already knows about.
 */

import type { Source } from "./sources";
import { listSources, sourceLabel, upsertSource } from "./sources";

export interface SourcePanelOptions {
  // What the fields start with, from the server's settings.
  defaults: { local: string; http: string };
  // Called with the source the user chose or entered.
  onChosen: (source: Source) => void;
}

export function createSourcePanel({ defaults, onChosen }: SourcePanelOptions) {
  const element = document.createElement("div");
  element.className = "card-form";
  element.innerHTML = `
    <label>Zarr folder on the server<input class="source-local" type="text" spellcheck="false" /></label>
    <label>Remote store (optional)<input class="source-http" type="text" spellcheck="false" /></label>
    <div class="card-form-row"><button class="source-show">Show</button><span class="source-error"></span></div>
    <div class="source-known"></div>
  `;
  const local = element.querySelector<HTMLInputElement>(".source-local")!;
  const http = element.querySelector<HTMLInputElement>(".source-http")!;
  const show = element.querySelector<HTMLButtonElement>(".source-show")!;
  const error = element.querySelector<HTMLElement>(".source-error")!;
  const known = element.querySelector<HTMLElement>(".source-known")!;
  local.value = defaults.local;
  http.value = defaults.http;
  http.placeholder = "https://…/scroll.zarr";

  show.addEventListener("click", async () => {
    show.disabled = true;
    error.textContent = "";
    try {
      onChosen(await upsertSource(local.value.trim(), http.value.trim()));
    } catch (failure) {
      error.textContent = (failure as Error).message;
      show.disabled = false;
    }
  });

  // The sources of the other cards, to show the same data without typing the paths again.
  listSources().then(
    (sources) => {
      if (sources.length === 0) return;
      known.append(document.createTextNode("or show "));
      for (const source of sources) {
        const button = document.createElement("button");
        button.textContent = sourceLabel(source);
        button.title = [source.local, source.http].filter((x) => x !== "").join("\n");
        button.addEventListener("click", () => onChosen(source));
        known.append(button);
      }
    },
    (failure) => console.error("Failed to list the sources:", failure),
  );

  return element;
}

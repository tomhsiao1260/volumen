/**
 * @file What a card shows until it has data: the samples of the Vesuvius Challenge, their scans, and
 * a click to show one.  A scan is normally read straight from the bucket, with the server keeping
 * what has been looked at; the folder button on a scan keeps it somewhere of your choosing instead.
 * Data outside the bucket can be given by hand.
 */

import type { FolderListing, Scroll, ScrollVolume } from "./catalog";
import {
  createFolder,
  describeVolume,
  listFolders,
  listScrolls,
  listVolumes,
  volumeName,
} from "./catalog";
import { icon, IconName } from "./icons";
import type { Source } from "./sources";
import { listSources, sourceLabel, upsertSource } from "./sources";

export interface ScrollPickerOptions {
  // Called with the source the card should show.
  onChosen: (source: Source) => void;
}

// What the hand-written form was last given, so that a second card does not need it typed again.
let lastCustom = { local: "", http: "" };

export function createScrollPicker({ onChosen }: ScrollPickerOptions) {
  const element = document.createElement("div");
  element.className = "picker";

  const show = (...content: Node[]) => element.replaceChildren(...content);

  const header = (text: string, back?: () => void) => {
    const row = document.createElement("div");
    row.className = "picker-header";
    if (back !== undefined) {
      const button = document.createElement("button");
      button.className = "picker-back";
      button.append(icon("back"));
      button.title = "Back";
      button.addEventListener("click", back);
      row.append(button);
    }
    const title = document.createElement("span");
    title.textContent = text;
    row.append(title);
    return row;
  };

  const list = () => {
    const element = document.createElement("div");
    element.className = "picker-list";
    return element;
  };

  /**
   * One line of a list: a symbol, what it is, and a quieter word about it.  `action` is an extra
   * button at the end, for the scan that should be kept in a folder.
   */
  const item = (
    symbol: IconName,
    label: string,
    note: string,
    onClick: () => void,
    action?: { symbol: IconName; title: string; onClick: () => void },
  ) => {
    const row = document.createElement("div");
    row.className = "picker-item";
    const button = document.createElement("button");
    button.className = "picker-choose";
    button.append(icon(symbol));
    const name = document.createElement("span");
    name.className = "picker-name";
    name.textContent = label;
    const detail = document.createElement("span");
    detail.className = "picker-note";
    detail.textContent = note;
    button.append(name, detail);
    button.addEventListener("click", onClick);
    row.append(button);
    if (action !== undefined) {
      const extra = document.createElement("button");
      extra.className = "picker-action";
      extra.title = action.title;
      extra.append(icon(action.symbol));
      extra.addEventListener("click", action.onClick);
      row.append(extra);
    }
    return row;
  };

  const message = (text: string) => {
    const element = document.createElement("div");
    element.className = "picker-message";
    element.textContent = text;
    return element;
  };

  const footer = (...content: Node[]) => {
    const row = document.createElement("div");
    row.className = "picker-footer";
    row.append(...content);
    return row;
  };

  const link = (text: string, onClick: () => void) => {
    const button = document.createElement("button");
    button.className = "picker-link";
    button.textContent = text;
    button.addEventListener("click", onClick);
    return button;
  };

  // The samples in the bucket, with a box to narrow them down.
  async function showScrolls() {
    show(message("Reading the samples…"));
    let scrolls: Scroll[];
    try {
      scrolls = await listScrolls();
    } catch (error) {
      show(
        message(`Could not read the samples: ${(error as Error).message}`),
        footer(link("Try again", showScrolls), link("By hand…", showCustom)),
      );
      return;
    }
    const search = document.createElement("input");
    search.className = "picker-search";
    search.type = "search";
    search.placeholder = "Search";
    const items = list();
    const fill = () => {
      const text = search.value.trim().toLowerCase();
      items.replaceChildren(
        ...scrolls
          .filter(
            (scroll) =>
              text === "" ||
              scroll.id.toLowerCase().includes(text) ||
              scroll.name.toLowerCase().includes(text),
          )
          .map((scroll) =>
            item(
              scroll.kind === "fragment" ? "fragment" : "scroll",
              scroll.id,
              scroll.name === scroll.id ? "" : scroll.name,
              () => showVolumes(scroll),
            ),
          ),
      );
    };
    search.addEventListener("input", fill);
    fill();
    show(search, items, footer(link("By hand…", showCustom), knownSources()));
    search.focus();
  }

  // The scans of one sample, the finest first.  Choosing one shows it; the folder button keeps it.
  async function showVolumes(scroll: Scroll) {
    const title = `${scroll.id}${scroll.name === scroll.id ? "" : ` · ${scroll.name}`}`;
    show(header(title, showScrolls), message("Reading the scans…"));
    let volumes: ScrollVolume[];
    try {
      volumes = await listVolumes(scroll.id);
    } catch (error) {
      show(
        header(title, showScrolls),
        message(`Could not read the scans: ${(error as Error).message}`),
      );
      return;
    }
    if (volumes.length === 0) {
      show(header(title, showScrolls), message("This sample has no scans."));
      return;
    }
    const items = list();
    items.append(
      ...volumes.map((volume) =>
        item(
          "volume",
          describeVolume(volume),
          "",
          () =>
            choose({
              local: "",
              http: volume.url,
              name: volumeName(scroll, volume),
            }),
          {
            symbol: "folder",
            title: "Keep it in a folder of your own",
            onClick: () => showFolders(scroll, volume),
          },
        ),
      ),
    );
    show(
      header(title, showScrolls),
      items,
      footer(message("A scan opens where it is; the folder keeps a copy.")),
    );
  }

  // The folders of this machine, so that one can be pointed at by clicking.
  async function showFolders(
    scroll: Scroll,
    volume: ScrollVolume,
    at?: string,
  ) {
    const title = `Keep ${describeVolume(volume)} in`;
    const back = () => showVolumes(scroll);
    show(header(title, back), message("…"));
    let listing: FolderListing;
    try {
      listing = await listFolders(at);
    } catch (error) {
      show(
        header(title, back),
        message(`Could not open that folder: ${(error as Error).message}`),
        footer(link("Start again", () => showFolders(scroll, volume))),
      );
      return;
    }
    const items = list();
    if (listing.parent !== null) {
      items.append(
        item("folder", "..", "", () =>
          showFolders(scroll, volume, listing.parent ?? undefined),
        ),
      );
    }
    items.append(
      ...listing.folders.map((folder) =>
        item("folder", folder.name, "", () =>
          showFolders(scroll, volume, folder.path),
        ),
      ),
    );
    const here = document.createElement("div");
    here.className = "picker-path";
    here.textContent = listing.path;
    show(
      header(title, back),
      here,
      items,
      footer(
        link("Use this folder", () =>
          choose({
            local: listing.path,
            http: volume.url,
            name: volumeName(scroll, volume),
          }),
        ),
        link("New folder…", async () => {
          const name = prompt("Name of the new folder");
          if (name === null || name.trim() === "") return;
          try {
            const made = await createFolder(listing.path, name.trim());
            await showFolders(scroll, volume, made.path);
          } catch (error) {
            alert(`Could not make the folder: ${(error as Error).message}`);
          }
        }),
      ),
    );
  }

  // A folder and a URL given by hand, for data that is not in the bucket.
  function showCustom() {
    const form = document.createElement("div");
    form.className = "picker-form";
    const field = (label: string, value: string, placeholder: string) => {
      const wrapper = document.createElement("label");
      const text = document.createElement("span");
      text.textContent = label;
      const input = document.createElement("input");
      input.type = "text";
      input.spellcheck = false;
      input.value = value;
      input.placeholder = placeholder;
      wrapper.append(text, input);
      form.append(wrapper);
      return input;
    };
    const local = field("Zarr folder", lastCustom.local, "/path/to/scroll.zarr");
    const http = field("Remote store", lastCustom.http, "https://…/scroll.zarr");
    const error = document.createElement("span");
    error.className = "picker-error";
    show(
      header("By hand", showScrolls),
      form,
      footer(
        link("Show", async () => {
          lastCustom = { local: local.value.trim(), http: http.value.trim() };
          error.textContent = "";
          try {
            await choose(lastCustom);
          } catch (failure) {
            error.textContent = (failure as Error).message;
          }
        }),
        error,
      ),
    );
    local.focus();
  }

  // The sources the other cards use, to show the same data without going through the bucket again.
  function knownSources() {
    const row = document.createElement("span");
    row.className = "picker-known";
    listSources().then(
      (sources) => {
        if (sources.length === 0) return;
        row.append(document.createTextNode("in use: "));
        for (const source of sources) {
          row.append(link(sourceLabel(source), () => onChosen(source)));
        }
      },
      (error) => console.error("Failed to list the sources:", error),
    );
    return row;
  }

  async function choose(pair: { local: string; http: string; name?: string }) {
    show(message("Opening…"));
    onChosen(await upsertSource(pair.local, pair.http, pair.name ?? ""));
  }

  void showScrolls();
  return element;
}

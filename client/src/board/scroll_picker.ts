/**
 * @file What a card shows until it has data: the scrolls of the Vesuvius Challenge, a few clicks to
 * one of their scans, and a choice of where its files should go.  A scroll can also be given by
 * hand, for data that is not in the bucket.
 */

import type { FolderListing, Scroll, ScrollVolume } from "./catalog";
import {
  createFolder,
  describeVolume,
  listFolders,
  listScrolls,
  listVolumes,
} from "./catalog";
import { icon } from "./icons";
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

  const show = (...content: (Node | string)[]) => {
    element.replaceChildren(...content.map(asNode));
  };
  const asNode = (content: Node | string) =>
    typeof content === "string" ? document.createTextNode(content) : content;

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

  const item = (
    symbol: Parameters<typeof icon>[0],
    label: string,
    note: string,
    onClick: () => void,
  ) => {
    const button = document.createElement("button");
    button.className = "picker-item";
    button.append(icon(symbol));
    const name = document.createElement("span");
    name.className = "picker-name";
    name.textContent = label;
    const detail = document.createElement("span");
    detail.className = "picker-note";
    detail.textContent = note;
    button.append(name, detail);
    button.addEventListener("click", onClick);
    return button;
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

  // The scrolls of the bucket, with a box to narrow them down.
  async function showScrolls() {
    show(message("Reading the scrolls…"));
    let scrolls: Scroll[];
    try {
      scrolls = await listScrolls();
    } catch (error) {
      show(
        message(`Could not read the scrolls: ${(error as Error).message}`),
        footer(link("Try again", showScrolls), link("By hand…", showCustom)),
      );
      return;
    }
    const search = document.createElement("input");
    search.className = "picker-search";
    search.type = "search";
    search.placeholder = "Search the scrolls";
    const items = list();
    const fill = () => {
      const text = search.value.trim().toLowerCase();
      const found = scrolls.filter(
        (scroll) =>
          text === "" ||
          scroll.name.toLowerCase().includes(text) ||
          scroll.id.toLowerCase().includes(text),
      );
      items.replaceChildren(
        ...found.map((scroll) =>
          item(
            scroll.kind === "fragment" ? "fragment" : "scroll",
            scroll.name,
            scroll.name === scroll.id ? "" : scroll.id,
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

  // The scans of one scroll, the finest first.
  async function showVolumes(scroll: Scroll) {
    show(header(scroll.name, showScrolls), message("Reading the scans…"));
    let volumes: ScrollVolume[];
    try {
      volumes = await listVolumes(scroll.id);
    } catch (error) {
      show(
        header(scroll.name, showScrolls),
        message(`Could not read the scans: ${(error as Error).message}`),
      );
      return;
    }
    if (volumes.length === 0) {
      show(header(scroll.name, showScrolls), message("This scroll has no scans."));
      return;
    }
    const items = list();
    items.append(
      ...volumes.map((volume) =>
        item("volume", describeVolume(volume), "", () =>
          showWhere(scroll, volume),
        ),
      ),
    );
    show(header(scroll.name, showScrolls), items);
  }

  // Whether the files should only be cached by the server, or kept in a folder of one's own.
  function showWhere(scroll: Scroll, volume: ScrollVolume) {
    const choices = list();
    const name = `${scroll.name} · ${describeVolume(volume)}`;
    const view = item(
      "volume",
      "Just look at it",
      "the server keeps what you view",
      () => choose({ local: "", http: volume.url, name }),
    );
    const keep = item(
      "folder",
      "Keep it in a folder…",
      "downloaded as you look",
      () => showFolders(scroll, volume),
    );
    choices.append(view, keep);
    show(
      header(`${scroll.name} · ${describeVolume(volume)}`, () =>
        showVolumes(scroll),
      ),
      choices,
    );
  }

  // The folders of this machine, so that one can be pointed at by clicking.
  async function showFolders(
    scroll: Scroll,
    volume: ScrollVolume,
    at?: string,
  ) {
    show(header("Where to keep it", () => showWhere(scroll, volume)), message("…"));
    let listing: FolderListing;
    try {
      listing = await listFolders(at);
    } catch (error) {
      show(
        header("Where to keep it", () => showWhere(scroll, volume)),
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
      header("Where to keep it", () => showWhere(scroll, volume)),
      here,
      items,
      footer(
        link("Use this folder", () =>
          choose({
            local: listing.path,
            http: volume.url,
            name: `${scroll.name} · ${describeVolume(volume)}`,
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
    const local = field(
      "Zarr folder on this machine",
      lastCustom.local,
      "/path/to/scroll.zarr",
    );
    const http = field("Remote store", lastCustom.http, "https://…/scroll.zarr");
    const error = document.createElement("span");
    error.className = "picker-error";
    show(
      header("By hand", showScrolls),
      form,
      footer(
        link("Show it", async () => {
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
          row.append(
            link(sourceLabel(source), () => onChosen(source)),
          );
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

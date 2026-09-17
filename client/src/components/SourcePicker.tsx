/**
 * @file What a card shows until it has data: the samples of the Vesuvius Challenge, their scans, and
 * a click to open one.  A scan is normally read straight from the bucket, with the server keeping
 * what has been looked at; the folder button on a scan downloads it to a folder of your choosing
 * instead.  Data outside the bucket is given on the custom source page.
 */

import { useEffect, useState } from "react";
import type { FolderListing, Scroll, ScrollVolume } from "../api/catalog";
import {
  createFolder,
  describeVolume,
  listFolders,
  listScrolls,
  listVolumes,
  volumeName,
} from "../api/catalog";
import type { Source } from "../api/sources";
import { upsertSource } from "../api/sources";
import { Icon, IconName } from "./Icon";

// What the custom page was last given, so that a second card does not need it typed again.
let lastManual = { local: "", http: "" };

type Page =
  | { name: "samples" }
  | { name: "scans"; scroll: Scroll }
  | { name: "folder"; scroll: Scroll; volume: ScrollVolume; at?: string }
  | { name: "manual" };

export function SourcePicker({
  onChosen,
}: {
  onChosen: (source: Source) => void;
}) {
  const [page, setPage] = useState<Page>({ name: "samples" });
  const [opening, setOpening] = useState(false);
  const [failure, setFailure] = useState("");

  const open = async (pair: { local: string; http: string; name?: string }) => {
    setOpening(true);
    setFailure("");
    try {
      onChosen(await upsertSource(pair.local, pair.http, pair.name ?? ""));
    } catch (error) {
      setFailure((error as Error).message);
      setOpening(false);
    }
  };

  if (opening && failure === "") {
    return (
      <div className="picker">
        <Message text="Opening…" />
      </div>
    );
  }

  return (
    <div className="picker">
      {page.name === "samples" && (
        <Samples
          onScroll={(scroll) => setPage({ name: "scans", scroll })}
          onManual={() => setPage({ name: "manual" })}
        />
      )}
      {page.name === "scans" && (
        <Scans
          scroll={page.scroll}
          onBack={() => setPage({ name: "samples" })}
          onOpen={(volume) =>
            open({
              local: "",
              http: volume.url,
              name: volumeName(page.scroll, volume),
            })
          }
          onDownload={(volume) =>
            setPage({ name: "folder", scroll: page.scroll, volume })
          }
        />
      )}
      {page.name === "folder" && (
        <Folders
          at={page.at}
          volume={page.volume}
          onBack={() => setPage({ name: "scans", scroll: page.scroll })}
          onOpenFolder={(at) => setPage({ ...page, at })}
          onSelect={(path) =>
            open({
              local: path,
              http: page.volume.url,
              name: volumeName(page.scroll, page.volume),
            })
          }
        />
      )}
      {page.name === "manual" && (
        <Manual
          onBack={() => setPage({ name: "samples" })}
          onOpen={(pair) => {
            lastManual = pair;
            void open(pair);
          }}
          failure={failure}
        />
      )}
    </div>
  );
}

function Header({ title, onBack }: { title: string; onBack?: () => void }) {
  return (
    <div className="picker-header">
      {onBack !== undefined && (
        <button className="picker-back" title="Back" onClick={onBack}>
          <Icon name="back" />
        </button>
      )}
      <span>{title}</span>
    </div>
  );
}

function Message({ text }: { text: string }) {
  return <div className="picker-message">{text}</div>;
}

/**
 * One line of a list: a symbol, what it is, and a quieter word about it.  `action` is an extra
 * button at the end, for downloading a scan rather than opening it.
 */
function Item({
  symbol,
  label,
  note,
  onClick,
  action,
}: {
  symbol: IconName;
  label: string;
  note?: string;
  onClick: () => void;
  action?: { symbol: IconName; title: string; onClick: () => void };
}) {
  return (
    <div className="picker-item">
      <button className="picker-choose" onClick={onClick}>
        <Icon name={symbol} />
        <span className="picker-name">{label}</span>
        {note !== undefined && note !== "" && (
          <span className="picker-note">{note}</span>
        )}
      </button>
      {action !== undefined && (
        <button
          className="picker-action"
          title={action.title}
          onClick={action.onClick}
        >
          <Icon name={action.symbol} />
        </button>
      )}
    </div>
  );
}

// Reads `load` once, and again whenever `keys` change.
function useLoad<T>(load: () => Promise<T>, keys: unknown[]) {
  const [state, setState] = useState<
    { status: "loading" } | { status: "ready"; value: T } | { status: "failed"; error: string }
  >({ status: "loading" });
  useEffect(() => {
    let current = true;
    setState({ status: "loading" });
    load().then(
      (value) => current && setState({ status: "ready", value }),
      (error: Error) =>
        current && setState({ status: "failed", error: error.message }),
    );
    return () => {
      current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, keys);
  return state;
}

function Samples({
  onScroll,
  onManual,
}: {
  onScroll: (scroll: Scroll) => void;
  onManual: () => void;
}) {
  const scrolls = useLoad(listScrolls, []);
  const [search, setSearch] = useState("");

  if (scrolls.status === "loading") return <Message text="Loading samples…" />;
  if (scrolls.status === "failed") {
    return (
      <>
        <Message text={`Failed to load samples: ${scrolls.error}`} />
        <div className="picker-footer picker-footer-end">
          <button className="picker-link" onClick={onManual}>
            Custom source
          </button>
        </div>
      </>
    );
  }

  const text = search.trim().toLowerCase();
  const shown = scrolls.value.filter(
    (scroll) =>
      text === "" ||
      scroll.id.toLowerCase().includes(text) ||
      scroll.name.toLowerCase().includes(text),
  );
  return (
    <>
      <input
        className="picker-search"
        type="search"
        placeholder="Search"
        autoFocus
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <div className="picker-list">
        {shown.map((scroll) => (
          <Item
            key={scroll.id}
            symbol={scroll.kind === "fragment" ? "fragment" : "scroll"}
            label={scroll.id}
            note={scroll.name === scroll.id ? "" : scroll.name}
            onClick={() => onScroll(scroll)}
          />
        ))}
      </div>
      <div className="picker-footer picker-footer-end">
        <button className="picker-link" onClick={onManual}>
          Custom source
        </button>
      </div>
    </>
  );
}

// The scans of one sample, the finest first.  Clicking one opens it; the folder button downloads it.
function Scans({
  scroll,
  onBack,
  onOpen,
  onDownload,
}: {
  scroll: Scroll;
  onBack: () => void;
  onOpen: (volume: ScrollVolume) => void;
  onDownload: (volume: ScrollVolume) => void;
}) {
  const volumes = useLoad(() => listVolumes(scroll.id), [scroll.id]);
  const title = `${scroll.id}${scroll.name === scroll.id ? "" : ` · ${scroll.name}`}`;
  return (
    <>
      <Header title={title} onBack={onBack} />
      {volumes.status === "loading" && <Message text="Loading scans…" />}
      {volumes.status === "failed" && (
        <Message text={`Failed to load scans: ${volumes.error}`} />
      )}
      {volumes.status === "ready" && volumes.value.length === 0 && (
        <Message text="No scans." />
      )}
      {volumes.status === "ready" && volumes.value.length > 0 && (
        <div className="picker-list">
          {volumes.value.map((volume) => (
            <Item
              key={volume.path}
              symbol="volume"
              label={describeVolume(volume)}
              onClick={() => onOpen(volume)}
              action={{
                symbol: "folder",
                title: "Download to a local folder",
                onClick: () => onDownload(volume),
              }}
            />
          ))}
        </div>
      )}
    </>
  );
}

// The folders of this machine, so that one can be chosen by clicking.
function Folders({
  at,
  volume,
  onBack,
  onOpenFolder,
  onSelect,
}: {
  at: string | undefined;
  volume: ScrollVolume;
  onBack: () => void;
  onOpenFolder: (at: string) => void;
  onSelect: (path: string) => void;
}) {
  const [made, setMade] = useState(0);
  const listing = useLoad<FolderListing>(() => listFolders(at), [at, made]);
  const title = `Download ${describeVolume(volume)}`;

  const create = async (path: string) => {
    const name = prompt("New folder name");
    if (name === null || name.trim() === "") return;
    try {
      const folder = await createFolder(path, name.trim());
      onOpenFolder(folder.path);
      setMade(made + 1);
    } catch (error) {
      alert(`Failed to create folder: ${(error as Error).message}`);
    }
  };

  return (
    <>
      <Header title={title} onBack={onBack} />
      {listing.status === "loading" && <Message text="Loading…" />}
      {listing.status === "failed" && (
        <Message text={`Failed to open folder: ${listing.error}`} />
      )}
      {listing.status === "ready" && (
        <>
          <div className="picker-path">{listing.value.path}</div>
          <div className="picker-list">
            {listing.value.parent !== null && (
              <Item
                symbol="folder"
                label=".."
                onClick={() => onOpenFolder(listing.value.parent as string)}
              />
            )}
            {listing.value.folders.map((folder) => (
              <Item
                key={folder.path}
                symbol="folder"
                label={folder.name}
                onClick={() => onOpenFolder(folder.path)}
              />
            ))}
          </div>
          <div className="picker-footer">
            <button
              className="picker-link"
              onClick={() => onSelect(listing.value.path)}
            >
              Select this folder
            </button>
            <button
              className="picker-link"
              onClick={() => void create(listing.value.path)}
            >
              New folder
            </button>
          </div>
        </>
      )}
    </>
  );
}

// A local folder and a remote store given directly, for data that is not in the bucket.
function Manual({
  onBack,
  onOpen,
  failure,
}: {
  onBack: () => void;
  onOpen: (pair: { local: string; http: string }) => void;
  failure: string;
}) {
  const [local, setLocal] = useState(lastManual.local);
  const [http, setHttp] = useState(lastManual.http);
  return (
    <>
      <Header title="Custom source" onBack={onBack} />
      <div className="picker-form">
        <label>
          <span>Local store</span>
          <input
            type="text"
            spellCheck={false}
            autoFocus
            value={local}
            placeholder="/path/to/scroll.zarr"
            onChange={(event) => setLocal(event.target.value)}
          />
        </label>
        <label>
          <span>Remote store</span>
          <input
            type="text"
            spellCheck={false}
            value={http}
            placeholder="https://…/scroll.zarr"
            onChange={(event) => setHttp(event.target.value)}
          />
        </label>
      </div>
      <div className="picker-footer">
        <button
          className="picker-link"
          onClick={() => onOpen({ local: local.trim(), http: http.trim() })}
        >
          Open
        </button>
        {failure !== "" && <span className="picker-error">{failure}</span>}
      </div>
    </>
  );
}

/**
 * @file Lists the chunks whose files are not in the store, in a panel in the top-right corner of the
 * viewer.  The panel appears with the first missing chunk.
 */

import type { MissingChunkHandler } from "viewer";

// Number of chunk keys kept in the list; older ones are dropped.
const MAX_LISTED_CHUNKS = 100;

// Returns an `onMissingChunk` handler that lists each missing chunk and leaves it empty.
export function listMissingChunks(parent: HTMLElement): MissingChunkHandler {
  const element = document.createElement("div");
  element.id = "missing-chunks";
  element.hidden = true;
  const title = document.createElement("div");
  const list = document.createElement("ol");
  element.append(title, list);
  parent.append(element);

  let count = 0;
  return ({ key }) => {
    ++count;
    element.hidden = false;
    title.textContent = `${count} missing chunk${count === 1 ? "" : "s"}`;
    const item = document.createElement("li");
    item.textContent = key;
    list.prepend(item);
    if (list.childElementCount > MAX_LISTED_CHUNKS) {
      list.lastElementChild!.remove();
    }
    return false;
  };
}

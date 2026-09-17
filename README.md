# Volumen

A board of cross-sections for Vesuvius Challenge scrolls. Pick a scroll, and a card on the board
shows a slice through it, downloading only the parts you look at. Every card has its own plane,
position and zoom, and cards can be linked so that they move together.

*Volumen* is the Latin word for a papyrus roll, and the word "volume" comes from it.

The viewer itself is [Neuroglancer Mini](https://github.com/tomhsiao1260/neuroglancer-mini), a
reduced copy of the [Neuroglancer](https://github.com/google/neuroglancer) source, kept here in
`viewer/` and explained in that project's README.

## What it does

- **A board of cards.** Double click the board to add a card, and click one to select it. Dragging
  the data pans the slice, the wheel steps through the slices and Ctrl and the wheel zooms one; a
  card is moved by the lines above and below it, or Alt and a drag, and resized by its corner. The
  board is panned by dragging the background or with two fingers, and zoomed with a pinch (or Ctrl
  and the wheel) — the cards get larger without showing more data.
- **Pick a scroll in two clicks.** A new card lists the samples of the Vesuvius Challenge, read from
  its open data bucket, then the scans of the one you pick — finest first, with the voxel size and
  the energy. Clicking a scan shows it, with the server keeping what you look at; the folder button
  on a scan keeps the files in a folder of yours instead, chosen by clicking through this machine's
  folders. Data outside the bucket can still be given by hand. Cards naming the same scan share one
  volume, one download and one set of textures.
- **Linked cards, by copy and paste.** Click a card to select it, then copy and paste: the new card
  sits beside it showing the same scan at the same place, and the two move together — change the
  copy's plane from XY to YZ and you have that place seen another way, with the slices of both moving
  as one. Paste again for a third. The ⛓ on a card says how many move with it, and a click takes it
  out. **+ linked x/y/z** puts all three planes down at once.
- **A card says what it is.** A card's frame is the data and nothing else, so it can be made square;
  the plane it shows, the scan it shows and the voxel it is looking at are written just above and
  just below the frame, over the board rather than over the data. All of it stays on screen, so a
  card can be read while working and carries its own caption in a screenshot. While the pointer is on
  a card the voxel under it takes the place of the card's own, in yellow, and the link, close and
  resize controls fade in with it. The board itself has no bars at all: a round button in the corner,
  and the same menu on a right click.
- **The board is kept.** Where the cards are, what they show, which are linked and where the board
  is panned to are stored in `server/db/json/board.json`, and are there again next time. Chunks
  neither store has (sparse scrolls have many) are simply drawn empty. If the browser takes the
  page's graphics away — it may, and everything on the GPU goes with them — the board builds itself
  a new viewer and puts the cards back where they were instead of asking for a reload.

## Running it

```bash
cd scripts
npm install
node start.js
```

This installs and builds the client, starts the server and opens the page: the client on port 4173,
the server on 3005 of this machine only. Then double click the board and pick a scroll — the data is
public, so no account is needed. A coarse scan (tens of micrometres per voxel) is a good place to
start; the finest scans are hundreds of gigabytes, of which you only ever download what you look at.

## Project structure

- `client/`: the page (Vite, plain DOM, one stylesheet). `src/board/` is the board — the cards
  (`card.ts`), their layout and pan and zoom (`board.ts`, `transform.ts`), the mouse input
  (`gestures.ts`), the board's own menu (`menu.ts`), the linked sets (`links.ts`), choosing what to
  show (`scroll_picker.ts`, `catalog.ts`, `sources.ts`), the symbols (`icons.ts`) and the saved board
  (`storage.ts`).
- `server/`: the zarr stores (Node, Express). `GET /api/data/<sourceId>/<key>` serves a file of a
  source, downloading it first if its folder does not have it; `/api/scrolls` lists the data bucket,
  `/api/folders` this machine's folders, and `/api/sources` and `/api/board` keep the sources and the
  board in `server/db/json/`.
- `viewer/`: the viewer library, a copy of Neuroglancer Mini's. Changes here should go back there
  too, so that the two stay the same.
- `scripts/start.js`: installs, builds, starts both and opens the page.
- `docs/whiteboard.md`: what the viewer needed for this board, and what the board does not do yet.

## License

`viewer/` is derived from [Neuroglancer](https://github.com/google/neuroglancer) and licensed under
the Apache License 2.0 (`viewer/LICENSE`, `viewer/NOTICE`).

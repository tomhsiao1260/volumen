# Volumen

A board of cross-sections for Vesuvius Challenge scrolls. Pick a scroll, and a card on the board
shows a slice through it, downloading only the parts you look at. Every card has its own plane,
position and zoom, and cards can be linked so that they move together.

*Volumen* is the Latin word for a papyrus roll, and the word "volume" comes from it.

The viewer itself is [Neuroglancer Mini](https://github.com/tomhsiao1260/neuroglancer-mini), a
reduced copy of the [Neuroglancer](https://github.com/google/neuroglancer) source, kept here in
`viewer/` and explained in that project's README.

## What it does

- **A board of cards.** Double click the board to add a card. Drag a card to move it, its corner to
  resize it, the background to pan, and the wheel over the background to zoom — the cards get larger
  without showing more data. Alt and a drag pans a slice, the wheel steps through slices, Ctrl and
  the wheel zooms one.
- **Pick a scroll in a few clicks.** A new card lists the scrolls of the Vesuvius Challenge, read
  from its open data bucket, then the scans of the one you pick — finest first, with the voxel size
  and the energy — and then asks only where the files should go: nowhere in particular, in which case
  the server keeps what you look at, or a folder of yours, chosen by clicking through this machine's
  folders. Data outside the bucket can still be given by hand. Cards naming the same scan share one
  volume, one download and one set of textures.
- **Linked cards.** Click the ⛓ in a card's header and then another card, and the two share a
  position and zoom: moving through the slices in one moves both, each along its own plane. **+
  linked x/y/z** adds three linked cards showing the XY, XZ and YZ planes.
- **The board is kept.** Where the cards are, what they show, which are linked and where the board
  is panned to are stored in `server/db/json/board.json`, and are there again next time. Chunks
  neither store has (sparse scrolls have many) are drawn empty and listed in the corner.

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
  (`storage.ts`). `src/app/` holds the coordinate readout and the missing-chunk list.
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

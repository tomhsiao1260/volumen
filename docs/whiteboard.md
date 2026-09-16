# A whiteboard of views

Notes on the feature this project is built around: instead of Neuroglancer Mini's three
cross-sections in a fixed row, the page is a board of cards, each card a cross-section of a volume
that can be added, removed, moved and resized, and that keeps its own position and zoom while the
board itself pans and zooms.

These notes say what the viewer in `viewer/` already supported, what had to change, and which parts
of it must therefore stay as they are — worth reading before trimming that library further, since it
is kept as small as possible in its own project.  Line references are to the viewer as of this
writing.

## Where this stands

The board itself is built (`client/src/board/`), and the viewer changes it needed are in:

- **A volume is its own object.**  `viewer.addVolume(store)` returns a `Volume` with its own
  coordinate space and render layer, so one viewer can hold several volumes — one worker, one chunk
  manager and one set of memory limits for all of them.  Chunk sources are keyed by volume as well
  as by scale path, without which two volumes silently shared one another's chunks.
- **A position and zoom per card.**  `new NavigationGroup(volume)` owns a position and a zoom, and
  `viewer.addView(element, { volume, orientation, navigation })` gives a view its group.  Views
  handed the same group move together, which is how linked cards will work.
- **A canvas per card.**  The viewer draws every slice into one surface that is not in the page and
  copies each card's rectangle into a canvas inside the card (option 3 below).  Cards are therefore
  ordinary elements: rounded corners, shadows, overlap, z-order and clipping all work, the board's
  background shows through between them, and panning the board costs nothing at all, because the
  canvases move with the cards.
- **Zoom that magnifies.**  A panel measures the CSS scale of its ancestors
  (`getBoundingClientRect().width / offsetWidth`) and divides its zoom by it, so a card on a zoomed
  board shows the same data larger, at the resolution it is displayed at, and picks finer scales as
  it grows.  `viewer.invalidateBounds()` tells the viewer to measure again after a zoom.
- **The page can take the input.**  `view.handleInput` declines any event the board wants for
  itself, and `view.stepSlices`, `view.translateByViewportPixels`, `view.zoomByMouse` and
  `view.pointAt` let it drive the slice instead.

Each card also names its own data source, which the server serves per source
(`server/src/utils/sources.ts`), and cards naming the same source share one volume, one download and
one set of textures.

Cards can also be linked: the cards of a group share one `NavigationGroup`, so they move together,
and the group is created from the first volume one of its members shows, which is what the shared
position is clamped against (`client/src/board/links.ts`).

The board itself is kept on the server (`client/src/board/storage.ts`,
`server/src/utils/board.ts`): the cards, their sources and planes, the linked sets and where each is
looking, and the board's pan and zoom.

That is everything these notes set out to build.  What the board does not have yet, in no particular
order: selecting several cards at once, a card's own missing-chunk list and readout, more than one
board, per-card memory limits, and honouring `devicePixelRatio` so that a zoomed-in card is as sharp
as the screen allows.

## What already works

- **Adding and removing views at runtime.**  `viewer.addView(element, orientation)` returns a view
  with `dispose()`; the element itself is left alone.  Removing a view stops its chunk requests, and
  re-adding it draws the same picture again — Neuroglancer Mini verifies exactly this.
- **Any CSS layout.**  One canvas fills the viewer's container (`render/panel.ts`,
  `DisplayContext`), and each view draws into the rectangle its own element occupies: the panel
  measures `element.getBoundingClientRect()` against the canvas and sets the GL viewport and scissor
  to that region (`SliceViewPanel.ensureBoundsUpdated`, `setGLClippedViewport`).  Cards can
  therefore sit anywhere, in any size, and a CSS scale on an ancestor is picked up automatically.
  A `ResizeObserver` watches the container and every panel element, so moving or resizing a card
  redraws it.
- **One download per chunk, whatever the layout.**  All views share one worker, one chunk manager
  and, per scale, one chunk source (`chunk_manager/frontend.ts`, `getChunkSource`, keyed by the
  scale's path), and one GPU texture per chunk.  Two cards looking at the same region cost one
  download and one texture.
- **Per-view projection.**  Each view already has its own projection parameters, its own worker-side
  counterpart and its own velocity estimator for prefetching (`render/frontend.ts`,
  `render/backend.ts`).  Independent cards are, inside the viewer, already the normal case.

## What it needed

The analysis the changes above were made from, roughly in order of effort.

1. **A position and zoom per card.**  Today `Viewer` owns one position and one zoom and hands them
   to every view (`viewer.ts`, `sharedPosition` / `sharedZoom`).  Internally each view already gets
   its own `NavigationState`, so giving each card its own state is a few lines; the work is in the
   public API, which currently exposes `viewer.position`, `viewer.setPosition`, `viewer.zoom`,
   `viewer.setZoom` and `viewer.onViewChanged` at the viewer level.  Those would move to the view
   returned by `addView`, and this project's `src/app/position_display.ts` and
   `src/app/url_position.ts` would follow (the URL would carry the board, not one position).
2. **Deciding who gets the gesture.**  A card's drag pans its slice and its wheel steps through
   slices (`render/panel.ts`), and those handlers stop propagation.  The board needs its own pan and
   zoom, so there has to be a rule: a modifier key, a mode, or a drag handle on the card's chrome.
3. **Cards that are off screen must cost nothing.**  On a board most cards are scrolled out of view
   or hidden behind a panel, but a view that is not visible still requests its chunks today.
   Neuroglancer has a mechanism for this (its `visibility_priority`: an invisible view requests
   nothing, and a partly relevant one requests at the PREFETCH tier instead of VISIBLE).  It is back
   (`SliceViewPanel.visibility`: a card off the board requests nothing), but the shared limits are
   still global: 100 downloads at a time, 2 GB of system memory and
   1 GB of GPU memory (`viewer.ts`).  Thirty cards looking at thirty regions would otherwise fight
   over them.
4. **Card chrome, overlap and clipping.**  One canvas behind the cards cannot do rounded corners,
   shadows, cards overlapping each other, or a card clipped by a scrolling container: the view draws
   its full rectangle regardless of what the DOM does on top of it.  Three ways out:
   - Keep the single canvas, and accept that cards are plain, non-overlapping rectangles.  Cheapest.
   - Give each card its own canvas.  Do not: each canvas is a separate WebGL context, browsers allow
     only a handful, and textures cannot be shared between contexts, so every card would hold its
     own copy of every chunk.
   - Keep the single (offscreen) canvas and copy each card's rectangle into a small 2-D canvas in the
     card itself.  The card is then an ordinary DOM element that can be styled, layered and clipped
     freely, at the cost of one copy per card per frame.  This is the direction to take if the cards
     need to look like cards.
5. **Cards showing different volumes.**  A `Viewer` is built around one volume today (`store` in the
   constructor, one render layer).  Showing different scrolls side by side means loading several
   volumes in one viewer and letting a view choose one — the chunk manager is already per-source, so
   this is mostly API work.  Opening several `Viewer`s instead would mean several workers and
   several memory budgets, and chunks shared by two boards would be downloaded twice.

## What must not be trimmed away

The viewer in `viewer/` is kept as small as possible, which is the point of Neuroglancer Mini, but
these parts are what make the board above possible:

- The **arbitrary slice orientation** (the box-plane intersection in `render/renderlayer.ts`).  It
  costs ~130 lines and could be replaced by axis-aligned quads, but it is what lets each card have
  its own orientation, including oblique ones.
- **Panel-relative viewports** (`RenderViewport`, the canvas-relative bounds and the scissor logic).
  Collapsing them into "the canvas is the view" would remove the seam that cards draw through, and
  the seam the per-card copy in option 4 above would hook into.
- **Per-view projection parameters and worker counterparts**, and with them the assumption that each
  view has its own pixel size and so its own choice of scales.
- **Navigation state as a separate object** per view, rather than folded into `Viewer`.
- **Chunk sources shared by scale path**, which is what keeps many cards cheap.

Two items on the trimmed viewer's "optional to restore" list stop being optional here: the
visibility priority of item 3, and honouring a zarr array's `fill_value` (cards will look at sparse
regions, where the fill value is what should be shown).

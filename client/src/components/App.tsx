/**
 * @file A board of cross-sections.
 *
 * The board starts empty.  A double click adds a card, which asks which scan to show — the Vesuvius
 * Challenge data bucket, a few clicks deep — and then draws it, downloading only what is looked at.
 * Cards naming the same scan share one volume, linked cards share a position and zoom, and the whole
 * board is kept on the server.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { listSources } from "../api/sources";
import { createBoardStore, loadBoard } from "../api/storage";
import { useBoardGestures } from "../board/gestures";
import { newGroupId } from "../board/links";
import type { GroupPlace } from "../board/session";
import { Session } from "../board/session";
import type { BoardState, CardState } from "../board/state";
import {
  boardReducer,
  CARD_HEIGHT,
  CARD_WIDTH,
  emptyBoard,
  groupSize,
  serialize,
} from "../board/state";
import { cssTransform, toBoard } from "../board/transform";
import type { Point } from "viewer";
import { BoardMenu } from "./BoardMenu";
import { CardView } from "./CardView";
import { SurfaceCardView } from "./SurfaceCardView";

// A lost context is worth rebuilding through, up to this many times in `RECOVERY_WINDOW_MS`; beyond
// that the page is asking for a graphics context it cannot keep, and rebuilding makes it worse.
const RECOVERIES = 3;
const RECOVERY_WINDOW_MS = 120_000;
const NOTICE_MS = 6_000;

interface Notice {
  text: string;
  // Whether the only way on is to load the page again.
  reload: boolean;
}

export function App() {
  const [board, setBoard] = useState<HTMLDivElement | null>(null);
  const [marquee, setMarquee] = useState<HTMLDivElement | null>(null);
  const [state, dispatch] = useReducer(boardReducer, emptyBoard);
  const [session, setSession] = useState<Session | null>(null);
  // Bumped when the viewer is replaced, so that every card adds its view to the new one.
  const [generation, setGeneration] = useState(0);
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | undefined>(
    undefined,
  );
  const [notice, setNotice] = useState<Notice | undefined>(undefined);
  const [restored, setRestored] = useState(false);

  // A drag reads the state between renders, and the store serializes it when a save is due.
  const latest = useRef<BoardState>(state);
  latest.current = state;
  const current = useCallback(() => latest.current, []);
  const sessionRef = useRef<Session | null>(null);
  const places = useRef<Map<string, GroupPlace> | undefined>(undefined);
  const restoredRef = useRef(false);
  restoredRef.current = restored;

  const store = useMemo(
    () =>
      createBoardStore({
        serialize: () =>
          serialize(latest.current, sessionRef.current?.places() ?? new Map()),
        onConflict: () =>
          setNotice({
            text: "This board changed elsewhere. Reload to see it.",
            reload: true,
          }),
      }),
    [],
  );

  // The viewer, the volumes and the linked groups, which outlive any render.
  useEffect(() => {
    if (board === null) return;
    const created = new Session(board);
    sessionRef.current = created;
    setSession(created);
    return () => {
      sessionRef.current = null;
      created.dispose();
    };
  }, [board]);

  /*
   * A browser may take a page's WebGL context away at any time, usually because it or another tab
   * asked for too much of the GPU, and everything on the GPU goes with it.  Rather than making the
   * user reload and lose what is on screen, the board starts again on a new viewer and puts its
   * cards back where they were.
   */
  const recoveries = useRef(0);
  const recoveryTimer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (session === null || board === null) return;
    const off = session.viewer.onContextLost(() => {
      if (++recoveries.current > RECOVERIES) {
        setNotice({
          text: "The graphics context keeps being lost. Reload the page.",
          reload: true,
        });
        return;
      }
      window.clearTimeout(recoveryTimer.current);
      recoveryTimer.current = window.setTimeout(
        () => (recoveries.current = 0),
        RECOVERY_WINDOW_MS,
      );
      places.current = session.places();
      session.dispose();
      const next = new Session(board);
      sessionRef.current = next;
      setSession(next);
      setGeneration((value) => value + 1);
      setNotice({
        text: "The graphics context was lost and rebuilt.",
        reload: false,
      });
    });
    return () => {
      off();
    };
  }, [session, board]);

  /*
   * A group that has just been made looks at the center of its volume until it is told otherwise.
   * Whenever something knows better — a board read from the server, a card taken out of its group, a
   * viewer built after a lost context — it leaves the place here, and this runs once the cards have
   * made the groups, which their own effects do before this one.
   */
  useEffect(() => {
    const waiting = places.current;
    if (waiting === undefined || session === null) return;
    places.current = undefined;
    session.restore(waiting);
  });

  // A notice about something that has been dealt with says so and goes away again.
  useEffect(() => {
    if (notice === undefined || notice.reload) return;
    const timer = window.setTimeout(() => setNotice(undefined), NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // The board as the server has it, with the sources its cards name.
  useEffect(() => {
    Promise.all([loadBoard(), listSources()]).then(
      ([stored, sources]) => {
        places.current = new Map(
          stored.groups.map((group) => [
            group.id,
            { position: group.position, zoom: group.zoom },
          ]),
        );
        dispatch({ type: "restore", board: stored, sources });
        store.revision = stored.rev;
        setRestored(true);
      },
      (error: Error) => {
        console.error("Failed to read the board:", error);
        // The board is still usable; it just will not be saved.
        setNotice({
          text: "Could not read the board from the server. See the browser console.",
          reload: false,
        });
      },
    );
  }, [store]);

  // Every change is saved, a moment after it stops changing.
  useEffect(() => {
    if (restored) store.schedule();
  }, [state, restored, store]);

  useEffect(() => {
    const onHide = () => store.saveOnUnload();
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
  }, [store]);

  // Zooming the board changes how much of the volume a pixel covers, which the viewer has to
  // measure again; panning does not, since each slice is drawn in a canvas inside its card.
  useEffect(() => {
    session?.viewer.invalidateBounds();
  }, [session, state.view.scale]);

  useBoardGestures({ element: board, marquee, state: current, dispatch });

  // A handle for tests, and for looking at the board from the console.
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has("debug")) return;
    Object.assign(window, {
      volumen: {
        get state() {
          return latest.current;
        },
        get viewer() {
          return sessionRef.current?.viewer;
        },
        get session() {
          return sessionRef.current;
        },
        dispatch,
      },
    });
  }, []);

  // A card leaving its group keeps the place it was looking at, rather than jumping to the middle of
  // the volume.
  /*
   * Marks a place for the card's group: the slices move to it, so that every card of the group is
   * looking at the same voxel, and each draws it.  The move is the group's shared position, which is
   * what makes "the other cards go there" nothing more than what linked cards already do.
   */
  const mark = (card: CardState, at: Point | null) => {
    dispatch({ type: "mark", groupId: card.groupId, at });
    if (at !== null) sessionRef.current?.group(card.groupId).navigation?.setPosition(at);
  };

  const unlink = (card: CardState) => {
    const groupId = newGroupId();
    const place = sessionRef.current?.places().get(card.groupId);
    if (place !== undefined) places.current = new Map([[groupId, place]]);
    dispatch({ type: "unlink", id: card.id, groupId });
  };

  const centreOfBoard = () => {
    const bounds = board?.getBoundingClientRect();
    if (bounds === undefined) return { x: 0, y: 0 };
    return toBoard(latest.current.view, bounds.width / 2, bounds.height / 2);
  };

  return (
    <div
      id="board"
      ref={setBoard}
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest(".menu") === null) {
          setMenuAt(undefined);
        }
      }}
      onContextMenu={(event) => {
        if ((event.target as HTMLElement).closest(".card") !== null) return;
        event.preventDefault();
        const bounds = event.currentTarget.getBoundingClientRect();
        setMenuAt({
          x: event.clientX - bounds.left,
          y: event.clientY - bounds.top,
        });
      }}
    >
      <div
        id="board-layer"
        style={{ transform: cssTransform(state.view) }}
      >
        {session !== null &&
          state.cards.map((card) => {
            const source =
              card.sourceId === null ? undefined : state.sources[card.sourceId];
            return card.kind === "surface" ? (
              <SurfaceCardView
                key={card.id}
                card={card}
                source={source}
                hue={state.hues[card.groupId] ?? 0}
                selected={state.selection.includes(card.id)}
                linked={groupSize(state, card)}
                mark={state.marks[card.groupId]}
                dispatch={dispatch}
                onUnlink={() => unlink(card)}
                onMark={(at) => mark(card, at)}
              />
            ) : (
              <CardView
                key={card.id}
                card={card}
                source={source}
                hue={state.hues[card.groupId] ?? 0}
                selected={state.selection.includes(card.id)}
                linked={groupSize(state, card)}
                session={session}
                generation={generation}
                dispatch={dispatch}
                onLooked={() => restoredRef.current && store.schedule()}
                onUnlink={() => unlink(card)}
                mark={state.marks[card.groupId]}
                onMark={(at) => mark(card, at)}
                onOpenSurface={(seed) =>
                  dispatch({
                    type: "addSurfaceCard",
                    from: card.id,
                    seed,
                    // At the scale the slice is seen at.
                    zoom: sessionRef.current?.group(card.groupId).navigation?.zoom ?? 1,
                  })
                }
              />
            );
          })}
      </div>

      <div id="board-marquee" ref={setMarquee} hidden />

      {state.cards.length === 0 && (
        <div id="board-hint">Double-click to add a card</div>
      )}

      <BoardMenu
        at={menuAt}
        onClose={() => setMenuAt(undefined)}
        onOpenAt={setMenuAt}
        onNewCard={() => {
          const at = centreOfBoard();
          dispatch({
            type: "addCard",
            at: { x: at.x - CARD_WIDTH / 2, y: at.y - CARD_HEIGHT / 2 },
          });
        }}
        onFit={() => {
          const bounds = board?.getBoundingClientRect();
          if (bounds === undefined) return;
          dispatch({
            type: "fitToCards",
            size: { width: bounds.width, height: bounds.height },
          });
        }}
      />

      {notice !== undefined && (
        <div className="notice">
          {notice.text}
          {notice.reload && (
            <button onClick={() => window.location.reload()}>Reload</button>
          )}
        </div>
      )}
    </div>
  );
}

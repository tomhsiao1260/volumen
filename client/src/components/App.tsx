/**
 * @file A board of cross-sections.
 *
 * The board starts empty.  A double click adds a card, which asks which scan to show — the Vesuvius
 * Challenge data bucket, a few clicks deep — and then draws it, downloading only what is looked at.
 * Cards naming the same scan share one volume, linked cards share a position and zoom, and the whole
 * board is kept on the server.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { Source } from "../api/sources";
import { listSources, scanOf } from "../api/sources";
import { createBoardStore, loadBoard } from "../api/storage";
import { useBoardGestures } from "../board/gestures";
import { newGroupId } from "../board/links";
import type { GroupPlace } from "../board/session";
import { Session } from "../board/session";
import type { BoardState, CardState, PickedPoint } from "../board/state";
import {
  boardReducer,
  CARD_HEIGHT,
  CARD_WIDTH,
  emptyBoard,
  groupSize,
  serialize,
} from "../board/state";
import { cssTransform, toBoard } from "../board/transform";
import { drawnDotsOf, sheetsOf, spotsOf } from "../surface/layers";
import { chain, chainsOf, forgetChain, loadChains, newChainId, setChain, watchChains } from "../surface/windings";
import type { Point } from "viewer";
import type { ChainSaid, SurfaceFacts } from "../surface/types";
import { BoardMenu } from "./BoardMenu";
import { Rail } from "./Rail";
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
  // How many winding points this session has placed, to keep their ids apart within a millisecond.
  const placed = useRef(0);
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
        // What the surface cards have found, which a test can measure a piece against.
        sheets: (sourceId: string) => sheetsOf(sourceId),
        // Where each winding point falls on a card's piece, as the card itself has it.
        spots: (cardId: string) => Object.fromEntries(spotsOf(cardId)),
        // And which of them it drew, the last time it drew.
        drawnDots: (cardId: string) => drawnDotsOf(cardId),
        get heard() {
          return heardRef.current;
        },
        dispatch,
      },
    });
  }, []);

  /*
   * What the surface cards are told: the chains of a scan that are switched on and finished with.
   * The one being drawn is left out until it is closed, so that a card is not rebuilt under the hand
   * of the person placing its points.  `chainsMoved` is what brings a change here: the store is not
   * React state, so the count is what makes the page look again.
   */
  /*
   * What the flattened cards are told, and WHEN.
   *
   * Building a piece takes seconds, and rebuilding it the moment each annotation is finished takes the
   * card out from under the person in the middle of a run of them: they meant to mark four things and
   * got one, then a wait, then a card that has moved.  So while a winding tool is in hand the pieces
   * are left alone, whatever is drawn; going back to the arrow — V, or Escape — is what says "now look
   * at what I said".  It also makes the moment of rebuilding a thing the person chose rather than a
   * thing that happened to them.
   */
  const told = useRef(new Map<string, { chains: ChainSaid[]; at: number }>());
  const said = (source: Source | undefined): ChainSaid[] => {
    if (source === undefined) return [];
    const scan = scanOf(source);
    const frozen = told.current.get(scan);
    if (state.tool !== "look" && frozen !== undefined) return frozen.chains;
    return chainsOf(scan)
      .filter((one) => one.on && one.id !== state.adding && one.points.length > 1)
      .map((one) => ({
        id: one.id,
        rev: one.rev,
        kind: one.kind,
        points: one.points.map((point) => ({
          at: [point.at.z, point.at.y, point.at.x] as [number, number, number],
          turn: point.turn,
          ...(point.of === undefined ? {} : { of: point.of }),
        })),
      }));
  };
  /*
   * Whether anything has been said that the pieces have not been told yet.  A card that is quietly a
   * few annotations out of date looks exactly like a card that has ignored them, so it says so.
   */
  const waiting = (source: Source | undefined) =>
    source !== undefined && state.tool !== "look" && (told.current.get(scanOf(source))?.at ?? chainsMoved) !== chainsMoved;

  // What was last handed over, per scan, so that the same thing can be handed over again while a
  // winding tool is out and the pieces are to be left alone.
  useEffect(() => {
    if (state.tool !== "look") return;
    for (const card of state.cards) {
      const source = card.sourceId === null ? undefined : state.sources[card.sourceId];
      if (source !== undefined) told.current.set(scanOf(source), { chains: said(source), at: chainsMoved });
    }
  });

  // Bumped when a chain changes, so that the cards are given the new one.
  const [chainsMoved, setChainsMoved] = useState(0);
  // The chain the pointer is over in the list, which the cards draw loudly while it is.
  const [lit, setLit] = useState<string | undefined>(undefined);
  /*
   * What the pieces made of each chain: which sheet it was answered on, how many sheets its points
   * were found spread over, and how far the fit ended from the furthest of them.  Kept by chain, the
   * last piece to be built winning, so that the list can say whether a chain was any use.
   */
  const [heard, setHeard] = useState<Record<string, SurfaceFacts["heard"][0]>>({});
  const heardRef = useRef(heard);
  useEffect(() => {
    heardRef.current = heard;
  }, [heard]);
  useEffect(() => watchChains(() => setChainsMoved((moved) => moved + 1)), []);

  // Everything said about the scans the board is showing, for the list in the rail.
  const onTheBoard = () => {
    const scans = new Set(
      state.cards
        .map((card) => (card.sourceId === null ? undefined : state.sources[card.sourceId]))
        .filter((source): source is Source => source !== undefined)
        .map(scanOf),
    );
    return [...scans].flatMap((scan) => chainsOf(scan));
  };

  // What has been said about the papyrus of each scan on the board, read once per scan.
  useEffect(() => {
    for (const source of Object.values(state.sources)) {
      const scan = scanOf(source);
      if (scan !== "") void loadChains(scan);
    }
  }, [state.sources]);

  // A card leaving its group keeps the place it was looking at, rather than jumping to the middle of
  // the volume.

  /**
   * Puts a winding point down for the card's scan.  The first point of a chain starts it; the rest
   * join it, counted outward one wrap at a time, until the chain is closed by Enter, Escape or a
   * change of tool.  Which wrap each point is does not have to be told to us: along a chain it is
   * the order they were placed in, and only the differences are a constraint anyway — that is how
   * the community's relative-winding collections are defined.
   */
  const place = (card: CardState, at: Point) => {
    const kind = latest.current.tool === "same" ? "same" : "step";
    const source = card.sourceId === null ? undefined : latest.current.sources[card.sourceId];
    const scan = source === undefined ? "" : scanOf(source);
    if (scan === "") return;
    const drawing = latest.current.adding === undefined ? undefined : chain(latest.current.adding);
    // A chain says one thing about one scan: a point of another kind, or on another scan, starts a
    // chain of its own rather than being appended to whatever was open.
    const open = drawing?.kind === kind && drawing.scan === scan ? drawing : undefined;
    const madeAt = Date.now();
    // Two points placed in the same millisecond would otherwise share an id, and the surface cards
    // keep their answers about points in one map keyed by it, across every chain.
    const point = {
      id: `${madeAt}-${(placed.current += 1)}`,
      at: { x: at.x, y: at.y, z: at.z },
      // No wrap counted, on either kind.  A relative winding says its points are on different wraps;
      // how many wraps apart they are is a thing to add when there is a need for it, and until then
      // asking for it would be asking for what the person cannot see.
      turn: null,
      madeAt,
    };
    const saved = setChain(
      open === undefined
        ? {
            id: newChainId(),
            scan,
            kind,
            points: [point],
            on: true,
            note: "",
            author: "",
            rev: 0,
            madeAt,
          }
        : { ...open, points: [...open.points, point] },
    );
    if (open === undefined) dispatch({ type: "adding", chainId: saved.id });
  };

  /**
   * A press with a winding tool on a point already down.
   *
   * Saying "these are the same winding" of two annotations drawn at different times is done by
   * drawing through them: a point of theirs pressed while a chain is being drawn says that place is
   * on this winding too, and a place cannot be on two windings, so the two chains are one.  They are
   * merged there and then — the points of the chain pressed are taken into the one being drawn and it
   * is gone — which is what makes the two groups turn one colour on the cards.
   *
   * Pressed before anything is being drawn, it takes up that chain instead: the next point put down
   * carries on the same winding rather than starting another.
   */
  const join = (card: CardState, at: PickedPoint) => {
    const kind = latest.current.tool === "same" ? "same" : "step";
    const source = card.sourceId === null ? undefined : latest.current.sources[card.sourceId];
    const scan = source === undefined ? "" : scanOf(source);
    const touched = chain(at.chain);
    const place = touched?.points.find((point) => point.id === at.point);
    if (touched === undefined || place === undefined || touched.scan !== scan) return;
    const drawing = latest.current.adding === undefined ? undefined : chain(latest.current.adding);
    const open = drawing?.kind === kind && drawing.scan === scan ? drawing : undefined;

    /*
     * A relative winding drawn through a place does not take that place's chain in — it points at it.
     * Saying "these two are different wraps" is a relation between two groups, and a relation is not a
     * merger: both groups stay as they are, drawn as they were, and what is written down is a point of
     * the relative winding that names the place it was put on.
     */
    if (kind === "step") {
      const madeAt = Date.now();
      const point = {
        id: `${madeAt}-${(placed.current += 1)}`,
        at: { ...place.at },
        turn: null,
        of: { chain: touched.id, point: place.id },
        madeAt,
      };
      const saved = setChain(
        open === undefined
          ? { id: newChainId(), scan, kind, points: [point], on: true, note: "", author: "", rev: 0, madeAt }
          : { ...open, points: [...open.points, point] },
      );
      if (open === undefined) dispatch({ type: "adding", chainId: saved.id });
      return;
    }

    // And a same winding drawn through a place does take it in: a place cannot be on two windings, so
    // the chain it belonged to and the chain being drawn are one and the same.
    if (touched.kind !== kind) return;
    if (open === undefined) {
      dispatch({ type: "adding", chainId: touched.id });
      return;
    }
    if (open.id === touched.id) return;
    setChain({ ...open, points: [...open.points, ...touched.points] });
    forgetChain(touched.id);
  };

  /**
   * Taking hold of a winding point takes the cards to it.
   *
   * A place annotated is a place worth looking at, and looking at it means all of it: the slices move
   * to the slice it is on, and every flattened card turns to the wrap it is on — where the rest of its
   * chain is then drawn, which is the whole of what "are these really one wrap?" looks like.  The
   * flattened cards are asked where the point is rather than told: their own answers are what decides
   * where its dot is drawn, so what a card turns to and what it then shows cannot disagree.
   */
  const pick = (card: CardState, held: PickedPoint | undefined) => {
    dispatch({ type: "pick", picked: held });
    if (held === undefined) return;
    const place = chain(held.chain)?.points.find((point) => point.id === held.point);
    if (place === undefined) return;
    sessionRef.current?.group(card.groupId).navigation?.setPosition(place.at);
    for (const one of latest.current.cards) {
      if (one.kind !== "surface") continue;
      const w = spotsOf(one.id).get(held.point)?.w;
      if (w !== undefined) dispatch({ type: "setSurfaceLayer", id: one.id, w: Math.round(w) });
    }
  };

  /*
   * Removes the winding point being held, and the chain with it once its last point is gone.  It is
   * the only way a chain is edited: a point is taken hold of and taken away, and another put down —
   * which is what VC3D does for the same thing, and what makes a wrong point cost one press.
   */
  const removePicked = () => {
    const picked = latest.current.picked;
    if (picked === undefined) return;
    const one = chain(picked.chain);
    if (one !== undefined) {
      const points = one.points.filter((point) => point.id !== picked.point);
      if (points.length === 0) forgetChain(one.id);
      else setChain({ ...one, points });
    }
    dispatch({ type: "pick", picked: undefined });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Delete" && event.key !== "Backspace") return;
      if (latest.current.picked === undefined) return;
      if ((event.target as HTMLElement | null)?.closest?.("input, textarea") != null) return;
      event.preventDefault();
      removePicked();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // `removePicked` reads everything it needs from the refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    <>
      <Rail
        tool={state.tool}
        onTool={(tool) => dispatch({ type: "setTool", tool })}
        chains={onTheBoard()}
        adding={state.adding}
        lit={lit}
        heard={heard}
        onLit={setLit}
        onShow={(id, on) => {
          const one = chain(id);
          if (one !== undefined) setChain({ ...one, on });
        }}
        onGo={(id) => {
          /*
           * To the wrap this chain is on, taken from each card's own answers about its points — the
           * very numbers that decide where the points are drawn, so what the card turns to and what
           * it then shows cannot disagree.  The fit's `sheet` cannot be used for this: it counts from
           * the wrap the piece was BUILT on, and turning the wheel within a built piece does not
           * rebuild it, so moments later it is a wrap or two out.
           */
          const one = chain(id);
          if (one === undefined) return;
          for (const card of state.cards) {
            if (card.kind !== "surface") continue;
            const source = card.sourceId === null ? undefined : state.sources[card.sourceId];
            if (source === undefined || scanOf(source) !== one.scan) continue;
            const spots = spotsOf(card.id);
            const ws = one.points
              .map((point) => spots.get(point.id)?.w)
              .filter((w): w is number => w !== undefined)
              .sort((a, b) => a - b);
            if (ws.length > 0) dispatch({ type: "setSurfaceLayer", id: card.id, w: Math.round(ws[ws.length >> 1]) });
          }
        }}
        onRemove={(id) => {
          forgetChain(id);
          if (state.adding === id) dispatch({ type: "adding", chainId: undefined });
        }}
      />
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
                chains={said(source)}
                behind={waiting(source)}
                lit={lit}
                tool={state.tool}
                scan={source === undefined ? "" : scanOf(source)}
                picked={state.picked}
                dispatch={dispatch}
                onUnlink={() => unlink(card)}
                onPlace={(at) => place(card, at)}
                onJoin={(at) => join(card, at)}
                onPick={(held) => pick(card, held)}
                onHeard={(said) =>
                  setHeard((was) => {
                    const now = { ...was };
                    for (const one of said) now[one.chain] = one;
                    return now;
                  })
                }
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
                tool={state.tool}
                scan={source === undefined ? "" : scanOf(source)}
                picked={state.picked}
                lit={lit}
                onPlace={(at) => place(card, at)}
                onJoin={(at) => join(card, at)}
                onPick={(held) => pick(card, held)}
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
    </>
  );
}

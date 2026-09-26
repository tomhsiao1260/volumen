/**
 * @file The tool rail: what a press on the data does.
 *
 * It floats over the board rather than taking a column of it, and it is a sibling of `#board` rather
 * than a child, so that a press on it is never also a press on the board underneath.
 *
 * The tools are the community's, and so are their keys and colours: Q for same-winding, E for
 * relative-winding, as VC3D has them (`SpiralPclRole.hpp`).  Someone who has annotated a scroll
 * before should not have to learn new ones here.
 */

import { useState } from "react";
import type { ReactNode } from "react";
import type { Tool } from "../board/state";
import { chainColour, type WindChain } from "../surface/windings";

interface Choice {
  tool: Tool;
  key: string;
  title: string;
  hint: string;
  // The colour this tool draws in, which the icon wears and the button takes when it is picked: the
  // rail says what is about to appear on the cards, in the colour it will appear in.
  tint?: string;
  icon: ReactNode;
}

// The arrow every board has, and the two things a person can say about the sheets.
const CHOICES: Choice[] = [
  {
    tool: "look",
    key: "V",
    title: "Move",
    hint: "Move cards and read the data",
    icon: (
      <svg viewBox="0 0 24 24" className="rail-icon" aria-hidden>
        <path d="M6 3.2 L18.2 12.6 L12.4 13.3 L15.3 19.4 L12.7 20.6 L9.8 14.4 L6 18.3 Z" />
      </svg>
    ),
  },
  /*
   * The two icons are a pair, and the pair is the explanation: dots lying along one sheet, against
   * dots stepping across several.  The sheets are drawn faintly and the dots in the colour that tool
   * puts on the cards, so the rail says which is which without a word.
   */
  {
    tool: "same",
    key: "Q",
    // The names are the community's — `same_windings.json`, `relative_windings.json` — so that what
    // is made here can be talked about in the words it will be shared in.  A wrap is one turn of the
    // scroll; the sheet is the papyrus it is made of, and a scroll is one sheet wrapped many times.
    title: "Same winding",
    hint: "Click points that all lie on the same wrap of the sheet",
    tint: "#32ffd7",
    icon: (
      <svg viewBox="0 0 24 24" className="rail-icon" aria-hidden>
        <path d="M2.8 14.4 C 7 9.6, 17 9.6, 21.2 6.2" className="rail-sheet" />
        <circle cx="5.4" cy="12.3" r="2.1" className="rail-spot" />
        <circle cx="12" cy="10.5" r="2.1" className="rail-spot" />
        <circle cx="18.6" cy="8.2" r="2.1" className="rail-spot" />
      </svg>
    ),
  },
  {
    tool: "step",
    key: "E",
    title: "Relative winding",
    hint: "Click one point on each wrap, counting outward — it sets how far apart the wraps are",
    tint: "#ffaa32",
    icon: (
      <svg viewBox="0 0 24 24" className="rail-icon" aria-hidden>
        <path d="M3 6 H21 M3 12 H21 M3 18 H21" className="rail-sheet" />
        <circle cx="9.2" cy="6" r="2.1" className="rail-spot" />
        <circle cx="12" cy="12" r="2.1" className="rail-spot" />
        <circle cx="14.8" cy="18" r="2.1" className="rail-spot" />
      </svg>
    ),
  },
];

// What the picked tool is for, said where the hand is.  A tool nobody can guess the use of is a tool
// nobody uses, and this one is a sentence long.
const HINTS: Partial<Record<Tool, string>> = {
  same: "Click along one wrap · Enter finishes · click a point and press Delete to remove it",
  step: "Click outward, one point on each wrap · Enter finishes · click a point and press Delete to remove it",
};

export interface RailProps {
  tool: Tool;
  onTool: (tool: Tool) => void;
  // Everything said about the scans on the board, newest last, and the one being drawn.
  chains: WindChain[];
  adding: string | undefined;
  // The chain the pointer is over, which the cards draw loudly while it is.
  lit: string | undefined;
  // What the pieces made of each chain, by chain id.
  heard: Record<string, { sheet: number; sheets: number; used: number; of: number; worst: number; moved: number }>;
  onLit: (id: string | undefined) => void;
  onShow: (id: string, on: boolean) => void;
  // Turns the flattened cards to the wrap this chain was answered on, which is how a person sees for
  // themselves that the whole chain is one wrap: on that card the points are there, and on the next
  // one along they are gone.
  onGo: (id: string) => void;
  // Puts a chain on a named layer, or hands it back to the fit with null.  Only sameness and
  // difference of the names mean anything, never their order.
  onLayer: (id: string, layer: string | null) => void;
  onRemove: (id: string) => void;
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");

export function Rail({ tool, onTool, chains, adding, lit, heard, onLit, onShow, onGo, onLayer, onRemove }: RailProps) {
  const [listing, setListing] = useState(false);
  /*
   * Pressing the button walks a fixed ring: no name, then A, B, C … one for every chain there is, and
   * round to no name again.  Fixed on purpose — a ring built from the names currently in use changes
   * under the press that changes them, and two chains can then swap names forever without either ever
   * reaching the end of it.  Long enough that any chain can be put on any other chain's layer.
   */
  const ring: (string | null)[] = [null, ...LETTERS.slice(0, Math.max(2, chains.length))];
  const after = (now: string | null) => ring[(ring.indexOf(now) + 1) % ring.length] ?? null;
  const says = HINTS[tool];
  return (
    <>
      <div id="rail">
        {CHOICES.map((choice) => (
          <button
            key={choice.tool}
            type="button"
            className={`rail-tool${tool === choice.tool ? " picked" : ""}`}
            style={choice.tint === undefined ? undefined : ({ ["--tint" as string]: choice.tint })}
            data-tool={choice.tool}
            title={`${choice.title} (${choice.key}) — ${choice.hint}`}
            aria-pressed={tool === choice.tool}
            onClick={() => onTool(choice.tool)}
          >
            {choice.icon}
          </button>
        ))}
        <div className="rail-rule" />
        <button
          type="button"
          className={`rail-tool${listing ? " picked" : ""}`}
          data-panel="chains"
          title={`Winding annotations (${chains.length})`}
          aria-pressed={listing}
          onClick={() => setListing(!listing)}
        >
          <svg viewBox="0 0 24 24" className="rail-icon" aria-hidden>
            <path d="M5 4.2 H19 L15.6 9.2 L19 14.2 H5 Z M5 4.2 V20.4" className="rail-stroke" />
          </svg>
        </button>
      </div>

      {listing && (
        <div id="rail-list">
          <div className="rail-list-top">Winding annotations</div>
          {chains.length === 0 && (
            <div className="rail-list-none">
              Nothing yet. Pick Same winding (Q) or Relative winding (E), then click points on a card.
            </div>
          )}
          {chains.map((one) => (
            <div
              key={one.id}
              className={`rail-anno${one.id === adding ? " drawing" : ""}${one.id === lit ? " lit" : ""}`}
              data-chain={one.id}
              onPointerEnter={() => onLit(one.id)}
              onPointerLeave={() => onLit(undefined)}
            >
              <button
                type="button"
                className={`rail-anno-on${one.on ? " on" : ""} ${one.kind}`}
                style={{ ["--chain" as string]: chainColour(one) }}
                title={
                  one.on
                    ? "Used when the surface is built; click to ignore it"
                    : "Ignored when the surface is built; click to use it"
                }
                onClick={() => onShow(one.id, !one.on)}
              />
              <span
                className="rail-anno-what"
                title={heard[one.id]?.used ? "Show the wrap this is on" : undefined}
                onClick={() => onGo(one.id)}
              >
                <span className="rail-anno-kind">
                  {one.kind === "same" ? "same winding" : "relative winding"} · {one.points.length} point
                  {one.points.length === 1 ? "" : "s"}
                  {one.id === adding ? " · adding" : ""}
                  {/* One point on its own says nothing that two do not, so the fit is never given it. */}
                  {one.points.length < 2 && one.id !== adding ? " · not used" : ""}
                </span>
                {/*
                  * What became of it, read off the finished surface rather than the first guess.  A
                  * same winding says "all of these are one wrap", so "on one wrap" is the surface
                  * agreeing, and anything else — points still spread over two wraps, points it could
                  * not reach at all — is the thing worth showing, because it is the annotation not
                  * being obeyed.
                  */}
                {heard[one.id] !== undefined && one.id !== adding && (
                  <span
                    className={`rail-anno-heard${
                      heard[one.id].used < heard[one.id].of || heard[one.id].sheets > 1 ? " crossed" : ""
                    }`}
                  >
                    {heard[one.id].used === 0
                      ? "none of it is on this surface"
                      : [
                          /*
                           * Which wrap it ended on, counted from the one the card is showing.  Two
                           * chains are two wraps — the fit will not put two of them on one — so this
                           * number is how a person checks that the layers they meant are the layers
                           * the surface found.
                           */
                          `wrap ${heard[one.id].sheet > 0 ? "+" : ""}${heard[one.id].sheet}`,
                          heard[one.id].sheets > 1 ? `drawn across ${heard[one.id].sheets}` : undefined,
                          heard[one.id].used < heard[one.id].of
                            ? `${heard[one.id].used} of ${heard[one.id].of} points`
                            : undefined,
                          `${Math.round(heard[one.id].worst)} voxels off`,
                        ]
                          .filter((part) => part !== undefined)
                          .join(" · ")}
                  </span>
                )}
              </span>
              {/*
                * Which layer this chain is on, by name.  Two chains wearing the same letter are the
                * same wrap; two wearing different letters are different wraps; a dot leaves it to the
                * surface.  A letter and not a number because the thing a person can see is that two
                * annotations are not the same layer — how many wraps lie between them is usually
                * exactly what they cannot say, and is left to the fit.
                */}
              <button
                type="button"
                className={`rail-anno-layer${one.layer == null ? "" : " said"}`}
                title={
                  one.layer == null
                    ? "The surface decides which wrap this is on. Click to name its layer: chains sharing a letter are the same wrap, different letters are different wraps."
                    : `On layer ${one.layer}. Chains sharing a letter are the same wrap; different letters are different wraps. Click to change.`
                }
                onClick={() => onLayer(one.id, after(one.layer ?? null))}
              >
                {one.layer ?? "·"}
              </button>
              <button
                type="button"
                className="rail-anno-off"
                title="Remove"
                onClick={() => onRemove(one.id)}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {says !== undefined && <div id="rail-says">{says}</div>}
    </>
  );
}

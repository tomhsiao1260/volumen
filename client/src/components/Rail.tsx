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
import type { WindChain } from "../surface/windings";

interface Choice {
  tool: Tool;
  key: string;
  title: string;
  said: string;
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
    title: "Look",
    said: "Move the cards and read the data",
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
    title: "Same sheet",
    said: "Point at places that are on one and the same sheet",
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
    title: "Count outward",
    said: "Point at one sheet after the next, across a cut",
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
const SAYS: Partial<Record<Tool, string>> = {
  same: "Press along one sheet, wherever you are sure it is the same one · Enter finishes · press a point, then Delete, to take it back",
  step: "Press across the sheets, one press a sheet · Enter finishes the chain · press a point, then Delete, to take it back",
};

export interface RailProps {
  tool: Tool;
  onTool: (tool: Tool) => void;
  // Everything said about the scans on the board, newest last, and the one being drawn.
  chains: WindChain[];
  adding: string | undefined;
  onShow: (id: string, on: boolean) => void;
  onRemove: (id: string) => void;
}

export function Rail({ tool, onTool, chains, adding, onShow, onRemove }: RailProps) {
  const [listing, setListing] = useState(false);
  const says = SAYS[tool];
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
            title={`${choice.title} (${choice.key}) — ${choice.said}`}
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
          title={`What has been said about the sheets (${chains.length})`}
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
          <div className="rail-list-top">What has been said</div>
          {chains.length === 0 && (
            <div className="rail-list-none">
              Nothing yet. Pick the sheets tool and press across the sheets on a slice.
            </div>
          )}
          {chains.map((one) => (
            <div key={one.id} className={`rail-said${one.id === adding ? " drawing" : ""}`} data-chain={one.id}>
              <button
                type="button"
                className={`rail-said-on${one.on ? " on" : ""} ${one.kind}`}
                title={one.on ? "Being used; press to set aside" : "Set aside; press to use"}
                onClick={() => onShow(one.id, !one.on)}
              />
              <span className="rail-said-what">
                {one.kind === "same" ? "same sheet · " : ""}
                {one.points.length} point{one.points.length === 1 ? "" : "s"}
                {one.kind === "step" && one.points.length > 1
                  ? ` · ${one.points.length - 1} wrap${one.points.length === 2 ? "" : "s"}`
                  : ""}
                {one.id === adding ? " · drawing" : ""}
              </span>
              <button
                type="button"
                className="rail-said-off"
                title="Take it back"
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

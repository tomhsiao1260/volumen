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
  icon: ReactNode;
}

// The arrow every board has, and a chain of sheets counted outward.
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
  {
    tool: "step",
    key: "E",
    title: "Count outward",
    said: "Point at one sheet after the next, across a cut",
    icon: (
      <svg viewBox="0 0 24 24" className="rail-icon" aria-hidden>
        <path d="M4 6.5 H20 M4 12 H20 M4 17.5 H20" className="rail-stroke" />
        <path d="M12 3.5 V20.5 M9 17.5 L12 20.8 L15 17.5" className="rail-stroke rail-thin" />
      </svg>
    ),
  },
];

// What the picked tool is for, said where the hand is.  A tool nobody can guess the use of is a tool
// nobody uses, and this one is a sentence long.
const SAYS: Partial<Record<Tool, string>> = {
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
                className={`rail-said-on${one.on ? " on" : ""}`}
                title={one.on ? "Being used; press to set aside" : "Set aside; press to use"}
                onClick={() => onShow(one.id, !one.on)}
              />
              <span className="rail-said-what">
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

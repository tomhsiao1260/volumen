/**
 * @file The board's own controls, which stay out of the way: a round button in the corner and the
 * same menu on a right click, plus a panel listing what the mouse and keyboard do.
 */

import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

const SHORTCUTS: { keys: string; action: string }[] = [
  { keys: "Double-click board", action: "New card" },
  { keys: "Alt + drag data", action: "Pan slice" },
  { keys: "Alt + wheel over data", action: "Step through slices" },
  { keys: "Alt + Ctrl + wheel over data", action: "Zoom slice" },
  { keys: "Right-click data", action: "Open surface here" },
  { keys: "Alt + wheel over a surface", action: "Move through the sheets" },
  { keys: "Click card", action: "Select" },
  { keys: "Shift + click card", action: "Add to selection" },
  { keys: "Drag board", action: "Select an area" },
  { keys: "Drag card", action: "Move selection" },
  { keys: "Drag card corner", action: "Resize card" },
  { keys: "⌘/Ctrl + C, then V", action: "Paste linked copies" },
  { keys: "⛓ on a card", action: "Unlink card" },
  { keys: "V", action: "Move tool" },
  { keys: "Q", action: "Same-winding point" },
  { keys: "E", action: "Relative-winding point" },
  { keys: "Enter", action: "Finish the annotation" },
  { keys: "Delete", action: "Remove the point you clicked" },
  { keys: "Space + drag / middle drag", action: "Pan board" },
  { keys: "Two fingers / wheel", action: "Pan board" },
  { keys: "Pinch / Ctrl + wheel", action: "Zoom board" },
  { keys: "Esc", action: "Clear selection" },
];

export interface BoardMenuProps {
  // Where the menu was opened, in pixels of the board element, or undefined while it is closed.
  at: { x: number; y: number } | undefined;
  onClose: () => void;
  onOpenAt: (at: { x: number; y: number }) => void;
  onNewCard: () => void;
  onFit: () => void;
}

export function BoardMenu({
  at,
  onClose,
  onOpenAt,
  onNewCard,
  onFit,
}: BoardMenuProps) {
  const [shortcuts, setShortcuts] = useState(false);
  const menu = useRef<HTMLDivElement>(null);

  // Keeps the menu inside the window, whichever corner it was opened in.
  useEffect(() => {
    const element = menu.current;
    if (at === undefined || element === null) return;
    const { offsetWidth, offsetHeight, parentElement } = element;
    const bounds = parentElement?.getBoundingClientRect();
    element.style.left = `${Math.min(at.x, (bounds?.width ?? 0) - offsetWidth - 8)}px`;
    element.style.top = `${Math.min(at.y, (bounds?.height ?? 0) - offsetHeight - 8)}px`;
  }, [at]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      onClose();
      setShortcuts(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <button
        id="board-add"
        title="Add a card"
        onClick={(event) => {
          event.stopPropagation();
          if (at !== undefined) {
            onClose();
            return;
          }
          // From the button, the menu opens above it.
          const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
          onOpenAt({ x: 16, y: Math.max(8, (bounds?.height ?? 0) - 180) });
        }}
      >
        <Icon name="plus" />
      </button>

      {at !== undefined && (
        <div className="menu" ref={menu}>
          <button
            onClick={() => {
              onClose();
              onNewCard();
            }}
          >
            New card
          </button>
          <button
            onClick={() => {
              onClose();
              onFit();
            }}
          >
            Fit to cards
          </button>
          <button
            onClick={() => {
              onClose();
              setShortcuts(true);
            }}
          >
            Shortcuts
          </button>
        </div>
      )}

      {shortcuts && (
        <div className="shortcuts">
          <div className="shortcuts-title">
            Shortcuts
            <button
              className="shortcuts-close"
              title="Close"
              onClick={() => setShortcuts(false)}
            >
              ✕
            </button>
          </div>
          <dl className="shortcuts-list">
            {SHORTCUTS.map(({ keys, action }) => (
              <div className="shortcuts-row" key={keys + action}>
                <dt>{keys}</dt>
                <dd>{action}</dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </>
  );
}

/**
 * @file The board's own controls, which stay out of the way: a round button in the corner and the
 * same menu on a right click, plus the list of what the mouse and keyboard do.
 */

import type { Board } from "./board";
import { CARD_HEIGHT, CARD_WIDTH } from "./board";
import { icon } from "./icons";

interface MenuItem {
  label: string;
  onClick: () => void;
}

const GESTURES: [string, string][] = [
  ["Double click the board", "add a card"],
  ["Drag the data", "pan the slice"],
  ["Wheel over the data", "step through the slices"],
  ["Ctrl and wheel over the data", "zoom the slice"],
  ["Drag a card's lines, or Alt and drag", "move the card"],
  ["Drag a card's corner", "resize it"],
  ["Drag the board, or middle drag", "pan the board"],
  ["Two fingers, or the wheel", "pan the board"],
  ["Pinch, or Ctrl and the wheel", "zoom the board"],
  ["The ⛓ in a card, then another card", "link them, so they move together"],
  ["Escape", "give up linking"],
];

export function createMenu(board: Board, parent: HTMLElement) {
  const button = document.createElement("button");
  button.id = "board-add";
  button.title = "Add a card";
  button.append(icon("plus"));

  const menu = document.createElement("div");
  menu.className = "menu";
  menu.hidden = true;

  const help = document.createElement("div");
  help.className = "help";
  help.hidden = true;
  const table = document.createElement("table");
  for (const [gesture, meaning] of GESTURES) {
    const row = table.insertRow();
    row.insertCell().textContent = gesture;
    row.insertCell().textContent = meaning;
  }
  const close = document.createElement("button");
  close.className = "help-close";
  close.textContent = "Close";
  close.addEventListener("click", () => (help.hidden = true));
  help.append(table, close);

  parent.append(button, menu, help);

  const closeMenu = () => {
    menu.hidden = true;
  };

  // Opens the menu at a point in the board element, kept inside it.
  const openMenu = (x: number, y: number, items: MenuItem[]) => {
    menu.replaceChildren(
      ...items.map(({ label, onClick }) => {
        const item = document.createElement("button");
        item.textContent = label;
        item.addEventListener("click", () => {
          closeMenu();
          onClick();
        });
        return item;
      }),
    );
    menu.hidden = false;
    const bounds = parent.getBoundingClientRect();
    menu.style.left = `${Math.min(x, bounds.width - menu.offsetWidth - 8)}px`;
    menu.style.top = `${Math.min(y, bounds.height - menu.offsetHeight - 8)}px`;
  };

  const items = (at: { x: number; y: number }): MenuItem[] => [
    {
      label: "New card",
      onClick: () =>
        board.addCard({
          x: Math.round(at.x - CARD_WIDTH / 2),
          y: Math.round(at.y - CARD_HEIGHT / 2),
        }),
    },
    {
      label: "New linked x/y/z",
      onClick: () =>
        board.addLinkedCards({
          x: Math.round(at.x - CARD_WIDTH / 2),
          y: Math.round(at.y - CARD_HEIGHT / 2),
        }),
    },
    { label: "Fit to the cards", onClick: () => board.fitToCards() },
    {
      label: "Mouse and keyboard",
      onClick: () => {
        help.hidden = false;
      },
    },
  ];

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!menu.hidden) {
      closeMenu();
      return;
    }
    const bounds = parent.getBoundingClientRect();
    // From the button, the menu opens above it, at the middle of the board.
    const at = board.pointAt(
      bounds.left + bounds.width / 2,
      bounds.top + bounds.height / 2,
    );
    openMenu(16, Math.max(8, bounds.height - 220), items(at));
  });

  parent.addEventListener("contextmenu", (event) => {
    if (board.cardAt(event.target) !== undefined) return;
    event.preventDefault();
    const bounds = parent.getBoundingClientRect();
    openMenu(
      event.clientX - bounds.left,
      event.clientY - bounds.top,
      items(board.pointAt(event.clientX, event.clientY)),
    );
  });

  parent.addEventListener("pointerdown", (event) => {
    if (!menu.contains(event.target as Node)) closeMenu();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    closeMenu();
    help.hidden = true;
  });
}

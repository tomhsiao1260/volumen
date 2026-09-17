/**
 * @file The symbols the board uses, drawn inline so that the page needs no icon font: a rolled
 * scroll, a fragment of one, one scan of it, and a folder.
 */

const ICONS = {
  // A rolled scroll, seen from the side.
  scroll: `<path d="M5 4h11a3 3 0 0 1 0 6H8"/><path d="M5 4a3 3 0 0 0 0 6h3"/>
           <path d="M8 10v7a3 3 0 0 0 3 3h8a3 3 0 0 1 0-6h-3"/>`,
  // A torn piece of papyrus.
  fragment: `<path d="M6 4h7l5 5v7l-3 2-4-2-4 2-2-3 2-3-2-3z"/><path d="M13 4v5h5"/>`,
  // One scan of a scroll: a stack of slices.
  volume: `<rect x="4" y="5" width="16" height="5" rx="1"/><path d="M4 12h16"/><path d="M4 16h16"/><path d="M4 20h16"/>`,
  folder: `<path d="M4 7a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>`,
  back: `<path d="M14 6l-6 6 6 6"/>`,
  plus: `<path d="M12 5v14"/><path d="M5 12h14"/>`,
} as const;

export type IconName = keyof typeof ICONS;

// An SVG element for `name`, sized by the font size where it is used.
export function icon(name: IconName, className = "icon") {
  const element = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  element.setAttribute("viewBox", "0 0 24 24");
  element.setAttribute("fill", "none");
  element.setAttribute("stroke", "currentColor");
  element.setAttribute("stroke-width", "1.6");
  element.setAttribute("stroke-linecap", "round");
  element.setAttribute("stroke-linejoin", "round");
  element.setAttribute("aria-hidden", "true");
  element.setAttribute("class", className);
  element.innerHTML = ICONS[name];
  return element;
}

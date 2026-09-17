/**
 * @file The symbols the board uses, drawn inline so that the page needs no icon font: a rolled
 * scroll, a fragment of one, one scan of it, and a folder.  Every path stays within the 24×24 box.
 */

const ICONS = {
  // A scroll: a sheet rolled at both ends.
  scroll: `<path d="M6 7a2.5 2.5 0 0 1 2.5-2.5h9a2.5 2.5 0 0 1 0 5H8.5A2.5 2.5 0 0 1 6 7z"/><path d="M8.5 9.5V17a2.5 2.5 0 0 0 2.5 2.5h8.5a2.5 2.5 0 0 1 0-5H16"/>`,
  // A torn piece of one.
  fragment: `<path d="M6 6l6-2 6 3v9l-3 2-3-1-3 2-3-2z"/>`,
  // One scan of it: a box of voxels.
  volume: `<path d="M12 4l7 4v8l-7 4-7-4V8z"/><path d="M5 8l7 4 7-4"/><path d="M12 12v8"/>`,
  folder: `<path d="M4 8a2 2 0 0 1 2-2h3l2 2h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/>`,
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
  element.setAttribute("stroke-width", "1.5");
  element.setAttribute("stroke-linecap", "round");
  element.setAttribute("stroke-linejoin", "round");
  element.setAttribute("aria-hidden", "true");
  element.setAttribute("class", className);
  element.innerHTML = ICONS[name];
  return element;
}

/**
 * @file The board's pan and zoom: the transform from board coordinates, in which the cards are laid
 * out, to the pixels of the board element.  It is applied as a CSS transform, which the viewer
 * measures to draw each card's slice magnified rather than showing more data (see `RenderViewport`).
 */

export interface BoardTransform {
  // Where the board's origin sits, in pixels of the board element.
  x: number;
  y: number;
  // Pixels of the board element per board unit.
  scale: number;
}

export const MIN_SCALE = 0.15;
export const MAX_SCALE = 8;

export function cssTransform({ x, y, scale }: BoardTransform) {
  return `translate(${x}px, ${y}px) scale(${scale})`;
}

// The board point shown at `x`, `y` in the board element.
export function toBoard({ x, y, scale }: BoardTransform, elementX: number, elementY: number) {
  return { x: (elementX - x) / scale, y: (elementY - y) / scale };
}

// Zooms by `factor`, keeping the board point at `elementX`, `elementY` where it is.
export function zoomAbout(
  transform: BoardTransform,
  elementX: number,
  elementY: number,
  factor: number,
): BoardTransform {
  const scale = Math.min(
    MAX_SCALE,
    Math.max(MIN_SCALE, transform.scale * factor),
  );
  const ratio = scale / transform.scale;
  return {
    scale,
    x: elementX - (elementX - transform.x) * ratio,
    y: elementY - (elementY - transform.y) * ratio,
  };
}

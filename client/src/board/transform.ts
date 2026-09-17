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

/**
 * The transform that brings every rectangle into a viewport of `size`, with a margin around them.
 * Used by "fit to the cards", so that a board panned far away can be found again.
 */
export function fitTo(
  rects: { x: number; y: number; width: number; height: number }[],
  size: { width: number; height: number },
  margin = 48,
): BoardTransform {
  const left = Math.min(...rects.map((rect) => rect.x));
  const top = Math.min(...rects.map((rect) => rect.y));
  const right = Math.max(...rects.map((rect) => rect.x + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
  const scale = Math.min(
    MAX_SCALE,
    Math.max(
      MIN_SCALE,
      Math.min(
        (size.width - 2 * margin) / Math.max(1, right - left),
        (size.height - 2 * margin) / Math.max(1, bottom - top),
      ),
    ),
  );
  return {
    scale,
    x: (size.width - (right - left) * scale) / 2 - left * scale,
    y: (size.height - (bottom - top) * scale) / 2 - top * scale,
  };
}

/**
 * @file Shows, in the bottom-right corner of the board, the voxel under the pointer (yellow) and the
 * center of the card it is over (white).
 */

import type { Point } from "viewer";
import type { Board } from "../board/board";
import type { Card } from "../board/card";

function formatVoxel({ x, y, z }: Point) {
  return `x ${Math.round(x)}, y ${Math.round(y)}, z ${Math.round(z)}`;
}

export function showPosition(board: Board, parent: HTMLElement) {
  const element = document.createElement("div");
  element.id = "position";
  const pointer = document.createElement("span");
  pointer.className = "pointer";
  const center = document.createElement("span");
  element.append(pointer, center);
  parent.append(element);

  // The card the pointer is over, whose center is shown until the pointer leaves it.
  let hovered: Card | undefined;

  const showCenter = () => {
    const position = hovered?.navigation?.position;
    center.textContent = position === undefined ? "" : formatVoxel(position);
  };
  board.onViewChanged(showCenter);

  board.viewer.onPointerMove((point, view) => {
    pointer.textContent = point === undefined ? "" : formatVoxel(point);
    hovered = point === undefined ? undefined : board.cardOfView(view);
    showCenter();
  });
}

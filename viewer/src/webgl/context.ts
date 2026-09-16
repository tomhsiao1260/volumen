/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

import type { RefCounted } from "#src/util/disposable.js";
import { Memoize } from "#src/util/memoize.js";

export interface GL extends WebGL2RenderingContext {
  memoize: Memoize<any, RefCounted>;
  max3dTextureSize: number;
}

export function initializeWebGL(canvas: HTMLCanvasElement) {
  const options = { antialias: false };
  const gl = <GL>canvas.getContext("webgl2", options);
  if (gl == null) {
    throw new Error("WebGL not supported.");
  }
  gl.memoize = new Memoize<any, RefCounted>();
  // The largest 3-D texture the GPU takes, which limits how the voxels of a chunk are packed into
  // its texture (see `render/chunk_format.ts`).
  gl.max3dTextureSize = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE);
  return gl;
}

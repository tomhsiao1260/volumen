/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * Sets parameters to make a texture suitable for use as a raw array: NEAREST filtering, clamping.
 */
export function setRawTexture3DParameters(gl: WebGL2RenderingContext) {
  gl.texParameteri(
    WebGL2RenderingContext.TEXTURE_3D,
    WebGL2RenderingContext.TEXTURE_MIN_FILTER,
    WebGL2RenderingContext.NEAREST,
  );
  gl.texParameteri(
    WebGL2RenderingContext.TEXTURE_3D,
    WebGL2RenderingContext.TEXTURE_MAG_FILTER,
    WebGL2RenderingContext.NEAREST,
  );
  // Prevents s-coordinate wrapping (repeating).  Repeating not
  // permitted for non-power-of-2 textures.
  gl.texParameteri(
    WebGL2RenderingContext.TEXTURE_3D,
    WebGL2RenderingContext.TEXTURE_WRAP_S,
    WebGL2RenderingContext.CLAMP_TO_EDGE,
  );
  // Prevents t-coordinate wrapping (repeating).  Repeating not
  // permitted for non-power-of-2 textures.
  gl.texParameteri(
    WebGL2RenderingContext.TEXTURE_3D,
    WebGL2RenderingContext.TEXTURE_WRAP_T,
    WebGL2RenderingContext.CLAMP_TO_EDGE,
  );
  gl.texParameteri(
    WebGL2RenderingContext.TEXTURE_3D,
    WebGL2RenderingContext.TEXTURE_WRAP_R,
    WebGL2RenderingContext.CLAMP_TO_EDGE,
  );
}


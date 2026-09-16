/** @license Copyright 2020 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * @file A vertex attribute at location 0 that is always enabled, and `gl_VertexID` redefined to use
 * it so that it is not optimized away.
 *
 * The slice shader draws from `gl_VertexID` alone and needs no attributes.  Without this, Firefox
 * draws correctly but warns that "drawing without vertex attrib 0 array enabled forces the browser
 * to do expensive emulation work when running on desktop OpenGL platforms, for example on Mac", and
 * advises binding an always-used attribute to location 0, which is what this does (checked in
 * Firefox on macOS, 2026).
 *
 * https://github.com/KhronosGroup/WebGL/pull/2662
 */

import { RefCounted } from "#src/util/disposable.js";
import { Buffer } from "#src/webgl/buffer.js";
import type { GL } from "#src/webgl/context.js";
import type { ShaderBuilder } from "#src/webgl/shader.js";

export function defineVertexId(builder: ShaderBuilder) {
  // Define attribute for location 0 that will always equal 0.
  builder.addAttribute("int", "aDummyVertexId", 0);
  // Ensure `aDummyVertexId` is actually used in the shader; otherwise, it will be optimized out.
  builder.addVertexCode(`
int getVertexId () {
  return aDummyVertexId + gl_VertexID;
}
#define gl_VertexID (getVertexId())
`);
}

export class VertexIdHelper extends RefCounted {
  size: number;
  buffer: Buffer;

  constructor(gl: WebGL2RenderingContext) {
    super();
    this.buffer = new Buffer(gl);
    this.size = 0;
  }

  disposed() {
    this.buffer.dispose();
  }

  enable(size = 256) {
    const { buffer } = this;
    const { gl } = buffer;
    buffer.bind();
    if (size > this.size) {
      this.size = size;
      gl.bufferData(
        WebGL2RenderingContext.ARRAY_BUFFER,
        new Int32Array(size),
        WebGL2RenderingContext.STATIC_DRAW,
      );
    }
    gl.vertexAttribIPointer(0, 1, WebGL2RenderingContext.INT, 0, 0);
    gl.vertexAttribDivisor(0, 0);
    gl.enableVertexAttribArray(0);
  }

  static get(gl: GL) {
    return gl.memoize.get("VertexIdHelper", () => new VertexIdHelper(gl));
  }
}

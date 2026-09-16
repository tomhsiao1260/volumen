/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

import type { Disposable } from "#src/util/disposable.js";

// A WebGL vertex (ARRAY_BUFFER) buffer.
export class Buffer implements Disposable {
  buffer: WebGLBuffer | null;

  constructor(public gl: WebGL2RenderingContext) {
    this.buffer = gl.createBuffer();
  }

  bind() {
    this.gl.bindBuffer(WebGL2RenderingContext.ARRAY_BUFFER, this.buffer);
  }

  dispose() {
    this.gl.deleteBuffer(this.buffer);
  }
}

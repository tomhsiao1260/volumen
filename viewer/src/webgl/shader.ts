/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

import { RefCounted } from "#src/util/disposable.js";
import type { GL } from "#src/webgl/context.js";

function compileShader(gl: GL, source: string, shaderType: number) {
  const shader = gl.createShader(shaderType)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const kind = shaderType === gl.VERTEX_SHADER ? "vertex" : "fragment";
    throw new Error(
      `Error compiling ${kind} shader: ${gl.getShaderInfoLog(shader) || ""}`,
    );
  }
  return shader;
}

export class ShaderProgram extends RefCounted {
  program: WebGLProgram;
  vertexShader: WebGLShader;
  fragmentShader: WebGLShader;
  uniforms = new Map<string, WebGLUniformLocation | null>();

  constructor(
    public gl: GL,
    vertexSource: string,
    fragmentSource: string,
    uniformNames: string[],
  ) {
    super();
    const vertexShader = (this.vertexShader = compileShader(
      gl,
      vertexSource,
      gl.VERTEX_SHADER,
    ));
    const fragmentShader = (this.fragmentShader = compileShader(
      gl,
      fragmentSource,
      gl.FRAGMENT_SHADER,
    ));
    const program = gl.createProgram()!;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(
        `Error linking shader: ${gl.getProgramInfoLog(program) || ""}`,
      );
    }
    this.program = program;
    for (const name of uniformNames) {
      this.uniforms.set(name, gl.getUniformLocation(program, name));
    }
  }

  uniform(name: string): WebGLUniformLocation {
    return this.uniforms.get(name)!;
  }

  bind() {
    this.gl.useProgram(this.program);
  }

  disposed() {
    const { gl } = this;
    gl.deleteShader(this.vertexShader);
    gl.deleteShader(this.fragmentShader);
    gl.deleteProgram(this.program);
  }
}

/**
 * Assembles a vertex and fragment shader from declarations and code, and builds the program.
 * Uniform and attribute locations are looked up by the names declared here.
 */
export class ShaderBuilder {
  private uniformsCode = "";
  private attributesCode = "";
  private varyingsCodeVS = "";
  private varyingsCodeFS = "";
  private outputBufferCode = "";
  private vertexCode = "";
  private fragmentCode = "";
  private vertexMain = "";
  private fragmentMain = "";
  private uniforms = new Array<string>();
  private initializers = new Array<(shader: ShaderProgram) => void>();

  constructor(public gl: GL) {}

  // Attribute locations are fixed with `layout(location = ...)`, so they are never looked up.
  addAttribute(typeName: string, name: string, location: number) {
    this.attributesCode += `layout(location = ${location}) in ${typeName} ${name};\n`;
  }

  addVarying(typeName: string, name: string) {
    this.varyingsCodeVS += `out ${typeName} ${name};\n`;
    this.varyingsCodeFS += `in ${typeName} ${name};\n`;
  }

  addOutputBuffer(typeName: string, name: string, location: number) {
    this.outputBufferCode += `layout(location = ${location}) out ${typeName} ${name};\n`;
  }

  addUniform(typeName: string, name: string, extent?: number) {
    this.uniforms.push(name);
    if (extent !== undefined) {
      this.uniformsCode += `uniform ${typeName} ${name}[${extent}];\n`;
    } else {
      this.uniformsCode += `uniform ${typeName} ${name};\n`;
    }
  }

  addVertexCode(code: string) {
    this.vertexCode += code;
  }

  addFragmentCode(code: string) {
    this.fragmentCode += code;
  }

  // Sets the body of the vertex shader's `main`.
  setVertexMain(code: string) {
    this.vertexMain = code;
  }

  // Sets the body of the fragment shader's `main`.
  setFragmentMain(code: string) {
    this.fragmentMain = code;
  }

  // Adds a function run once, with the program bound, after it is built (e.g. to set sampler units).
  addInitializer(f: (shader: ShaderProgram) => void) {
    this.initializers.push(f);
  }

  build() {
    const vertexSource = `#version 300 es
precision highp float;
precision highp int;
${this.uniformsCode}
${this.attributesCode}
${this.varyingsCodeVS}
${this.vertexCode}
void main() {
${this.vertexMain}
}
`;
    const fragmentSource = `#version 300 es
precision highp float;
precision highp int;
${this.uniformsCode}
${this.varyingsCodeFS}
${this.outputBufferCode}
${this.fragmentCode}
void main() {
${this.fragmentMain}
}
`;
    const shader = new ShaderProgram(
      this.gl,
      vertexSource,
      fragmentSource,
      this.uniforms,
    );
    const { initializers } = this;
    if (initializers.length > 0) {
      shader.bind();
      for (const initializer of initializers) {
        initializer(shader);
      }
    }
    return shader;
  }
}

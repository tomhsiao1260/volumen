/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * @file How volume chunks are stored on the GPU and read back in the fragment shader.
 *
 * Each chunk is uploaded as one 3-D texture with one texel per voxel.  `TextureLayout` gives the
 * texel offset of each chunk dimension, and the shader turns a voxel position into a texel position
 * with it.
 */

import type { VolumeChunk } from "#src/render/frontend.js";
import type { TypedArray, TypedArrayConstructor } from "#src/util/array.js";
import { DataType } from "#src/util/data_type.js";
import { RefCounted } from "#src/util/disposable.js";
import type { GL } from "#src/webgl/context.js";
import type { ShaderBuilder, ShaderProgram } from "#src/webgl/shader.js";
import { setRawTexture3DParameters } from "#src/webgl/texture.js";

const WebGL = WebGL2RenderingContext;

interface TextureFormat {
  internalFormat: number;
  format: number;
  texelType: number;
  arrayConstructor: TypedArrayConstructor;
  // Prefix of the sampler type: `usampler3D` or `sampler3D`.
  samplerPrefix: "" | "u";
}

const textureFormats: Record<DataType, TextureFormat> = {
  [DataType.UINT8]: {
    internalFormat: WebGL.R8UI,
    format: WebGL.RED_INTEGER,
    texelType: WebGL.UNSIGNED_BYTE,
    arrayConstructor: Uint8Array,
    samplerPrefix: "u",
  },
  [DataType.UINT16]: {
    internalFormat: WebGL.R16UI,
    format: WebGL.RED_INTEGER,
    texelType: WebGL.UNSIGNED_SHORT,
    arrayConstructor: Uint16Array,
    samplerPrefix: "u",
  },
  [DataType.FLOAT32]: {
    internalFormat: WebGL.R32F,
    format: WebGL.RED,
    texelType: WebGL.FLOAT,
    arrayConstructor: Float32Array,
    samplerPrefix: "",
  },
};

/**
 * Where the voxels of a chunk go in its texture.  Moving one voxel along chunk dimension `d` moves
 * `strides[d * 3 + t]` texels along texture dimension `t`.  Chunk dimensions of size 1 take no
 * texture dimension; dimensions are combined into one texture dimension when that stays within the
 * maximum texture size, which for the 128^3 chunks of a Vesuvius volume it does not.
 */
export class TextureLayout {
  strides: Uint32Array;
  textureShape: Uint32Array;

  constructor(gl: GL, chunkDataSize: Uint32Array) {
    const rank = chunkDataSize.length;
    let numRemainingDims = 0;
    for (const size of chunkDataSize) {
      if (size !== 1) ++numRemainingDims;
    }
    const strides = (this.strides = new Uint32Array(rank * 3));
    const textureShape = (this.textureShape = new Uint32Array(3));
    let textureDim = 0;
    let textureDimSize = 1;
    textureShape.fill(1);
    for (let chunkDim = 0; chunkDim < rank; ++chunkDim) {
      const size = chunkDataSize[chunkDim];
      if (size === 1) continue;
      const newSize = size * textureDimSize;
      let stride: number;
      if (
        newSize > gl.max3dTextureSize ||
        (textureDimSize !== 1 && textureDim + numRemainingDims < 3)
      ) {
        ++textureDim;
        textureDimSize = size;
        stride = 1;
      } else {
        stride = textureDimSize;
        textureDimSize = newSize;
      }
      strides[3 * chunkDim + textureDim] = stride;
      textureShape[textureDim] = textureDimSize;
    }
  }
}

const tempStrides = new Int32Array(4 * 3);

/**
 * Uploads chunk data of one data type to textures, and defines and feeds the shader code that reads
 * them.  Shared by all chunk sources with the same data type.
 */
export class ChunkFormat extends RefCounted {
  textureFormat: TextureFormat;
  // Layout whose strides are currently set in the shader.
  private boundTextureLayout: TextureLayout | null = null;

  static get(gl: GL, dataType: DataType) {
    return gl.memoize.get(
      `sliceview.ChunkFormat:${dataType}`,
      () => new ChunkFormat(dataType),
    );
  }

  constructor(public dataType: DataType) {
    super();
    this.textureFormat = textureFormats[dataType];
  }

  // The GLSL type of a voxel value: an unsigned integer, or a float for float32 data.
  get shaderType() {
    return this.dataType === DataType.FLOAT32 ? "highp float" : "highp uint";
  }

  /**
   * Defines `getDataValue()`, the value of the voxel containing `vChunkPosition` in the chunk bound
   * with `bindChunk`.  The texture is read from texture unit 0.
   */
  defineShader(builder: ShaderBuilder) {
    builder.addUniform(
      `highp ${this.textureFormat.samplerPrefix}sampler3D`,
      "uVolumeChunkSampler",
    );
    builder.addInitializer((shader) => {
      shader.gl.uniform1i(shader.uniform("uVolumeChunkSampler"), 0);
    });
    // Texel offset of voxel (0, 0, 0), then the texel offset per voxel along x, y and z.
    builder.addUniform("highp ivec3", "uVolumeChunkStrides", 4);
    builder.addFragmentCode(`
${this.shaderType} getDataValue() {
  highp ivec3 p = ivec3(max(vec3(0.0, 0.0, 0.0), min(floor(vChunkPosition), uChunkDataSize - 1.0)));
  highp ivec3 offset = uVolumeChunkStrides[0]
                     + p.x * uVolumeChunkStrides[1]
                     + p.y * uVolumeChunkStrides[2]
                     + p.z * uVolumeChunkStrides[3];
  return texelFetch(uVolumeChunkSampler, offset, 0).r;
}
`);
  }

  // Called with the shader bound, before the chunks of this format are drawn.
  beginDrawing(gl: GL) {
    gl.activeTexture(WebGL.TEXTURE0);
    this.boundTextureLayout = null;
  }

  endDrawing(gl: GL) {
    gl.bindTexture(WebGL.TEXTURE_3D, null);
    this.boundTextureLayout = null;
  }

  // Called before drawing each chunk.  `newSource` is true for the first chunk of each source.
  bindChunk(
    gl: GL,
    shader: ShaderProgram,
    chunk: VolumeChunk,
    newSource: boolean,
  ) {
    const textureLayout = chunk.textureLayout!;
    if (this.boundTextureLayout !== textureLayout || newSource) {
      this.boundTextureLayout = textureLayout;
      this.setupTextureLayout(gl, shader, textureLayout);
    }
    gl.bindTexture(WebGL.TEXTURE_3D, chunk.texture);
  }

  private setupTextureLayout(
    gl: GL,
    shader: ShaderProgram,
    textureLayout: TextureLayout,
  ) {
    const stridesUniform = tempStrides;
    const { strides } = textureLayout;
    // Voxel (0, 0, 0) is at texel 0.
    stridesUniform.fill(0, 0, 3);
    // Texel offset per voxel along x, y and z.
    for (let i = 0; i < 3; ++i) {
      for (let j = 0; j < 3; ++j) {
        stridesUniform[(i + 1) * 3 + j] = strides[i * 3 + j];
      }
    }
    gl.uniform3iv(shader.uniform("uVolumeChunkStrides"), stridesUniform, 0, 12);
  }

  // Uploads `data` to the texture currently bound to `TEXTURE_3D`.
  setTextureData(gl: GL, textureLayout: TextureLayout, data: TypedArray) {
    const { internalFormat, format, texelType, arrayConstructor } =
      this.textureFormat;
    if (data.constructor !== arrayConstructor) {
      data = new arrayConstructor(
        data.buffer,
        data.byteOffset,
        data.byteLength / arrayConstructor.BYTES_PER_ELEMENT,
      );
    }
    gl.pixelStorei(WebGL.UNPACK_ALIGNMENT, 1);
    const { textureShape } = textureLayout;
    setRawTexture3DParameters(gl);
    gl.texImage3D(
      WebGL.TEXTURE_3D,
      /*level=*/ 0,
      internalFormat,
      textureShape[0],
      textureShape[1],
      textureShape[2],
      /*border=*/ 0,
      format,
      texelType,
      data,
    );
  }
}

/**
 * A chunk missing from the store arrives with no data.  All such chunks share this single-voxel
 * texture holding the array's fill value, so a sparse volume does not allocate a texture per chunk.
 */
export class FillValueTexture extends RefCounted {
  texture: WebGLTexture | null;
  textureLayout: TextureLayout;

  constructor(
    gl: GL,
    chunkFormat: ChunkFormat,
    rank: number,
    fillValue: number,
  ) {
    super();
    const chunkSizeInVoxels = new Uint32Array(rank);
    chunkSizeInVoxels.fill(1);
    const textureLayout = (this.textureLayout = new TextureLayout(
      gl,
      chunkSizeInVoxels,
    ));
    textureLayout.strides.fill(0);
    const texture = (this.texture = gl.createTexture());
    gl.bindTexture(WebGL.TEXTURE_3D, texture);
    chunkFormat.setTextureData(
      gl,
      textureLayout,
      chunkFormat.textureFormat.arrayConstructor.of(fillValue),
    );
    gl.bindTexture(WebGL.TEXTURE_3D, null);
  }

  static get(
    gl: GL,
    chunkFormat: ChunkFormat,
    rank: number,
    fillValue: number,
  ) {
    return gl.memoize.get(
      `sliceview.FillValueTexture:${rank}:${chunkFormat.dataType}:${fillValue}`,
      () => new FillValueTexture(gl, chunkFormat, rank, fillValue),
    );
  }
}

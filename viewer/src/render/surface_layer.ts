/**
 * @file Draws a sheet of papyrus laid flat, out of a field of positions and the scan it points into.
 *
 * A cross-section is a plane through the volume, and the vertex shader cuts that plane out of each
 * chunk (`renderlayer.ts`).  A flattening is a curved sheet instead, and the shape of it is not
 * something a vertex program can derive — it is the result of marching a grid out through the
 * sheets, which happens elsewhere and takes most of a second.  But once marched it is just a table:
 * for every node of a flat grid, the voxel of the scan that node sits at.
 *
 * So the geometry arrives as a 3-D image — `(u, v, layer)` of `(z, y, x, reached)` — and drawing is
 * two reads: where is this pixel of the card in the scan, and what does the scan say there.  The
 * first read used to be `positionAt`, twenty-four multiply-adds the CPU renderer could only afford
 * at every eighth pixel; here it is eight texel fetches, per pixel, and cheaper than the
 * approximation was.
 *
 * Deliberately NEAREST and trilinear by hand rather than a filtered float texture: filtering 32-bit
 * floats is an extension in WebGL and an optional feature in WebGPU, and the eight fetches cost
 * nothing.  It also means the alpha test below is exact rather than nearly so.
 */
import type { ChunkFormat } from "#src/render/chunk_format.js";
import { ChunkState } from "#src/chunk_manager/base.js";
import type { VolumeChunk, VolumeChunkSource } from "#src/render/frontend.js";
import { RefCounted } from "#src/util/disposable.js";
import type { GL } from "#src/webgl/context.js";
import { ShaderBuilder } from "#src/webgl/shader.js";
import type { ShaderProgram } from "#src/webgl/shader.js";
import { defineVertexId, VertexIdHelper } from "#src/webgl/vertex_id.js";

const WebGL = WebGL2RenderingContext;

/** The march's table, packed for upload.  See the client's `surface/gpu/field.ts`. */
export interface SurfaceField {
  nu: number;
  nv: number;
  layers: number;
  per: number;
  K: number;
  // RGBA float32, (layer, v, u) with u fastest: (z, y, x) in full-resolution scan voxels, and 1 in
  // alpha where the march reached and 0 where it did not.
  data: Float32Array;
  /*
   * The walk, inverted and evenly sampled: the winding at each of `walk.length` equal distances
   * through the papyrus, from `lo` to `hi` voxels.
   *
   * A cut spreads the sheets by DISTANCE, not by winding — the papyrus is not the same thickness
   * everywhere, and spreading by winding draws the thin parts magnified.  On the page that meant
   * recomputing a map of the sheets around whatever sheet was shown, every time it changed.  As a
   * texture it is one read at whatever distance a pixel is at, so a pull is two uniforms.
   */
  walk: Float32Array;
  lo: number;
  hi: number;
}

/**
 * One scale of the scan, with the chunks of it to draw.
 *
 * `factor` is how many voxels of the full-resolution scan one of this scale's voxels covers, and
 * `chunkSize` its chunks in its own voxels — the two numbers that turn a place in the scan into a
 * place in a chunk.
 */
export interface SurfaceScale {
  source: VolumeChunkSource;
  factor: number;
  chunkSize: ArrayLike<number>;
  chunks: Iterable<VolumeChunk>;
}

/** What the card is looking at.  All of it is uniforms; none of it is data. */
export interface SurfaceWindow {
  plane: "uv" | "uw" | "vw";
  // The sheet shown, in the piece's own windings.  A flat card shows this one; a cut uses the two
  // below and reaches this only through the walk.
  w: number;
  // What a cut shows across the sheets: the distance at its near edge, and how much of it, in
  // voxels of papyrus.  Moving these two is the whole of a pull.
  from: number;
  across: number;
  /*
   * What to draw instead of the papyrus, for finding out where a blank card went wrong.  `?show=N`:
   * 1 how much of the march the pixel found, 2 where in the scan it points, 3 that the quad is
   * rasterised at all, 4 whether that place is inside the chunk bound.
   *
   * Kept rather than deleted.  Getting this card to draw at all came down to telling those four
   * apart one at a time — a card that is black is black for a dozen reasons and says nothing about
   * which, and without these the next person starts the same blind search over.
   */
  show?: number;
}

export class SurfaceLayer extends RefCounted {
  private field: WebGLTexture | null = null;
  private walk: WebGLTexture | null = null;
  private size = [0, 0, 0];
  private per = 1;
  private K = 1;
  private lo = 0;
  private hi = 1;
  private walkSize = 2;
  private shader: ShaderProgram | null | undefined;
  private vertexIdHelper: VertexIdHelper;

  constructor(public gl: GL) {
    super();
    this.vertexIdHelper = this.registerDisposer(VertexIdHelper.get(gl));
    this.registerDisposer(() => {
      this.shader?.dispose();
      if (this.field !== null) gl.deleteTexture(this.field);
      if (this.walk !== null) gl.deleteTexture(this.walk);
    });
  }

  /**
   * Takes a new march.  Uploaded whole, which is some ten megabytes — once for a piece, and again
   * when a winding is taken in and the table is resampled.  Never per frame.
   */
  take(field: SurfaceField) {
    const { gl } = this;
    const { nu, nv, layers } = field;
    if (this.field === null) this.field = gl.createTexture();
    gl.bindTexture(WebGL.TEXTURE_3D, this.field);
    gl.texParameteri(WebGL.TEXTURE_3D, WebGL.TEXTURE_MIN_FILTER, WebGL.NEAREST);
    gl.texParameteri(WebGL.TEXTURE_3D, WebGL.TEXTURE_MAG_FILTER, WebGL.NEAREST);
    gl.texParameteri(WebGL.TEXTURE_3D, WebGL.TEXTURE_WRAP_S, WebGL.CLAMP_TO_EDGE);
    gl.texParameteri(WebGL.TEXTURE_3D, WebGL.TEXTURE_WRAP_T, WebGL.CLAMP_TO_EDGE);
    gl.texParameteri(WebGL.TEXTURE_3D, WebGL.TEXTURE_WRAP_R, WebGL.CLAMP_TO_EDGE);
    gl.pixelStorei(WebGL.UNPACK_ALIGNMENT, 1);
    gl.texImage3D(
      WebGL.TEXTURE_3D,
      0,
      WebGL.RGBA32F,
      nu,
      nv,
      layers,
      0,
      WebGL.RGBA,
      WebGL.FLOAT,
      field.data,
    );
    gl.bindTexture(WebGL.TEXTURE_3D, null);
    this.size = [nu, nv, layers];
    this.per = field.per;
    this.K = field.K;

    if (this.walk === null) this.walk = gl.createTexture();
    gl.bindTexture(WebGL.TEXTURE_2D, this.walk);
    gl.texParameteri(WebGL.TEXTURE_2D, WebGL.TEXTURE_MIN_FILTER, WebGL.NEAREST);
    gl.texParameteri(WebGL.TEXTURE_2D, WebGL.TEXTURE_MAG_FILTER, WebGL.NEAREST);
    gl.texParameteri(WebGL.TEXTURE_2D, WebGL.TEXTURE_WRAP_S, WebGL.CLAMP_TO_EDGE);
    gl.texParameteri(WebGL.TEXTURE_2D, WebGL.TEXTURE_WRAP_T, WebGL.CLAMP_TO_EDGE);
    gl.texImage2D(
      WebGL.TEXTURE_2D,
      0,
      WebGL.R32F,
      field.walk.length,
      1,
      0,
      WebGL.RED,
      WebGL.FLOAT,
      field.walk,
    );
    gl.bindTexture(WebGL.TEXTURE_2D, null);
    this.walkSize = field.walk.length;
    this.lo = field.lo;
    this.hi = field.hi;
  }

  get ready() {
    return this.field !== null;
  }

  private getShader(chunkFormat: ChunkFormat) {
    let { shader } = this;
    if (shader === undefined) {
      shader = null;
      try {
        const builder = new ShaderBuilder(this.gl);
        builder.addVarying("highp vec2", "vFrame");
        builder.addUniform("highp sampler3D", "uField");
        builder.addUniform("highp vec3", "uFieldSize");
        builder.addUniform("highp vec2", "uSheet"); // (K, per)
        builder.addUniform("highp float", "uW");
        builder.addUniform("highp int", "uPlane");
        builder.addUniform("highp sampler2D", "uWalk");
        // The distance at the near edge of the card, how much of it the card covers, and the range
        // the walk texture spans — all in voxels of papyrus.
        builder.addUniform("highp vec2", "uAcross");
        builder.addUniform("highp vec2", "uWalkRange");
        builder.addUniform("highp float", "uWalkSize");
        builder.addUniform("highp int", "uShow");
        // Where this chunk sits in the level being drawn, and how many voxels of the scan one of
        // that level's voxels covers.
        builder.addUniform("highp vec3", "uChunkOrigin");
        builder.addUniform("highp float", "uFactor");
        builder.addUniform("highp vec3", "uChunkDataSize");
        defineVertexId(builder);
        chunkFormat.defineShader(builder);
        builder.addInitializer((program) => {
          program.gl.uniform1i(program.uniform("uField"), 1);
          program.gl.uniform1i(program.uniform("uWalk"), 2);
        });
        builder.setVertexMain(`
// A quad over the whole card; the field decides what lands where, not the geometry.
vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
vFrame = vec2(corner.x, 1.0 - corner.y);
gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
`);
        builder.addFragmentCode(`
// The winding at a place across the card.  The sheets are spread by DISTANCE through the papyrus,
// not by winding, so this is a walk along the sheet made into a lookup: the card's own fraction
// becomes a distance, and the distance becomes a winding.
highp float sheetAcross(highp float f) {
  highp float far = uAcross.x + f * uAcross.y;
  highp float at = (far - uWalkRange.x) / max(1e-6, uWalkRange.y - uWalkRange.x);
  highp float texel = clamp(at * (uWalkSize - 1.0), 0.0, uWalkSize - 1.0);
  int i = int(floor(texel));
  int j = min(int(uWalkSize) - 1, i + 1);
  highp float a = texelFetch(uWalk, ivec2(i, 0), 0).r;
  highp float b = texelFetch(uWalk, ivec2(j, 0), 0).r;
  return mix(a, b, texel - float(i));
}

/*
 * The march, read where the card is looking.  This is positionAt: trilinear over (u, v, layer),
 * with the fourth channel carrying whether the march reached each corner.  Because that channel is
 * 0 or 1 and the eight weights sum to 1, the blended alpha reaches 1 only when every corner that
 * carried weight was reached, so an alpha short of 1 is exactly the false the CPU returns.
 */
highp vec4 fieldAt(highp vec3 at) {
  highp vec3 base = floor(at);
  highp vec3 t = at - base;
  highp ivec3 top = ivec3(uFieldSize) - 1;
  highp vec4 total = vec4(0.0);
  for (int dk = 0; dk < 2; ++dk) {
    highp float wk = dk == 1 ? t.z : 1.0 - t.z;
    if (wk == 0.0) continue;
    for (int di = 0; di < 2; ++di) {
      highp float wi = di == 1 ? t.y : 1.0 - t.y;
      if (wi == 0.0) continue;
      for (int dj = 0; dj < 2; ++dj) {
        highp float wj = dj == 1 ? t.x : 1.0 - t.x;
        if (wj == 0.0) continue;
        highp ivec3 p = clamp(ivec3(base) + ivec3(dj, di, dk), ivec3(0), top);
        total += (wk * wi * wj) * texelFetch(uField, p, 0);
      }
    }
  }
  return total;
}
`);
        builder.setFragmentMain(`
highp float gi;
highp float gj;
highp float w;
if (uPlane == 1) {
  // A cut along u: the sheets stack downwards, and v is pinned to the middle of the grid.
  w = sheetAcross(vFrame.y);
  gi = (uFieldSize.y - 1.0) * 0.5;
  gj = vFrame.x * (uFieldSize.x - 1.0);
} else if (uPlane == 2) {
  // A cut along v: the sheets lie out to the right, and u is pinned to the middle.
  w = sheetAcross(vFrame.x);
  gi = vFrame.y * (uFieldSize.y - 1.0);
  gj = (uFieldSize.x - 1.0) * 0.5;
} else {
  w = uW;
  gi = vFrame.y * (uFieldSize.y - 1.0);
  gj = vFrame.x * (uFieldSize.x - 1.0);
}
if (uShow == 3) { v4f_fragData0 = vec4(vFrame.x, vFrame.y, 0.5, 1.0); return; }
highp float layer = (w + uSheet.x) * uSheet.y;
if (layer < 0.0 || layer > uFieldSize.z - 1.0) discard;
highp vec4 place = fieldAt(vec3(gj, gi, layer));
if (uShow == 1) { v4f_fragData0 = vec4(place.a, place.a, place.a, 1.0); return; }
if (uShow == 2) { v4f_fragData0 = vec4(fract(place.rgb / 64.0), 1.0); return; }
// Anything short of the whole weight means the march did not reach one of the corners.
if (place.a < 0.999) discard;

/*
 * The scan, at the level this chunk belongs to, and then within this chunk.
 *
 * The field holds (z, y, x), which is how the scan's array and the march are both written; a chunk
 * is addressed (x, y, z), because the data source reverses the axes when it places the volume in the
 * world.  Hence the swizzle — measured against the chunks a cross-section of the same scan is
 * drawing, which sit at grid (38, 15, 74) where the same place asked for the other way round is
 * (74, 15, 38), a chunk of empty space on the far side of the scroll.
 */
highp vec3 level = (place.bgr + 0.5) / uFactor - 0.5;
highp vec3 inChunk = level - uChunkOrigin;
if (uShow == 4) {
  bool out0 = any(lessThan(inChunk, vec3(0.0))) || any(greaterThanEqual(inChunk, uChunkDataSize - 1.0));
  v4f_fragData0 = out0 ? vec4(0.2, 0.0, 0.0, 1.0) : vec4(0.0, 1.0, 0.0, 1.0);
  return;
}
/*
 * Only what is outside the chunk is thrown away, not the last voxel of it.
 *
 * Trilinear wants the next voxel along each way and the next one belongs to the neighbouring chunk,
 * which is not bound — so the taps below are held at the edge instead (getDataValueAt clamps).  That
 * is half a voxel of error on a chunk boundary.  Dropping the last voxel instead left a one-voxel
 * gap at every boundary, which on a sheet cutting across the grid drew as a black line through the
 * papyrus.
 */
if (any(lessThan(inChunk, vec3(0.0))) || any(greaterThanEqual(inChunk, uChunkDataSize))) discard;
highp vec3 base = floor(inChunk);
highp vec3 t = inChunk - base;
highp float value = 0.0;
for (int dx = 0; dx < 2; ++dx) {
  highp float wx = dx == 1 ? t.x : 1.0 - t.x;
  for (int dy = 0; dy < 2; ++dy) {
    highp float wy = dy == 1 ? t.y : 1.0 - t.y;
    for (int dz = 0; dz < 2; ++dz) {
      highp float wz = dz == 1 ? t.z : 1.0 - t.z;
      value += (wx * wy * wz) * float(getDataValueAt(base + vec3(float(dx), float(dy), float(dz))));
    }
  }
}
value = clamp(value / 255.0, 0.0, 1.0);
v4f_fragData0 = vec4(value, value, value, 1.0);
`);
        builder.addOutputBuffer("vec4", "v4f_fragData0", 0);
        shader = builder.build();
      } catch (error) {
        console.error("Could not build the surface shader:", error);
      }
      this.shader = shader;
    }
    return shader;
  }

  /**
   * Draws the sheet, one bound chunk at a time.
   *
   * Every pass covers the whole card and throws away the pixels whose place in the scan is not in
   * the chunk it has bound — which is what a cross-section does too, only there the vertex shader
   * has already clipped the polygon to the chunk, and here the geometry cannot be clipped because
   * the sheet's shape is not known until the field has been read.
   *
   * What it does NOT do is work out which chunks those are.  A cross-section can: its geometry is a
   * plane and the chunks it cuts fall out of the arithmetic.  A sheet's shape is the march, which
   * lives in another worker entirely, so the chunks are handed in — coarsest last, so that the
   * depth test leaves a coarse pixel only where no finer one landed.
   */
  draw(scales: SurfaceScale[], window: SurfaceWindow) {
    if (this.field === null || scales.length === 0) return;
    const { gl } = this;
    const { chunkFormat } = scales[0].source;
    const shader = this.getShader(chunkFormat);
    if (shader === null) return;
    shader.bind();
    this.vertexIdHelper.enable();
    chunkFormat.beginDrawing(gl);

    gl.activeTexture(WebGL.TEXTURE1);
    gl.bindTexture(WebGL.TEXTURE_3D, this.field);

    gl.uniform3f(shader.uniform("uFieldSize"), this.size[0], this.size[1], this.size[2]);
    gl.uniform2f(shader.uniform("uSheet"), this.K, this.per);
    gl.uniform1f(shader.uniform("uW"), window.w);
    gl.uniform1i(shader.uniform("uPlane"), window.plane === "uw" ? 1 : window.plane === "vw" ? 2 : 0);
    gl.uniform2f(shader.uniform("uAcross"), window.from, window.across);
    gl.uniform2f(shader.uniform("uWalkRange"), this.lo, this.hi);
    gl.uniform1f(shader.uniform("uWalkSize"), this.walkSize);
    gl.uniform1i(shader.uniform("uShow"), window.show ?? 0);
    gl.activeTexture(WebGL.TEXTURE2);
    gl.bindTexture(WebGL.TEXTURE_2D, this.walk);

    /*
     * And back to unit 0, which is where the chunks go.
     *
     * `bindChunk` binds to whatever unit is active, and the two above leave unit 2 active — so
     * without this every chunk lands on top of the walk and the sampler reads an empty unit 0.  The
     * whole card then draws nothing, which is exactly what it did.
     */
    gl.activeTexture(WebGL.TEXTURE0);

    for (const scale of scales) {
      gl.uniform1f(shader.uniform("uFactor"), scale.factor);
      gl.uniform3f(
        shader.uniform("uChunkDataSize"),
        scale.chunkSize[0],
        scale.chunkSize[1],
        scale.chunkSize[2],
      );
      let first = true;
      for (const chunk of scale.chunks) {
        if (chunk.state !== ChunkState.GPU_MEMORY) continue;
        const { chunkGridPosition } = chunk;
        gl.uniform3f(
          shader.uniform("uChunkOrigin"),
          chunkGridPosition[0] * scale.chunkSize[0],
          chunkGridPosition[1] * scale.chunkSize[1],
          chunkGridPosition[2] * scale.chunkSize[2],
        );
        chunkFormat.bindChunk(gl, shader, chunk, first);
        first = false;
        gl.activeTexture(WebGL.TEXTURE0);
        gl.bindTexture(WebGL.TEXTURE_3D, chunk.texture);
        gl.uniform1i(shader.uniform("uVolumeChunkSampler"), 0);
        gl.drawArrays(WebGL.TRIANGLE_STRIP, 0, 4);
      }
    }

    chunkFormat.endDrawing(gl);
    gl.activeTexture(WebGL.TEXTURE1);
    gl.bindTexture(WebGL.TEXTURE_3D, null);
    gl.activeTexture(WebGL.TEXTURE2);
    gl.bindTexture(WebGL.TEXTURE_2D, null);
  }
}

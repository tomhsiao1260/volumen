/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */
import { mat4, vec3 } from "gl-matrix";

export { mat2, mat3, mat4, quat, vec2, vec3, vec4 } from "gl-matrix";

export const kOneVec = vec3.fromValues(1, 1, 1);

/**
 * Implements a one-to-one conversion from Vec3 to string, suitable for use a Map key.
 *
 * Specifically, returns the string representation of the 3 values separated by commas.
 */
export function vec3Key(x: ArrayLike<number>) {
  return `${x[0]},${x[1]},${x[2]}`;
}

/**
 * Transforms a vector `a` by a homogenous transformation matrix `m`.  The translation component of
 * `m` is ignored.
 */
export function transformVectorByMat4(out: vec3, a: vec3, m: mat4) {
  const x = a[0];
  const y = a[1];
  const z = a[2];
  out[0] = m[0] * x + m[4] * y + m[8] * z;
  out[1] = m[1] * x + m[5] * y + m[9] * z;
  out[2] = m[2] * x + m[6] * y + m[10] * z;
  return out;
}

/**
 * Transforms a vector `a` by the transpose of a homogenous transformation matrix `m`.  The
 * translation component of `m` is ignored.
 */
export function transformVectorByMat4Transpose(out: vec3, a: vec3, m: mat4) {
  const x = a[0];
  const y = a[1];
  const z = a[2];
  out[0] = m[0] * x + m[1] * y + m[2] * z;
  out[1] = m[4] * x + m[5] * y + m[6] * z;
  out[2] = m[8] * x + m[9] * y + m[10] * z;
  return out;
}

export function isAABBIntersectingPlane(
  xLower: number,
  yLower: number,
  zLower: number,
  xUpper: number,
  yUpper: number,
  zUpper: number,
  clippingPlanes: Float32Array,
) {
  for (let i = 0; i < 4; ++i) {
    const a = clippingPlanes[i * 4];
    const b = clippingPlanes[i * 4 + 1];
    const c = clippingPlanes[i * 4 + 2];
    const d = clippingPlanes[i * 4 + 3];
    const sum =
      Math.max(a * xLower, a * xUpper) +
      Math.max(b * yLower, b * yUpper) +
      Math.max(c * zLower, c * zUpper) +
      d;
    if (sum < 0) {
      return false;
    }
  }
  {
    const i = 5;
    const a = clippingPlanes[i * 4];
    const b = clippingPlanes[i * 4 + 1];
    const c = clippingPlanes[i * 4 + 2];
    const d = clippingPlanes[i * 4 + 3];
    const maxSum =
      Math.max(a * xLower, a * xUpper) +
      Math.max(b * yLower, b * yUpper) +
      Math.max(c * zLower, c * zUpper);
    const minSum =
      Math.min(a * xLower, a * xUpper) +
      Math.min(b * yLower, b * yUpper) +
      Math.min(c * zLower, c * zUpper);
    const epsilon = Math.abs(d) * 1e-6;
    if (minSum > -d + epsilon || maxSum < -d - epsilon) return false;
  }
  return true;
}


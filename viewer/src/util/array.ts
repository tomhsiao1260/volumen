/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

export interface WritableArrayLike<T> {
  length: number;
  [n: number]: T;
}

export interface TypedArrayConstructor {
  new (length: number): TypedArray;
  new (buffer: ArrayBufferLike, byteOffset: number, length: number): TypedArray;
  of(...values: number[]): TypedArray;
  readonly BYTES_PER_ELEMENT: number;
}

export type TypedArray =
  | Int8Array
  | Uint8Array
  | Int16Array
  | Uint16Array
  | Int32Array
  | Uint32Array
  | Float32Array
  | Float64Array;

export function arraysEqual<T>(a: ArrayLike<T>, b: ArrayLike<T>) {
  const length = a.length;
  if (b.length !== length) return false;
  for (let i = 0; i < length; ++i) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}


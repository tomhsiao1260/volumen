/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

import type { TypedArrayConstructor } from "#src/util/array.js";

/**
 * Voxel data types.  The Vesuvius Challenge scroll volumes are uint8 or uint16; float32 is kept for
 * surface data such as tifxyz coordinates.
 */
export enum DataType {
  UINT8 = 0,
  UINT16 = 1,
  FLOAT32 = 2,
}

export const DATA_TYPE_BYTES: Record<DataType, number> = {
  [DataType.UINT8]: 1,
  [DataType.UINT16]: 2,
  [DataType.FLOAT32]: 4,
};

export const DATA_TYPE_ARRAY_CONSTRUCTOR: Record<
  DataType,
  TypedArrayConstructor
> = {
  [DataType.UINT8]: Uint8Array,
  [DataType.UINT16]: Uint16Array,
  [DataType.FLOAT32]: Float32Array,
};

// Views `byteLength` bytes of `buffer` as values of `dataType`, in the platform's byte order.
export function makeDataTypeArrayView(
  dataType: DataType,
  buffer: ArrayBuffer,
  byteOffset = 0,
  byteLength: number = buffer.byteLength,
): ArrayBufferView {
  return new DATA_TYPE_ARRAY_CONSTRUCTOR[dataType](
    buffer,
    byteOffset,
    byteLength / DATA_TYPE_BYTES[dataType],
  );
}

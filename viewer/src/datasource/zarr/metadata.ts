/** @license Copyright 2023 Google Inc. SPDX-License-Identifier: Apache-2.0 */

import { DataType } from "#src/util/data_type.js";
import {
  parseArray,
  parseFixedLengthArray,
  verifyObject,
  verifyObjectProperty,
  verifyOptionalObjectProperty,
  verifyString,
} from "#src/util/json.js";

export type DimensionSeparator = "/" | ".";

// Supported numpy dtypes.  Values are little-endian (`<`); `|` means byte order does not apply.
const NUMPY_DATA_TYPES = new Map<string, DataType>([
  ["|u1", DataType.UINT8],
  ["<u2", DataType.UINT16],
  ["<f4", DataType.FLOAT32],
]);

/**
 * The parts of a zarr v2 `.zarray` file needed to read and decode chunks.
 */
export interface ArrayMetadata {
  rank: number;
  // Array shape in voxels, in (z, y, x) order.
  shape: number[];
  // Chunk shape in voxels, in (z, y, x) order.
  chunkShape: number[];
  dataType: DataType;
  // Value of the voxels of a chunk whose file is missing from the store.
  fillValue: number;
  // Compression of each chunk file; `null` means chunks are stored uncompressed.
  compressor: "blosc" | null;
  // Separator between the chunk indices of a chunk key, e.g. `52/24/18`.
  dimensionSeparator: DimensionSeparator;
}

function parseShape(obj: unknown): number[] {
  return parseArray(obj, (x) => {
    if (typeof x !== "number" || !Number.isInteger(x) || x < 0) {
      throw new Error(
        `Expected non-negative integer, but received: ${JSON.stringify(x)}`,
      );
    }
    return x;
  });
}

function parseChunkShape(obj: unknown, rank: number): number[] {
  return parseFixedLengthArray(new Array<number>(rank), obj, (x) => {
    if (typeof x !== "number" || !Number.isInteger(x) || x <= 0) {
      throw new Error(
        `Expected positive integer, but received: ${JSON.stringify(x)}`,
      );
    }
    return x;
  });
}

/**
 * A chunk whose file is missing from the store reads as this value.  zarr v2 writes it as a number,
 * or, for floats, as one of the three strings that JSON cannot represent; `null` means zero.
 */
function parseFillValue(dataType: DataType, value: unknown): number {
  if (value === null) return 0;
  if (typeof value === "number") {
    if (dataType !== DataType.FLOAT32 && !Number.isInteger(value)) {
      throw new Error(`Expected integer, but received: ${value}`);
    }
    return value;
  }
  if (dataType === DataType.FLOAT32 && typeof value === "string") {
    if (value === "NaN") return Number.NaN;
    if (value === "Infinity") return Number.POSITIVE_INFINITY;
    if (value === "-Infinity") return Number.NEGATIVE_INFINITY;
  }
  throw new Error(`Unsupported fill value: ${JSON.stringify(value)}`);
}

function parseDimensionSeparator(value: unknown): DimensionSeparator {
  if (value !== "." && value !== "/") {
    throw new Error(
      `Expected "." or "/", but received: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

export function parseV2Metadata(obj: unknown): ArrayMetadata {
  try {
    verifyObject(obj);
    verifyObjectProperty(obj, "zarr_format", (value) => {
      if (value !== 2) {
        throw new Error(`Expected 2, but received: ${JSON.stringify(value)}`);
      }
    });
    const shape = verifyObjectProperty(obj, "shape", parseShape);
    const rank = shape.length;
    const chunkShape = verifyObjectProperty(obj, "chunks", (chunks) =>
      parseChunkShape(chunks, rank),
    );
    verifyObjectProperty(obj, "order", (order) => {
      // Fortran order would need the chunk data transposed, which is not supported.
      if (order !== "C") {
        throw new Error(
          `Expected "C", but received: ${JSON.stringify(order)}`,
        );
      }
    });
    const dimensionSeparator = verifyOptionalObjectProperty(
      obj,
      "dimension_separator",
      parseDimensionSeparator,
      ".",
    );
    const dataType = verifyObjectProperty(obj, "dtype", (dtype) => {
      const dataType = NUMPY_DATA_TYPES.get(verifyString(dtype));
      if (dataType === undefined) {
        throw new Error(
          `Unsupported data type: ${JSON.stringify(dtype)} (supported: ${[
            ...NUMPY_DATA_TYPES.keys(),
          ].join(", ")})`,
        );
      }
      return dataType;
    });
    const fillValue = verifyObjectProperty(obj, "fill_value", (value) =>
      parseFillValue(dataType, value),
    );
    const compressor = verifyObjectProperty(obj, "compressor", (value) => {
      if (value === null) return null;
      verifyObject(value);
      const id = verifyObjectProperty(value, "id", verifyString);
      if (id !== "blosc") {
        throw new Error(`Unsupported compressor: ${JSON.stringify(id)}`);
      }
      return id;
    });
    return {
      rank,
      shape,
      chunkShape,
      dataType,
      fillValue,
      compressor,
      dimensionSeparator,
    };
  } catch (e) {
    throw new Error(`Error parsing zarr v2 metadata: ${(e as Error).message}`);
  }
}

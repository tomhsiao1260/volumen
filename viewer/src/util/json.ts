/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * @file Checks on values parsed from JSON metadata.  Each function returns the value if it has the
 * expected form, and throws otherwise; `verifyObjectProperty` names the property in the message, so
 * that a failure deep in a `.zarray` or `.zattrs` file reads as e.g.
 * `Error parsing "dtype" property: ...`.
 */

import type { WritableArrayLike } from "#src/util/array.js";

export function verifyFiniteFloat(obj: any): number {
  if (typeof obj === "number" && Number.isFinite(obj)) {
    return obj;
  }
  throw new Error(
    `Expected finite floating-point number, but received: ${JSON.stringify(
      obj,
    )}.`,
  );
}

export function verifyFinitePositiveFloat(obj: any): number {
  const x = verifyFiniteFloat(obj);
  if (x > 0) {
    return x;
  }
  throw new Error(
    `Expected positive finite floating-point number, but received: ${x}.`,
  );
}

// Checks that `x' is an array, maps each element by parseElement.
export function parseArray<T>(
  x: any,
  parseElement: (x: any, index: number) => T,
): T[] {
  if (!Array.isArray(x)) {
    throw new Error(`Expected array, but received: ${JSON.stringify(x)}.`);
  }
  return (<any[]>x).map(parseElement);
}

export function parseFixedLengthArray<T, U extends WritableArrayLike<T>>(
  out: U,
  obj: any,
  parseElement: (x: any, index: number) => T,
): U {
  const length = out.length;
  if (!Array.isArray(obj) || obj.length !== length) {
    throw new Error(
      `Expected length ${length} array, but received: ${JSON.stringify(obj)}.`,
    );
  }
  for (let i = 0; i < length; ++i) {
    out[i] = parseElement(obj[i], i);
  }
  return out;
}

export function verifyObject(obj: any) {
  if (typeof obj !== "object" || obj == null || Array.isArray(obj)) {
    throw new Error(
      `Expected JSON object, but received: ${JSON.stringify(obj)}.`,
    );
  }
  return obj;
}

export function verifyString(obj: any) {
  if (typeof obj !== "string") {
    throw new Error(`Expected string, but received: ${JSON.stringify(obj)}.`);
  }
  return obj;
}

export function verifyObjectProperty<T>(
  obj: any,
  propertyName: string,
  validator: (value: any) => T,
): T {
  const value = Object.prototype.hasOwnProperty.call(obj, propertyName)
    ? obj[propertyName]
    : undefined;
  try {
    return validator(value);
  } catch (parseError) {
    throw new Error(
      `Error parsing ${JSON.stringify(propertyName)} property: ${
        (parseError as Error).message
      }`,
    );
  }
}

// Like `verifyObjectProperty`, but a property that is not there gets `defaultValue`.
export function verifyOptionalObjectProperty<T>(
  obj: any,
  propertyName: string,
  validator: (value: any) => T,
  defaultValue: T,
): T {
  return verifyObjectProperty(obj, propertyName, (x) =>
    x === undefined ? defaultValue : validator(x),
  );
}

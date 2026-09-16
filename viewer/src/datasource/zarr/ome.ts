/** @license Copyright 2022 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * @file The OME metadata of a `.zattrs` file: where each scale of the volume sits in the coordinate
 * space shared by all of them.
 *
 * OME describes that with a list of coordinate transformations per scale.  Only `scale`, `identity`
 * and `translation` are allowed here, so each scale reduces to one factor and one offset per
 * dimension, which is what `OmeMultiscaleScale` holds.
 */

import {
  parseArray,
  parseFixedLengthArray,
  verifyFiniteFloat,
  verifyFinitePositiveFloat,
  verifyObject,
  verifyObjectProperty,
  verifyString,
} from "#src/util/json.js";

// Where one scale sits, per zarr dimension, in voxels of the full-resolution scale.
export interface OmeMultiscaleScale {
  // Path of the scale's array within the store, e.g. `0`.
  path: string;
  // Size of one of its voxels.
  scale: Float64Array;
  // Position of its voxel (0, 0, 0).
  translation: Float64Array;
}

export interface OmeMultiscaleMetadata {
  // Number of axes.
  rank: number;
  scales: OmeMultiscaleScale[];
}

const SUPPORTED_OME_MULTISCALE_VERSIONS = new Set(["0.4", "0.5-dev"]);

// The axes the viewer shows, in the order zarr lists them.
const AXIS_NAMES = ["z", "y", "x"];

/**
 * Checks that the volume has the three spatial axes the viewer shows, and returns their number.
 *
 * The viewer works in voxels rather than physical units, so the scale and unit of each axis are not
 * needed; but it does show the axes in a fixed order, so a volume with other axes (a time or channel
 * axis, say) is rejected here rather than displayed with its axes mixed up.
 */
function parseOmeAxes(axes: unknown): number {
  const names = parseArray(axes, (axis) =>
    verifyObjectProperty(verifyObject(axis), "name", verifyString),
  );
  if (
    names.length !== AXIS_NAMES.length ||
    names.some((name, i) => name !== AXIS_NAMES[i])
  ) {
    throw new Error(
      `Expected axes (${AXIS_NAMES.join(", ")}), but received: (${names.join(", ")})`,
    );
  }
  return names.length;
}

// A scale factor and offset per dimension; `apply` composes another transform on top of this one.
interface Transform {
  scale: Float64Array;
  translation: Float64Array;
}

function identityTransform(rank: number): Transform {
  return { scale: new Float64Array(rank).fill(1), translation: new Float64Array(rank) };
}

function parseVector(rank: number, obj: unknown, name: string, positive: boolean) {
  return verifyObjectProperty(obj, name, (values) =>
    parseFixedLengthArray(
      new Float64Array(rank),
      values,
      positive ? verifyFinitePositiveFloat : verifyFiniteFloat,
    ),
  );
}

/**
 * Folds the `coordinateTransformations` of a scale, in order, into one transform: scaling by `s`
 * scales what came before it, while translating by `t` adds to it.
 */
function parseOmeCoordinateTransforms(
  rank: number,
  transforms: unknown,
): Transform {
  const result = identityTransform(rank);
  if (transforms === undefined) return result;
  parseArray(transforms, (transformJson) => {
    verifyObject(transformJson);
    const type = verifyObjectProperty(transformJson, "type", verifyString);
    if (type === "scale") {
      const scale = parseVector(rank, transformJson, "scale", true);
      for (let i = 0; i < rank; ++i) {
        result.scale[i] *= scale[i];
        result.translation[i] *= scale[i];
      }
    } else if (type === "translation") {
      const translation = parseVector(rank, transformJson, "translation", false);
      for (let i = 0; i < rank; ++i) {
        result.translation[i] += translation[i];
      }
    } else if (type !== "identity") {
      throw new Error(
        `Unsupported coordinate transform type: ${JSON.stringify(type)}`,
      );
    }
  });
  return result;
}

function parseOmeMultiscale(multiscale: unknown): OmeMultiscaleMetadata {
  const rank = verifyObjectProperty(multiscale, "axes", parseOmeAxes);
  // A transform of the multiscale volume as a whole applies on top of each scale's own.
  const outer = verifyObjectProperty(
    multiscale,
    "coordinateTransformations",
    (x) => parseOmeCoordinateTransforms(rank, x),
  );
  const scales = verifyObjectProperty(multiscale, "datasets", (obj) =>
    parseArray(obj, (dataset): OmeMultiscaleScale => {
      const path = verifyObjectProperty(dataset, "path", verifyString);
      const inner = verifyObjectProperty(
        dataset,
        "coordinateTransformations",
        (x) => parseOmeCoordinateTransforms(rank, x),
      );
      const scale = new Float64Array(rank);
      const translation = new Float64Array(rank);
      for (let i = 0; i < rank; ++i) {
        scale[i] = outer.scale[i] * inner.scale[i];
        translation[i] =
          outer.scale[i] * inner.translation[i] + outer.translation[i];
      }
      return { path, scale, translation };
    }),
  );
  if (scales.length === 0) {
    throw new Error("At least one scale must be specified");
  }

  // A copy, because the loop below divides the first scale's own factors by it.
  const baseScale = Float64Array.from(scales[0].scale);
  for (const { scale, translation } of scales) {
    for (let i = 0; i < rank; ++i) {
      // In OME's coordinate space, the origin of a voxel is its center, while in Neuroglancer it is
      // the "lower" (in coordinates) corner.  Move by half a voxel of this scale.
      translation[i] -= scale[i] * 0.5;
      // Measure in voxels of the full-resolution scale rather than in physical units.
      scale[i] /= baseScale[i];
      translation[i] /= baseScale[i];
    }
  }
  return { rank, scales };
}

/**
 * Returns the multiscale volume described by the OME metadata of a `.zattrs` file.  A `.zattrs` file
 * may describe several multiscale volumes; the viewer shows the first one.
 */
export function parseOmeMetadata(attrs: any): OmeMultiscaleMetadata {
  if (attrs.multiscales === undefined) {
    throw new Error(
      "No OME multiscale metadata found: `.zattrs` has no `multiscales` property",
    );
  }
  const multiscale = verifyObjectProperty(attrs, "multiscales", (value) => {
    const multiscales = parseArray(value, verifyObject);
    if (multiscales.length === 0) {
      throw new Error("At least one multiscale volume must be specified");
    }
    return multiscales[0];
  });
  const version = verifyObjectProperty(multiscale, "version", verifyString);
  if (!SUPPORTED_OME_MULTISCALE_VERSIONS.has(version)) {
    throw new Error(
      `OME multiscale metadata version ${JSON.stringify(
        version,
      )} is not supported`,
    );
  }
  return parseOmeMultiscale(multiscale);
}

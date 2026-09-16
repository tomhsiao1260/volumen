/** @license Copyright 2020 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * Simple implementation of the error function
 *
 * https://en.wikipedia.org/wiki/Error_function
 *
 * Precision is 2.5e-5
 */
export function erf(x: number) {
  // Abramowitz and Stegun. Handbook of Mathematical Functions
  // Formula 7.1.26
  // http://people.math.sfu.ca/~cbm/aands/frameindex.htm
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const t = 1 / (1 + p * Math.abs(x));
  const y =
    1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return Math.sign(x) * y;
}

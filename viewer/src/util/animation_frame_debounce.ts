/** @license Copyright 2017 Google Inc. SPDX-License-Identifier: Apache-2.0 */

export interface DebouncedFunction {
  /**
   * Ensures the wrapped function will be run at the next animation frame.
   */
  (): void;

  /**
   * Cancels any outstanding call.
   */
  cancel(): void;

  /**
   * Runs any outstanding call immediately.
   */
  flush(): void;
}

/**
 * Returns a function that, when called, ensures `callback` is invoked at the next animation frame.
 */
export function animationFrameDebounce(
  callback: () => void,
): DebouncedFunction {
  let handle = -1;
  const cancel = () => {
    if (handle !== -1) {
      cancelAnimationFrame(handle);
      handle = -1;
    }
  };
  const flush = () => {
    if (handle !== -1) {
      handle = -1;
      callback();
    }
  };
  return Object.assign(
    () => {
      if (handle === -1) {
        handle = requestAnimationFrame(() => {
          handle = -1;
          callback();
        });
      }
    },
    { flush, cancel },
  );
}

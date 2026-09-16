/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * @file Signals: `dispatch` calls every handler that was added, in the order they were added.  A
 * handler added while `dispatch` runs is called before it returns.
 */

export class Signal<Callable extends Function = () => void> {
  private handlers = new Set<Callable>();

  constructor() {
    const obj = this;
    this.dispatch = <Callable>(<Function>function (this: any) {
      obj.handlers.forEach((handler) => {
        // eslint-disable-next-line prefer-rest-params
        handler.apply(this, arguments);
      });
    });
  }

  // Returns a function that removes the handler again.
  add(handler: Callable): () => boolean {
    this.handlers.add(handler);
    return () => {
      return this.remove(handler);
    };
  }

  // Returns whether the handler was there.  A handler removed during `dispatch` is not called.
  remove(handler: Callable): boolean {
    return this.handlers.delete(handler);
  }

  // Calls the handlers with the arguments (and `this`) it is called with.
  dispatch: Callable;

  // Nothing may be called afterwards, `dispatch` included.
  dispose() {
    this.handlers = <any>undefined;
  }
}

export class NullarySignal extends Signal<() => void> {}

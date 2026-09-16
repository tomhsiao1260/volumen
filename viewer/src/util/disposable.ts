/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

export interface Disposable {
  dispose: () => void;
}

export type Disposer = Disposable | (() => void);

export function invokeDisposer(disposer: Disposer) {
  if (typeof disposer === "object") {
    disposer.dispose();
  } else {
    disposer();
  }
}

export function invokeDisposers(disposers: Disposer[]) {
  for (let i = disposers.length; i > 0; --i) {
    invokeDisposer(disposers[i - 1]);
  }
}

export class RefCounted implements Disposable {
  public refCount = 1;
  wasDisposed: boolean | undefined;
  private disposers!: Disposer[];
  addRef() {
    ++this.refCount;
    return this;
  }
  dispose() {
    if (--this.refCount !== 0) {
      return;
    }
    this.refCountReachedZero();
  }

  protected refCountReachedZero() {
    this.disposed();
    const { disposers } = this;
    if (disposers !== undefined) {
      invokeDisposers(disposers);
      this.disposers = <any>undefined;
    }
    this.wasDisposed = true;
  }
  disposed() {}
  registerDisposer<T extends Disposer>(f: T): T {
    const { disposers } = this;
    if (disposers == null) {
      this.disposers = [f];
    } else {
      disposers.push(f);
    }
    return f;
  }
  registerCancellable<T extends { cancel: () => void }>(cancellable: T) {
    this.registerDisposer(() => {
      cancellable.cancel();
    });
    return cancellable;
  }
}

/**
 * A variable of this type is associated with an increment of the reference count.  If a function
 * parameter is declared with this type, then callers must donate a reference count.
 */
export type Owned<T extends Disposable> = T;

/**
 * A variable of this type is not associated with an increment of the reference count.
 */
export type Borrowed<T extends Disposable> = T;


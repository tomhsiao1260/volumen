/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */
import { NullarySignal, Signal } from "#src/util/signal.js";

export interface WatchableValueInterface<T> {
  value: T;
  changed: NullarySignal;
}

export interface WatchableValueChangeInterface<T> {
  readonly value: T;
  readonly changed: Signal<(oldValue: T, newValue: T) => void>;
}

export class WatchableValue<T> implements WatchableValueInterface<T> {
  get value() {
    return this.value_;
  }
  set value(newValue: T) {
    if (newValue !== this.value_) {
      this.value_ = newValue;
      this.changed.dispatch();
    }
  }
  changed = new NullarySignal();
  constructor(protected value_: T) {}
}

/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * @file Facility for sharing arbitrary values that support structural cloning between threads.
 */

import type { WatchableValueInterface } from "#src/state/trackable_value.js";
import { WatchableValue } from "#src/state/trackable_value.js";
import type { RPC } from "#src/worker/worker_rpc.js";
import {
  registerRPC,
  registerSharedObject,
  SharedObjectCounterpart,
} from "#src/worker/worker_rpc.js";

const CHANGED_RPC_METHOD_ID = "SharedWatchableValue.changed";

@registerSharedObject("SharedWatchableValue")
export class SharedWatchableValue<T>
  extends SharedObjectCounterpart
  implements WatchableValueInterface<T>
{
  base!: WatchableValueInterface<T>;

  /**
   * The value is being updated to reflect a remote change.
   * @internal
   */
  updatingValue_ = false;

  constructor(rpc?: RPC, options: any = {}) {
    super(rpc, options);
    if (rpc !== undefined) {
      this.base = new WatchableValue<T>(options.value);
      this.setupChangedHandler();
    }
  }

  initializeCounterpart(rpc: RPC, options: any = {}) {
    options.value = this.value;
    super.initializeCounterpart(rpc, options);
  }

  private setupChangedHandler() {
    this.registerDisposer(
      this.base.changed.add(() => {
        // A change that came from the other side is not sent back to it.
        if (this.updatingValue_) return;
        const { rpc } = this;
        if (rpc !== null) {
          rpc.invoke(CHANGED_RPC_METHOD_ID, {
            id: this.rpcId,
            value: this.value,
          });
        }
      }),
    );
  }

  static makeFromExisting<T>(rpc: RPC, base: WatchableValueInterface<T>) {
    const obj = new SharedWatchableValue<T>();
    obj.base = base;
    obj.setupChangedHandler();
    obj.initializeCounterpart(rpc);
    return obj;
  }

  get value() {
    return this.base.value;
  }

  set value(value: T) {
    this.base.value = value;
  }

  get changed() {
    return this.base.changed;
  }
}

registerRPC(CHANGED_RPC_METHOD_ID, function (x) {
  const obj = <SharedWatchableValue<any>>this.get(x.id);
  obj.updatingValue_ = true;
  obj.base.value = x.value;
  obj.updatingValue_ = false;
});

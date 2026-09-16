/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

export interface ComparisonFunction<T> {
  (a: T, b: T): boolean;
}

/**
 * Pairing heap whose nodes link themselves through three of their own fields, named when the heap is
 * created (e.g. `child0`, `next0`, `prev0`).  A node can be in two heaps at once if the heaps use
 * different fields.  The root is the minimum element according to `compare`.
 */
export class PairingHeap<T> {
  constructor(
    // Returns true iff a < b.
    private compare: ComparisonFunction<T>,
    private child: string,
    private next: string,
    private prev: string,
  ) {}

  meld(a: T | null, b: T | null): T | null {
    if (b === null) {
      return a;
    }
    if (a === null) {
      return b;
    }
    if (this.compare(b, a)) {
      const temp = a;
      a = b;
      b = temp;
    }
    const { child, next, prev } = this;
    const aChild = (a as any)[child];
    (b as any)[next] = aChild;
    (b as any)[prev] = a;
    if (aChild !== null) {
      aChild[prev] = b;
    }
    (a as any)[child] = b;
    return a;
  }

  // Melds the children of `node` into one heap and returns its root.
  private combineChildren(node: T): T | null {
    const { next, prev } = this;
    let cur = (node as any)[this.child];
    if (cur === null) {
      return null;
    }
    // Meld the children in pairs, building a singly linked list (through `next`) of the results.
    let head: any = null;
    while (true) {
      const curNext = cur[next];
      let rest: any;
      let m: any;
      if (curNext === null) {
        rest = null;
        m = cur;
      } else {
        rest = curNext[next];
        m = this.meld(cur, curNext);
      }
      m[next] = head;
      head = m;
      if (rest === null) {
        break;
      }
      cur = rest;
    }

    // Then meld the results into one heap.
    let root = head;
    head = head[next];
    while (head !== null) {
      const headNext = head[next];
      root = this.meld(root, head);
      head = headNext;
    }
    root[prev] = null;
    root[next] = null;
    return root;
  }

  removeMin(root: T): T | null {
    const newRoot = this.combineChildren(root);
    const r = root as any;
    r[this.next] = null;
    r[this.prev] = null;
    r[this.child] = null;
    return newRoot;
  }

  remove(root: T, node: T): T | null {
    if (root === node) {
      return this.removeMin(root);
    }
    const { child, next, prev } = this;
    const n = node as any;
    const prevNode = n[prev];
    const nextNode = n[next];
    if (prevNode[child] === node) {
      prevNode[child] = nextNode;
    } else {
      prevNode[next] = nextNode;
    }
    if (nextNode !== null) {
      nextNode[prev] = prevNode;
    }
    const newRoot = this.meld(root, this.combineChildren(node));
    n[next] = null;
    n[prev] = null;
    n[child] = null;
    return newRoot;
  }
}

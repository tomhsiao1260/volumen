/** @license Copyright 2016 Google Inc. SPDX-License-Identifier: Apache-2.0 */

/**
 * Circular doubly linked list whose nodes link themselves through two of their own fields, named
 * when the list is created (e.g. `next0`, `prev0`).  A node can be in two lists at once if the lists
 * use different fields.  The list hangs off a head node that is not an element.
 */
export class LinkedList<T> {
  constructor(
    private next: string,
    private prev: string,
  ) {}

  initializeHead(head: T) {
    (head as any)[this.next] = (head as any)[this.prev] = head;
  }

  // Inserts `x` at the front of the list.
  insertAfter(head: T, x: T) {
    const { next, prev } = this;
    const h = head as any;
    const n = x as any;
    const first = h[next];
    n[next] = first;
    n[prev] = head;
    h[next] = x;
    first[prev] = x;
  }

  front(head: T): T | null {
    const first = (head as any)[this.next];
    return first === head ? null : first;
  }

  back(head: T): T | null {
    const last = (head as any)[this.prev];
    return last === head ? null : last;
  }

  // Removes `x` from the list it is in.
  pop(x: T) {
    const { next, prev } = this;
    const n = x as any;
    const nextNode = n[next];
    const prevNode = n[prev];
    nextNode[prev] = prevNode;
    prevNode[next] = nextNode;
    n[next] = null;
    n[prev] = null;
    return x;
  }
}

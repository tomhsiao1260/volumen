/**
 * @file What the board owns outside React: the viewer, the volumes its cards show, and the groups of
 * linked cards.  These have lifetimes of their own — a volume is downloaded once however often a
 * card re-renders — so they live in a ref rather than in state.
 *
 * A lost WebGL context means a whole new session: everything above belonged to the viewer that is
 * gone.  `Session.replace` builds one, remembering where each group was looking so that the cards
 * come back as they were.
 */

import type { Point, View } from "viewer";
import { Viewer } from "viewer";
import { VolumeRegistry } from "../api/sources";
import { LinkGroup } from "./links";

export interface GroupPlace {
  position: { x: number; y: number; z: number } | null;
  zoom: number | null;
}

export class Session {
  readonly viewer: Viewer;
  readonly volumes: VolumeRegistry;
  private groups = new Map<string, LinkGroup>();

  constructor(container: HTMLElement) {
    this.viewer = new Viewer({ container });
    this.volumes = new VolumeRegistry(this.viewer);
    // The viewer reports the voxel under the pointer for the view it is over, and nothing for the
    // others, so each card hears only about itself.
    this.viewer.onPointerMove((point, view) => {
      this.pointerListeners.get(view)?.(point);
    });
  }

  // Set by each card, so that it can show the voxel under the pointer.
  private pointerListeners = new Map<
    View,
    (point: Point | undefined) => void
  >();

  watchPointer(view: View, listener: (point: Point | undefined) => void) {
    this.pointerListeners.set(view, listener);
    return () => this.pointerListeners.delete(view);
  }

  // The group of `id`, made the first time a card asks for it.
  group(id: string) {
    let group = this.groups.get(id);
    if (group === undefined) {
      group = new LinkGroup(id);
      this.groups.set(id, group);
    }
    return group;
  }

  // Where each group is looking, which is what the saved board holds and what a restart puts back.
  places() {
    const places = new Map<string, GroupPlace>();
    for (const [id, group] of this.groups) {
      places.set(id, {
        position: group.navigation?.position ?? null,
        zoom: group.navigation?.zoom ?? null,
      });
    }
    return places;
  }

  // Puts the groups back where `places` says, once their volumes have loaded.
  restore(places: Map<string, GroupPlace>) {
    for (const [id, place] of places) {
      this.groups.get(id)?.restore(place.position, place.zoom);
    }
  }

  dispose() {
    for (const group of this.groups.values()) group.dispose();
    this.groups.clear();
    this.viewer.dispose();
  }
}

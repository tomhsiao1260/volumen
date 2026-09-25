/**
 * @file Winding annotations: what a person has said about which sheet is which.
 *
 * Two kinds, and they are the community's, not ours
 * (scrollprize.org/open_problems/winding_annotations):
 *
 *   same   these points are all on the same wrap of the papyrus
 *   step   these points are one wrap apart, counted outward
 *
 * The fit is good at following a sheet and bad at two things we have measured: it jumps to the
 * neighbouring sheet in one part of a piece, and the sheet spacing it takes at the seed is often a
 * fifth to a half wrong.  Both are things a reader can see at a glance and the prediction cannot —
 * which is what makes them worth asking a person about.
 *
 * They belong to a scan, not to a card or a piece: cards are closed, re-opened and zoomed, and a
 * piece is rebuilt whenever any of that happens, but what was said about the papyrus stays true.
 * They are kept on the server beside the board rather than in it (`server/src/utils/windings.ts`).
 */

import { SERVER_API_ENDPOINT } from "../config";

export interface WindPoint {
  id: string;
  // The voxel, in the scan's own full-resolution grid.
  at: { x: number; y: number; z: number };
  // Which wrap, counted along the chain; null on a `same` chain.  Only differences mean anything.
  turn: number | null;
  madeAt: number;
}

export interface WindChain {
  id: string;
  // `sample/scanId`, e.g. `PHercParis4/20260411134726` — see `scanOf` in `api/sources.ts`.
  scan: string;
  kind: "same" | "step";
  points: WindPoint[];
  on: boolean;
  note: string;
  author: string;
  rev: number;
  madeAt: number;
  deletedAt?: number;
}

const chains = new Map<string, WindChain>();
const asked = new Set<string>();
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) listener();
}

export function watchChains(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// The chains of one scan that are still there, newest last.
export function chainsOf(scan: string | undefined) {
  if (scan === undefined || scan === "") return [];
  return [...chains.values()]
    .filter((chain) => chain.scan === scan && chain.deletedAt === undefined)
    .sort((a, b) => a.madeAt - b.madeAt);
}

export function chain(id: string) {
  return chains.get(id);
}

// Reads a scan's chains from the server, once per scan and page.
export async function loadChains(scan: string) {
  if (scan === "" || asked.has(scan)) return;
  asked.add(scan);
  try {
    const response = await fetch(`${SERVER_API_ENDPOINT}/api/windings/${scan}`);
    if (!response.ok) throw new Error(await response.text());
    const stored = (await response.json()) as { chains: WindChain[] };
    for (const one of stored.chains) chains.set(one.id, one);
    changed();
  } catch (error) {
    asked.delete(scan);
    console.error("Failed to read the winding annotations:", error);
  }
}

/*
 * Held for a moment before saving, so that placing five points in a row is one write; and sent as
 * just what changed, so that two windows on the same scan do not overwrite each other.
 */
const SAVE_DELAY_MS = 400;
const waiting = new Map<string, Set<string>>();
let timer: ReturnType<typeof setTimeout> | undefined;

function schedule(scan: string, id: string) {
  let ids = waiting.get(scan);
  if (ids === undefined) waiting.set(scan, (ids = new Set()));
  ids.add(id);
  if (timer !== undefined) return;
  timer = setTimeout(() => {
    timer = undefined;
    const sending = [...waiting];
    waiting.clear();
    for (const [scan, ids] of sending) void send(scan, ids);
  }, SAVE_DELAY_MS);
}

async function send(scan: string, ids: Set<string>) {
  const sending = [...ids].map((id) => chains.get(id)).filter((one): one is WindChain => one !== undefined);
  if (sending.length === 0) return;
  try {
    const response = await fetch(`${SERVER_API_ENDPOINT}/api/windings/${scan}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chains: sending }),
    });
    if (!response.ok) throw new Error(await response.text());
  } catch (error) {
    console.error("Failed to save the winding annotations:", error);
  }
}

// Puts a chain in and saves it.  The revision is raised here, so that a merge can tell which is newer.
export function setChain(one: WindChain) {
  const had = chains.get(one.id);
  const saved = { ...one, rev: Math.max(one.rev, (had?.rev ?? 0) + 1) };
  chains.set(saved.id, saved);
  schedule(saved.scan, saved.id);
  changed();
  return saved;
}

// Deleting leaves a tombstone, so that the deletion merges like anything else.
export function forgetChain(id: string) {
  const had = chains.get(id);
  if (had === undefined) return;
  setChain({ ...had, points: [], deletedAt: Date.now() });
}

let nextId = 0;

export function newChainId() {
  return `w${Date.now().toString(36)}${(nextId++).toString(36)}`;
}

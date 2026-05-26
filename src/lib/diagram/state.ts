/**
 * Tiny Zustand-style store for the diagram mode.
 *
 * Single source of truth replacing the source HTML's global `S = {...}` plus
 * the ~28 `window.*` slots. Consumers subscribe to slices of state via
 * selectors; only subscribers whose selector output changes are notified.
 */

import {
  createDiagramId,
  createEmptyDoc,
  createInitialEphemeral,
  type DiagramStateRoot,
} from "./types";

export type Listener<T> = (snapshot: T) => void;
export type Selector<T> = (state: DiagramStateRoot) => T;
export type Updater = (state: DiagramStateRoot) => DiagramStateRoot;

export interface DiagramStore {
  getState(): DiagramStateRoot;
  setState(updater: Updater | DiagramStateRoot): void;
  subscribe(listener: Listener<DiagramStateRoot>): () => void;
  subscribeSelector<T>(
    selector: Selector<T>,
    listener: Listener<T>,
    equality?: (a: T, b: T) => boolean,
  ): () => void;
}

const defaultEquality = <T,>(a: T, b: T): boolean => Object.is(a, b);

export function createDiagramStore(
  initial?: Partial<DiagramStateRoot>,
): DiagramStore {
  let state: DiagramStateRoot = {
    doc: initial?.doc ?? createEmptyDoc(createDiagramId()),
    ephemeral: initial?.ephemeral ?? createInitialEphemeral(),
  };
  const listeners = new Set<Listener<DiagramStateRoot>>();

  function getState(): DiagramStateRoot {
    return state;
  }

  function setState(updater: Updater | DiagramStateRoot): void {
    const next = typeof updater === "function" ? updater(state) : updater;
    if (next === state) return;
    state = next;
    for (const listener of listeners) listener(state);
  }

  function subscribe(listener: Listener<DiagramStateRoot>): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function subscribeSelector<T>(
    selector: Selector<T>,
    listener: Listener<T>,
    equality: (a: T, b: T) => boolean = defaultEquality,
  ): () => void {
    let last = selector(state);
    return subscribe((next) => {
      const value = selector(next);
      if (!equality(value, last)) {
        last = value;
        listener(value);
      }
    });
  }

  return { getState, setState, subscribe, subscribeSelector };
}

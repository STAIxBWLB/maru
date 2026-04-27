/** In-memory navigation history for wikilink jumps. Phase 1A keeps it
 *  ephemeral (no localStorage) — tolaria's persisted variant lands later. */
export interface NavHistory {
  /** Paths the user can return to via ⌘[. Most-recent at the end. */
  back: string[];
  /** Paths the user can re-visit via ⌘] after going back. */
  forward: string[];
}

export const emptyHistory: NavHistory = { back: [], forward: [] };

/** Push `current` onto the back stack and clear forward. Call this *before*
 *  navigating to a new entry (so the user can come back to where they were). */
export function pushHistory(history: NavHistory, currentPath: string): NavHistory {
  if (history.back[history.back.length - 1] === currentPath) return history;
  return { back: [...history.back, currentPath], forward: [] };
}

/** Pop one entry off the back stack into a "navigate-to" slot, moving the
 *  current path onto the forward stack. Returns null target when there's
 *  nothing to go back to. */
export function goBack(
  history: NavHistory,
  currentPath: string,
): { history: NavHistory; target: string | null } {
  if (history.back.length === 0) return { history, target: null };
  const target = history.back[history.back.length - 1];
  return {
    history: {
      back: history.back.slice(0, -1),
      forward: [currentPath, ...history.forward],
    },
    target,
  };
}

/** Inverse of goBack — pull the most-recently-popped entry off forward. */
export function goForward(
  history: NavHistory,
  currentPath: string,
): { history: NavHistory; target: string | null } {
  if (history.forward.length === 0) return { history, target: null };
  const [target, ...rest] = history.forward;
  return {
    history: {
      back: [...history.back, currentPath],
      forward: rest,
    },
    target,
  };
}

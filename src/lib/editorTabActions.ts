export interface EditorTabIdState {
  activeTabId: string | null;
  leftActiveTabId: string | null;
  rightActiveTabId: string | null;
}

export interface EditorTabLike {
  id: string;
  dirty?: boolean;
}

export function replaceEditorTabIds(
  state: EditorTabIdState,
  oldId: string,
  newId: string,
): EditorTabIdState {
  const replace = (value: string | null) => (value === oldId ? newId : value);
  return {
    activeTabId: replace(state.activeTabId),
    leftActiveTabId: replace(state.leftActiveTabId),
    rightActiveTabId: replace(state.rightActiveTabId),
  };
}

export function tabIdsToCloseOthers<T extends EditorTabLike>(
  tabs: T[],
  targetId: string,
): string[] {
  return tabs.filter((tab) => tab.id !== targetId).map((tab) => tab.id);
}

export function tabIdsToCloseRight<T extends EditorTabLike>(
  tabs: T[],
  targetId: string,
): string[] {
  const index = tabs.findIndex((tab) => tab.id === targetId);
  if (index < 0) return [];
  return tabs.slice(index + 1).map((tab) => tab.id);
}

export function tabIdsToCloseSaved<T extends EditorTabLike>(tabs: T[]): string[] {
  return tabs.filter((tab) => !tab.dirty).map((tab) => tab.id);
}

export function orderTabsById<T extends EditorTabLike>(tabs: T[], order: string[]): T[] {
  const byId = new Map(tabs.map((tab) => [tab.id, tab]));
  const seen = new Set<string>();
  const ordered: T[] = [];
  for (const id of order) {
    const tab = byId.get(id);
    if (!tab || seen.has(id)) continue;
    ordered.push(tab);
    seen.add(id);
  }
  for (const tab of tabs) {
    if (seen.has(tab.id)) continue;
    ordered.push(tab);
    seen.add(tab.id);
  }
  return ordered;
}

export function nextFallbackTabIdAfterClose<T extends EditorTabLike>(
  tabs: T[],
  closingIds: Set<string> | string[],
  anchorId: string,
): string | null {
  const closeSet = Array.isArray(closingIds) ? new Set(closingIds) : closingIds;
  const anchorIndex = tabs.findIndex((tab) => tab.id === anchorId);
  const remaining = tabs.filter((tab) => !closeSet.has(tab.id));
  if (remaining.length === 0) return null;
  if (anchorIndex < 0) return remaining[remaining.length - 1]?.id ?? null;
  const leftRemainingCount = tabs
    .slice(0, anchorIndex)
    .filter((tab) => !closeSet.has(tab.id)).length;
  return remaining[Math.min(leftRemainingCount, remaining.length - 1)]?.id ?? null;
}

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

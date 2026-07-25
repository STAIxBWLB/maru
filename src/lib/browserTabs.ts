// Pure tab-strip state for the in-app browser. Each tab maps 1:1 to a native
// child webview, so the id is also part of that webview's label — ids stay in
// a conservative alphabet and the count is capped.

export interface BrowserTab {
  id: string;
  url: string;
  title: string | null;
  loading: boolean;
  /** Set when the tab was opened from a bookmark, so the sidebar can mark it. */
  siteId: string | null;
}

/** Mirrors MAX_TABS in src-tauri/src/site_view.rs. */
export const MAX_BROWSER_TABS = 12;

export function nextBrowserTabId(tabs: BrowserTab[]): string {
  const used = new Set(tabs.map((tab) => tab.id));
  for (let index = 1; ; index += 1) {
    const id = `t${index}`;
    if (!used.has(id)) return id;
  }
}

export function openBrowserTab(
  tabs: BrowserTab[],
  tab: BrowserTab,
): { tabs: BrowserTab[]; opened: boolean } {
  if (tabs.some((entry) => entry.id === tab.id)) {
    return { tabs: updateBrowserTab(tabs, tab.id, tab), opened: true };
  }
  if (tabs.length >= MAX_BROWSER_TABS) return { tabs, opened: false };
  return { tabs: [...tabs, tab], opened: true };
}

export function updateBrowserTab(
  tabs: BrowserTab[],
  id: string,
  patch: Partial<Omit<BrowserTab, "id">>,
): BrowserTab[] {
  return tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab));
}

/** Closing the active tab activates its right neighbour, else its left one —
 *  the behavior every tabbed browser has. */
export function closeBrowserTab(
  tabs: BrowserTab[],
  id: string,
  activeId: string | null,
): { tabs: BrowserTab[]; activeId: string | null } {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return { tabs, activeId };
  const next = tabs.filter((tab) => tab.id !== id);
  if (activeId !== id) return { tabs: next, activeId };
  const neighbour = next[index] ?? next[index - 1] ?? null;
  return { tabs: next, activeId: neighbour?.id ?? null };
}

/** Label for a tab button: page title, else the host, else the raw URL. */
export function browserTabLabel(tab: BrowserTab, fallback: string): string {
  if (tab.title?.trim()) return tab.title.trim();
  try {
    return new URL(tab.url).host || fallback;
  } catch {
    return tab.url || fallback;
  }
}

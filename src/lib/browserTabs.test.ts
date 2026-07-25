import { describe, expect, it } from "vitest";
import {
  browserTabLabel,
  closeBrowserTab,
  MAX_BROWSER_TABS,
  nextBrowserTabId,
  openBrowserTab,
  updateBrowserTab,
  type BrowserTab,
} from "./browserTabs";

function tab(id: string, overrides: Partial<BrowserTab> = {}): BrowserTab {
  return {
    id,
    url: `https://example.com/${id}`,
    title: null,
    loading: false,
    siteId: null,
    ...overrides,
  };
}

describe("browser tabs", () => {
  it("reuses freed ids instead of growing forever", () => {
    const tabs = [tab("t1"), tab("t3")];
    expect(nextBrowserTabId(tabs)).toBe("t2");
    expect(nextBrowserTabId([])).toBe("t1");
  });

  it("refuses to open past the native webview cap", () => {
    const full = Array.from({ length: MAX_BROWSER_TABS }, (_, index) =>
      tab(`t${index + 1}`),
    );
    const result = openBrowserTab(full, tab("overflow"));
    expect(result.opened).toBe(false);
    expect(result.tabs).toHaveLength(MAX_BROWSER_TABS);
  });

  it("treats reopening an existing id as an update", () => {
    const tabs = [tab("t1"), tab("t2")];
    const result = openBrowserTab(tabs, tab("t2", { url: "https://maru.dev" }));
    expect(result.opened).toBe(true);
    expect(result.tabs).toHaveLength(2);
    expect(result.tabs[1].url).toBe("https://maru.dev");
  });

  it("activates the right neighbour when the active tab closes", () => {
    const tabs = [tab("t1"), tab("t2"), tab("t3")];
    expect(closeBrowserTab(tabs, "t2", "t2").activeId).toBe("t3");
    expect(closeBrowserTab(tabs, "t3", "t3").activeId).toBe("t2");
    expect(closeBrowserTab([tab("t1")], "t1", "t1").activeId).toBeNull();
  });

  it("leaves the active tab alone when another one closes", () => {
    const tabs = [tab("t1"), tab("t2")];
    const result = closeBrowserTab(tabs, "t1", "t2");
    expect(result.activeId).toBe("t2");
    expect(result.tabs).toHaveLength(1);
  });

  it("patches only the addressed tab", () => {
    const tabs = [tab("t1"), tab("t2")];
    const next = updateBrowserTab(tabs, "t2", { loading: true });
    expect(next[0].loading).toBe(false);
    expect(next[1].loading).toBe(true);
  });

  it("labels tabs by title, then host, then raw value", () => {
    expect(browserTabLabel(tab("t1", { title: "  Maru  " }), "New tab")).toBe("Maru");
    expect(browserTabLabel(tab("t1", { url: "https://maru.dev/docs" }), "New tab")).toBe(
      "maru.dev",
    );
    expect(browserTabLabel(tab("t1", { url: "" }), "New tab")).toBe("New tab");
  });
});

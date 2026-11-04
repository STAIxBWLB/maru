// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleContext } from "../../lib/i18n";
import { ACON_SITE_LAUNCH, type SiteEntry } from "../../lib/sites";
import { unmountReactRoot } from "../../lib/testing/unmountReactRoot";
import { NewSiteDialog } from "./NewSiteDialog";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("site launch selection", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => { container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await unmountReactRoot(root); container.remove(); });
  const initial: SiteEntry = { id: "console", label: "Console", url: "http://127.0.0.1", category: null, favicon: null, localPath: null, devUrl: null, order: 0, createdAt: null, lastUsedAt: null, notes: null };
  async function render(site: SiteEntry, save: (entry: SiteEntry) => void) {
    await act(async () => root.render(<LocaleContext.Provider value={{ locale: "en", setLocale: () => {}, t: (key) => key }}><NewSiteDialog open initial={site} nextOrder={0} onClose={() => {}} onSave={save} /></LocaleContext.Provider>));
  }
  async function submit() { const button = [...document.querySelectorAll("button")].find((button) => button.textContent === "sites.dialog.save"); expect(button).toBeTruthy(); await act(async () => button!.click()); }
  it("saves explicit console intent without calling a launcher", async () => {
    const save = vi.fn();
    await render(initial, save);
    const select = document.querySelector("select")!;
    await act(async () => { select.value = ACON_SITE_LAUNCH; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await submit();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ launch: ACON_SITE_LAUNCH, url: "http://127.0.0.1" }));
  });
  it("allows an absent URL for explicit console launch but refuses a malformed nonempty URL", async () => {
    const save = vi.fn();
    await render({ ...initial, url: "file:///tmp/not-http", launch: ACON_SITE_LAUNCH }, save);
    await submit();
    expect(save).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("sites.dialog.urlInvalid");
    await render({ ...initial, url: "", launch: ACON_SITE_LAUNCH }, save);
    await submit();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ launch: ACON_SITE_LAUNCH, url: "http://127.0.0.1" }));
  });
  it("requires an explicit supported selection before saving malformed launch configuration", async () => {
    const save = vi.fn();
    await render({ ...initial, launch: "sh -c 'echo unsafe'" }, save);
    await submit();
    expect(save).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("sites.dialog.launchInvalid");
    const select = document.querySelector("select")!;
    await act(async () => { select.value = ""; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await submit();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ launch: null }));
  });
});

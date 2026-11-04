// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unmountReactRoot } from "../../../lib/testing/unmountReactRoot";
const mocks = vi.hoisted(() => ({ status: vi.fn(), launch: vi.fn(), close: vi.fn() }));
vi.mock("../../../lib/familyTools", async (importOriginal) => ({ ...await importOriginal<typeof import("../../../lib/familyTools")>(), familyToolsStatus: mocks.status }));
vi.mock("../../../lib/visualModeStore", () => ({ visualModeController: { enqueueFamilyConsole: mocks.launch } }));
vi.mock("../../../lib/appOverlayStore", () => ({ closeSettings: mocks.close }));
import { FamilyToolsTab } from "./FamilyToolsTab";
import { LocaleContext } from "../../../lib/i18n";
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const rows = ["ahub", "amem", "vmem", "acon"].map((id) => ({ id, package: `@staix/${id}`, installedVersion: "0.1.0", availableVersion: "0.1.1", state: "stale", ownership: id === "ahub" ? "ahub-upgrade" : "dot-family", previousVersion: null, commands: [], canLaunch: id === "acon", detail: [] }));
describe("family tools selection", () => {
  let root: Root; let container: HTMLDivElement;
  beforeEach(() => { vi.clearAllMocks(); mocks.status.mockResolvedValue(rows); container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); });
  afterEach(async () => { await unmountReactRoot(root); container.remove(); });
  async function render() { await act(async () => root.render(<LocaleContext.Provider value={{ locale: "en", setLocale: () => {}, t: (key) => key }}><FamilyToolsTab /></LocaleContext.Provider>)); }
  async function select(id: string) { const input = container.querySelector("select")!; await act(async () => { input.value = id; input.dispatchEvent(new Event("change", { bubbles: true })); }); }
  it("refreshes without launching and hands only an explicit console selection to Sites", async () => {
    await render(); expect(mocks.launch).not.toHaveBeenCalled();
    await select("amem"); expect(container.textContent).toContain("dot ai family install amem --version 0.1.1"); expect(mocks.launch).not.toHaveBeenCalled();
    await select("acon"); const button = [...container.querySelectorAll("button")].find((b) => b.textContent === "family.launch")!;
    await act(async () => button.click()); expect(mocks.launch).toHaveBeenCalledTimes(1); expect(mocks.close).toHaveBeenCalledTimes(1);
  });
  it("shows only the update handoff and leaves rollback to the installer", async () => {
    await render();
    mocks.status.mockResolvedValue(rows.map((row) => ({ ...row, installedVersion: "0.1.1" })));
    const refresh = [...container.querySelectorAll("button")].find((button) => button.textContent === "family.refresh")!;
    await act(async () => refresh.click());
    expect([...container.querySelectorAll("code")].map((code) => code.textContent)).toEqual(["ahub upgrade --to 0.1.1"]);
    expect(container.textContent).toContain("family.rollbackScope");
    expect(mocks.launch).not.toHaveBeenCalled();
  });
  it("does not offer package mutation handoffs for an externally owned install", async () => {
    mocks.status.mockResolvedValue(rows.map((row) => ({ ...row, ownership: "external", canLaunch: false })));
    await render(); expect(container.textContent).not.toContain("dot ai family install"); expect(container.textContent).not.toContain("ahub upgrade"); await select("acon");
    const launch = [...container.querySelectorAll("button")].find((button) => button.textContent === "family.launch");
    expect(launch?.disabled).toBe(true);
  });
});

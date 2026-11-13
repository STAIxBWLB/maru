// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { guardHwpxEditorNavigation, guardHwpxEditorNavigationAsync, hasHwpxEditorChanges, lockHwpxEditorNavigation, registerHwpxEditorGuard, requestHwpxEditorNavigation } from "./lib/hwpxEditorGuard";

// Execute the real App callbacks, as App.settingsLifecycle.test does for its
// effect, without mounting unrelated desktop modes or duplicating transitions.
const source = readFileSync(resolve("src/App.tsx"), "utf8");
const ast = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const callbacks = new Map<string, string>();
function visit(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer) && node.initializer.expression.getText(ast) === "useCallback") {
    const callback = node.initializer.arguments[0];
    if (callback) callbacks.set(node.name.text, callback.getText(ast));
  }
  ts.forEachChild(node, visit);
}
visit(ast);
function realCallback(name: string, ports: Record<string, unknown>): (...args: unknown[]) => unknown {
  const body = callbacks.get(name);
  if (!body) throw new Error(`Missing App callback ${name}`);
  const code = ts.transpileModule(`export const callback = ${body}`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const exported: { callback?: (...args: unknown[]) => unknown } = {};
  new Function("exports", "ports", `const {${Object.keys(ports).join(",")}} = ports; ${code}`)(exported, ports);
  return exported.callback!;
}
const removers: Array<() => void> = [];
afterEach(() => { removers.splice(0).forEach((remove) => remove()); });
const settle = () => new Promise<void>((done) => setTimeout(done, 0));
function fixture(allow: boolean) {
  const mutations: string[] = [];
  const mark = (name: string) => vi.fn(() => { mutations.push(name); });
  const beforeLeave = vi.fn(async () => allow);
  const setNavigationBusy = vi.fn();
  removers.push(registerHwpxEditorGuard({ hasChanges: () => true, beforeLeave, ownsFocus: () => false, save: async () => false, setNavigationBusy }));
  const tab = { id: "left", workspacePath: "/workspace", document: { fileKind: "md", path: "/workspace/old.md" } };
  const registry = { activeByVisibility: { private: "/other", public: "/public" }, workspaces: [{ path: "/other", visibility: "private" }] };
  const ports: Record<string, unknown> = {
    guardHwpxEditorNavigation, guardHwpxEditorNavigationAsync, hasHwpxEditorChanges, lockHwpxEditorNavigation, requestHwpxEditorNavigation,
    setFocusedWorkbenchSide: mark("focus"), patchEditorIds: mark("ids"), updateLayoutSettings: mark("layout"),
    leftResolvedTabId: "left", rightResolvedTabId: "right", editorSplitOpen: true,
    getEditorTabsState: () => ({ tabs: [tab], binaryTabs: [] }), resolveEditorTabIds: () => ({ leftResolvedTabId: "left", resolvedActiveTabId: "left" }),
    orderedTabsInState: () => [tab], isBinaryTab: () => false,
    setPersistedRightWorkbenchSurface: () => guardHwpxEditorNavigation(mark("right-surface")),
    setPersistedAppMode: () => guardHwpxEditorNavigation(mark("mode")),
    editorSurfacePersistence: { setEditorPaneViewModes: mark("views") },
    setInboxFocusTick: mark("inbox"), knowledgeModeController: { clearGapDraft: mark("gap") }, layoutSettings: { toolPanelSurface: "terminal" },
    openInboxAndFocus: mark("inbox"), openComms: mark("comms"), openMeetings: mark("meetings"), openSites: mark("sites"), openGraphWorkspace: mark("graph"),
    tabIdsToCloseOthers: () => ["other"], closeTabsByIds: () => guardHwpxEditorNavigation(mark("close-tabs")),
    terminalPanelRef: { current: null }, visibleAppMode: "pkm", rightWorkbenchMode: "files", focusedWorkbenchSide: "right", shouldCloseRightSites: () => false,
    focusedEditorGroup: "right", closeRightEditorPane: mark("close-right-editor"), closeTab: mark("close-tab"),
    addWorkspaceRoot: vi.fn(async () => { mutations.push("add-root"); return registry; }),
    registerWorkspaceRoots: vi.fn(async () => { mutations.push("register-root"); return { workspaceRegistry: registry, privateWorkspacePath: "/other" }; }),
    activateWorkspace: mark("activate-workspace"), loadWorkspace: vi.fn(async () => { mutations.push("load"); }),
    confirmDialog: vi.fn(async () => true), t: (key: string) => key,
    removeWorkspaceRoot: vi.fn(async () => { mutations.push("remove-root"); return registry; }),
    setWorkspaceRegistry: mark("registry"), removeWorkspaceState: mark("remove-state"), removeWorkspaceDocTabs: mark("remove-tabs"),
    cleanupDocumentBrowserWorkspace: mark("browser-cleanup"), cleanupEditorSurfaceWorkspace: mark("surface-cleanup"),
    settingsWorkPath: "/workspace", explorerWorkspacePath: "/workspace", lastOpenKeyForWorkspace: () => "fixture:last-open",
    normalizeFavoriteTargetRelPath: (value: string) => value, joinWorkspaceRelPath: (root: string, rel: string) => `${root}/${rel}`,
    explorerVisibility: "private", setExplorerVisibility: mark("visibility"), workspaceRegistry: registry, workspaceStates: {},
    discardedEdit: { workspacePath: "/workspace", entry: { path: "/workspace/old.md" } },
    selectRequestRef: { current: 0 }, readDocument: vi.fn(async () => { mutations.push("read-document"); return {}; }),
    activeDocumentWorkspacePath: "/workspace", blockWorkspaceWrite: () => false, createDocument: mark("create-document"),
    blockTabWrite: () => false, duplicateDocument: mark("duplicate-document"),
  };
  return { ports, mutations, beforeLeave, setNavigationBusy };
}
const syncTransitions: Array<[string, unknown[]]> = [
  ["closeRightWorkbench", []], ["splitEditorRight", []], ["openSourcePreviewSplit", []],
  ["openWorkbenchModeRight", ["files"]], ["openPrimaryWorkbenchMode", ["files"]],
  ["openPkmFromActivityRail", []], ["closeOtherTabs", ["left"]], ["closeActiveSurface", []],
];
describe("App HWPX whole-transition guard integration", () => {
  it.each(syncTransitions)("%s performs no layout/tab mutation after Cancel", async (name, args) => {
    const state = fixture(false); realCallback(name, state.ports)(...args); await settle();
    expect(state.beforeLeave).toHaveBeenCalledOnce(); expect(state.mutations).toEqual([]);
  });
  it.each(syncTransitions)("%s performs the whole transition after one approval", async (name, args) => {
    const state = fixture(true); realCallback(name, state.ports)(...args); await settle();
    expect(state.beforeLeave).toHaveBeenCalledOnce(); expect(state.mutations.length).toBeGreaterThan(0);
  });
  it.each([
    ["handleAddWorkspace", [{ path: "/other", visibility: "private" }]],
    ["handleRegisterWorkspace", ["/other"]], ["handleRemoveWorkspace", ["/workspace"]],
    ["restoreDiscardedEdit", []], ["createDocumentAndOpen", [{ title: "New", docType: "note", body: "", targetRelPath: null }]],
    ["duplicateTabDocument", ["left"]], ["handleExplorerWorkspaceVisibilityChange", ["public"]],
    ["refreshCurrent", []], ["openFavorite", [{ relPath: "report.hwpx", kind: "file" }]],
  ] as Array<[string, unknown[]]>)("%s cancels before workspace or document effects", async (name, args) => {
    const state = fixture(false); await realCallback(name, state.ports)(...args); await settle();
    expect(state.beforeLeave).toHaveBeenCalledOnce(); expect(state.mutations).toEqual([]);
  });
  it("Add Workspace freezes the outgoing editor until load finishes, and releases on failure", async () => {
    const state = fixture(true); let rejectLoad!: (cause: Error) => void; let started!: () => void;
    const loading = new Promise<void>((done) => { started = done; });
    state.ports.loadWorkspace = vi.fn(() => { started(); return new Promise<void>((_, reject) => { rejectLoad = reject; }); });
    const result = realCallback("handleAddWorkspace", state.ports)({ path: "/other", visibility: "private" }) as Promise<void>;
    await loading; expect(state.setNavigationBusy).toHaveBeenLastCalledWith(true);
    rejectLoad(new Error("load failed")); await expect(result).rejects.toThrow("load failed");
    expect(state.setNavigationBusy).toHaveBeenLastCalledWith(false); expect(state.beforeLeave).toHaveBeenCalledOnce();
  });
});

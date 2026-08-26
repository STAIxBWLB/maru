// @vitest-environment jsdom

import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class Channel<T> {
    onmessage: ((message: T) => void) | null = null;
  },
  invoke: vi.fn().mockResolvedValue(null),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn(), save: vi.fn() }));
vi.mock("../lib/today", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/today")>()),
  todayLogicalDay: vi.fn().mockResolvedValue({ logicalDay: "2026-08-26" }),
}));

import { MainApp } from "../App";
import {
  getEditorTabsState,
  replaceAllDocTabs,
  updateTabDraft,
  type EditorTab,
} from "../lib/editorTabsStore";
import { registerDictionaries } from "../lib/i18n";
import { en } from "../lib/i18n/locales/en";
import { ko } from "../lib/i18n/locales/ko";
import { getEditorPaneState } from "../lib/editorPaneStore";
import { setShellSurfaceRenderObserverForTest } from "../lib/shellSurfaceRenderProbe";


async function loadEditorSurface() {
  const specifier = ["../lib/editor", "PaneStore"].join("");
  return import(/* @vite-ignore */ specifier);
}

type EditorPaneScope = {
  workspacePath: string;
  group: "left" | "right";
  tabId: string;
};

describe("Editor surface render isolation", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let restoreRenderObserver: (() => void) | null = null;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    registerDictionaries({ en, ko });
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        getItem: () => "en",
        setItem: () => {},
      },
    });
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    restoreRenderObserver?.();
    restoreRenderObserver = null;
    await act(async () => {
      root?.unmount();
    });
    root = null;
    replaceAllDocTabs([], {
      activeTabId: null,
      leftActiveTabId: null,
      rightActiveTabId: null,
      focusedEditorGroup: "left",
    });
    container.remove();
  });

  it("keeps the real MainApp shell surfaces isolated for left and right draft publishes", async () => {
    const renders = new Map<string, number>();
    restoreRenderObserver = setShellSurfaceRenderObserverForTest((target) => {
      renders.set(target, (renders.get(target) ?? 0) + 1);
    });
    const left = {
      id: "left.md",
      workspacePath: "/workspace",
      entry: { path: "/workspace/left.md", relPath: "left.md", title: "left" },
      document: { path: "/workspace/left.md", relPath: "left.md", title: "left", content: "left", body: "left", meta: {}, fileKind: "markdown" },
      draftContent: "left",
    } as EditorTab;
    const right = {
      id: "right.md",
      workspacePath: "/workspace",
      entry: { path: "/workspace/right.md", relPath: "right.md", title: "right" },
      document: { path: "/workspace/right.md", relPath: "right.md", title: "right", content: "right", body: "right", meta: {}, fileKind: "markdown" },
      draftContent: "right",
    } as EditorTab;
    replaceAllDocTabs([left, right], {
      activeTabId: left.id,
      leftActiveTabId: left.id,
      rightActiveTabId: right.id,
      focusedEditorGroup: "left",
    });
    root = createRoot(container);
    await act(async () => {
      root?.render(<MainApp />);
    });
    await act(async () => {});
    const shellTargets = ["DocumentList", "TerminalPanel", "ActivityRail"] as const;
    const before = new Map(shellTargets.map((target) => [target, renders.get(target) ?? 0]));
    const mainBefore = renders.get("MainApp") ?? 0;
    expect(mainBefore).toBeGreaterThan(0);
    for (const target of shellTargets) {
      expect(before.get(target)).toBeGreaterThan(0);
    }
    const expectShellStable = () => {
      for (const target of shellTargets) expect(renders.get(target) ?? 0).toBe(before.get(target));
    };

    await act(async () => {
      updateTabDraft(left.id, "left dirty");
    });
    expect(getEditorTabsState().tabs.find((tab) => tab.id === left.id)?.draftContent).toBe("left dirty");
    expect(getEditorTabsState().tabs.find((tab) => tab.id === right.id)?.draftContent).toBe("right");
    expect(getEditorPaneState({ workspacePath: "/workspace", group: "left", tabId: left.id }).document.draftContent).toBe("left dirty");
    expect(getEditorPaneState({ workspacePath: "/workspace", group: "right", tabId: right.id }).document.draftContent).toBe("right");
    expect(renders.get("MainApp") ?? 0).toBeGreaterThan(mainBefore);
    expectShellStable();

    await act(async () => {
      updateTabDraft(left.id, "left dirty again");
    });
    expect(getEditorTabsState().tabs.find((tab) => tab.id === left.id)?.draftContent).toBe("left dirty again");
    expect(getEditorPaneState({ workspacePath: "/workspace", group: "left", tabId: left.id }).document.draftContent).toBe("left dirty again");
    expectShellStable();

    await act(async () => {
      updateTabDraft(right.id, "right dirty");
    });
    expect(getEditorTabsState().tabs.find((tab) => tab.id === right.id)?.draftContent).toBe("right dirty");
    expect(getEditorPaneState({ workspacePath: "/workspace", group: "right", tabId: right.id }).document.draftContent).toBe("right dirty");
    expect(getEditorPaneState({ workspacePath: "/workspace", group: "left", tabId: left.id }).document.draftContent).toBe("left dirty again");
    expectShellStable();
  });

  it("publishes only the changed render-domain subscriber", async () => {
    const surface = await loadEditorSurface();
    const scope: EditorPaneScope = { workspacePath: "/workspace", group: "left", tabId: "note.md" };
    let documentRenders = 0;
    let tabsRenders = 0;
    let viewRenders = 0;
    let operationRenders = 0;

    function DocumentSubscriber() {
      useSyncExternalStore(surface.subscribeEditorDocument(scope), () => surface.getEditorDocumentSlice(scope));
      documentRenders += 1;
      return null;
    }

    function TabsSubscriber() {
      useSyncExternalStore(surface.subscribeEditorTabs(scope), () => surface.getEditorTabsSlice(scope));
      tabsRenders += 1;
      return null;
    }

    function ViewSubscriber() {
      useSyncExternalStore(surface.subscribeEditorViewPreview(scope), () => surface.getEditorViewPreviewSlice(scope));
      viewRenders += 1;
      return null;
    }

    function OperationSubscriber() {
      useSyncExternalStore(surface.subscribeEditorOperation(scope), () => surface.getEditorOperationSlice(scope));
      operationRenders += 1;
      return null;
    }

    function Subscribers() {
      return <><DocumentSubscriber /><TabsSubscriber /><ViewSubscriber /><OperationSubscriber /></>;
    }

    root = createRoot(container);
    await act(async () => {
      root?.render(<Subscribers />);
    });
    const before = { documentRenders, tabsRenders, viewRenders, operationRenders };

    await act(async () => {
      surface.patchEditorPaneOperation(scope, { saving: true });
    });

    expect(documentRenders).toBe(before.documentRenders);
    expect(tabsRenders).toBe(before.tabsRenders);
    expect(viewRenders).toBe(before.viewRenders);
    expect(operationRenders).toBe(before.operationRenders + 1);
  });

  it("keeps TerminalPanel at the locked four-input shell boundary", async () => {
    const source = await readFile("src/components/TerminalPanel.tsx", "utf8");
    const props = source.match(/interface TerminalPanelProps \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(props.match(/^\s*\w+\??:/gm)?.map((line) => line.trim().split(/[?:]/)[0])).toEqual([
      "scope",
      "commands",
      "graphNode",
    ]);
    expect(source).toContain("forwardRef<TerminalPanelHandle, TerminalPanelProps>");
  });
});

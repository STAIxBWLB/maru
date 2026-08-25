// @vitest-environment jsdom

import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";


async function loadEditorSurface() {
  const specifier = ["../lib/editor", "PaneStore"].join("");
  return import(/* @vite-ignore */ specifier);
}

type EditorPaneScope = {
  workspacePath: string;
  group: "left" | "right";
  tabId: string;
};

function dispatchEditorInput(input: HTMLInputElement, value: string) {
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  valueSetter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("Editor surface render isolation", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  it("typing in either editor leaves the opposite editor and unrelated shell probes unchanged", async () => {
    const surface = await loadEditorSurface();
    const renders = new Map<string, number>();
    const count = (name: string) => renders.set(name, (renders.get(name) ?? 0) + 1);
    const left: EditorPaneScope = { workspacePath: "/workspace", group: "left", tabId: "left.md" };
    const right: EditorPaneScope = { workspacePath: "/workspace", group: "right", tabId: "right.md" };

    function EditorProbe({ scope, label }: { scope: EditorPaneScope; label: string }) {
      const documentSlice = useSyncExternalStore(
        surface.subscribeEditorDocument(scope),
        () => surface.getEditorDocumentSlice(scope),
        () => surface.getEditorDocumentSlice(scope),
      );
      count(label);
      return (
        <input
          aria-label={label}
          value={documentSlice.draftContent}
          onChange={(event) => surface.updateEditorPaneDraft(scope, event.target.value)}
        />
      );
    }

    function ShellProbe({ name }: { name: "DocumentList" | "TerminalPanel" | "activity-rail" }) {
      count(name);
      return <div data-probe={name} />;
    }

    root = createRoot(container);
    await act(async () => {
      root?.render(
        <>
          <EditorProbe scope={left} label="left-editor" />
          <EditorProbe scope={right} label="right-editor" />
          <ShellProbe name="DocumentList" />
          <ShellProbe name="TerminalPanel" />
          <ShellProbe name="activity-rail" />
        </>,
      );
    });

    const leftBefore = renders.get("left-editor");
    const rightBefore = renders.get("right-editor");
    const shellBefore = ["DocumentList", "TerminalPanel", "activity-rail"].map((name) => renders.get(name));
    await act(async () => {
      dispatchEditorInput(container.querySelector<HTMLInputElement>("[aria-label='left-editor']")!, "left edit");
    });
    expect(renders.get("left-editor")).toBe((leftBefore ?? 0) + 1);
    expect(renders.get("right-editor")).toBe(rightBefore);
    expect(["DocumentList", "TerminalPanel", "activity-rail"].map((name) => renders.get(name))).toEqual(shellBefore);

    const rightAfterLeft = renders.get("right-editor");
    await act(async () => {
      dispatchEditorInput(container.querySelector<HTMLInputElement>("[aria-label='right-editor']")!, "right edit");
    });
    expect(renders.get("right-editor")).toBe((rightAfterLeft ?? 0) + 1);
    expect(renders.get("left-editor")).toBe((leftBefore ?? 0) + 1);
    expect(["DocumentList", "TerminalPanel", "activity-rail"].map((name) => renders.get(name))).toEqual(shellBefore);
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
});

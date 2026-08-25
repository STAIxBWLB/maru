// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { useMemo } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decoratePreviewHtml } from "./EditorPane";

const wave0ContractsEnabled = process.env.PHASE4_WAVE0_CONTRACT === "1";
const describeWave0 = wave0ContractsEnabled ? describe : describe.skip;
const editorPaneSource = new URL("./EditorPane.tsx", import.meta.url);

async function loadEditorSurface() {
  const specifier = ["../lib/editor", "PaneStore"].join("");
  return import(/* @vite-ignore */ specifier);
}

function PreviewHarness({ operationVersion }: { operationVersion: number }) {
  const previewHtml = useMemo(() => {
    void operationVersion;
    return decoratePreviewHtml(
        '<p><mark class="kg-ref-mark">reference</mark> <mark class="find-mark find-mark-current">match</mark></p>',
        {
          kgSpans: null,
          kgSource: "",
          kgTitleFor: () => "",
          findQuery: "",
          findCurrent: operationVersion,
          resolveWikilink: () => true,
        },
    );
  }, [operationVersion]);
  const previewMarkup = useMemo(() => ({ __html: previewHtml }), [previewHtml]);
  return <article className="preview-surface" dangerouslySetInnerHTML={previewMarkup} />;
}

describeWave0("EditorPane preview identity contract", () => {
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

  it("retains preview marks and the same marked DOM node through an unrelated operation update", async () => {
    const surface = await loadEditorSurface();
    const scope = { workspacePath: "/workspace", group: "left", tabId: "note.md" };
    root = createRoot(container);
    await act(async () => {
      root?.render(<PreviewHarness operationVersion={0} />);
    });
    const retainedMark = container.querySelector("mark.kg-ref-mark");
    expect(retainedMark).toBeInstanceOf(HTMLElement);
    expect(container.querySelector("mark.find-mark.find-mark-current")).toBeInstanceOf(HTMLElement);

    await act(async () => {
      surface.patchEditorPaneOperation(scope, { saving: true });
      root?.render(<PreviewHarness operationVersion={1} />);
    });

    expect(container.querySelector("mark.kg-ref-mark")).toBe(retainedMark);
    expect(container.querySelector("mark.find-mark.find-mark-current")).toBeInstanceOf(HTMLElement);
  });

  it("keeps preview markup React-owned and memoized only on previewHtml", async () => {
    await loadEditorSurface();
    const source = readFileSync(editorPaneSource, "utf8");

    expect(source).toContain("const previewMarkup = useMemo(() => ({ __html: previewHtml }), [previewHtml]);");
    expect(source).toContain("dangerouslySetInnerHTML={previewMarkup}");
    expect(source).toContain("export function decoratePreviewHtml");
    expect(source).not.toMatch(/previewRef\.current\?\.(?:innerHTML|append|replaceChildren)/);
  });
});

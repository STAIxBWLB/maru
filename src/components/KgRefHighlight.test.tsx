// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ kgDocumentRefs: vi.fn() }));
vi.mock("../lib/api", () => ({ kgDocumentRefs: mocks.kgDocumentRefs }));

import { useKgRefWalkTarget, type KgRefWalkTarget } from "./KgRefHighlight";
import { visualModeController } from "../lib/visualModeStore";
import type { KgNodeRef } from "../lib/types";

const encoder = new TextEncoder();
const byteLen = (text: string) => encoder.encode(text).length;

const CONTENT =
  "# Title\n\nFirst paragraph cites KPI in passing.\n\nSecond paragraph.\n";
const FIRST_BLOCK = "# Title";
const SECOND_BLOCK = "First paragraph cites KPI in passing.";

function byteSpan(text: string, paragraph: number) {
  const charStart = CONTENT.indexOf(text);
  if (charStart < 0) throw new Error(`fixture drift: "${text}" missing`);
  const start = byteLen(CONTENT.slice(0, charStart));
  return { start, end: start + byteLen(text), paragraph };
}

const REFS: KgNodeRef[] = [
  {
    nodePath: "references/glossary.md",
    nodeTitle: "Glossary",
    matchKind: "entity",
    spans: [byteSpan("KPI", 1)],
  },
];

let container: HTMLDivElement;
let root: Root | null = null;
let latest: KgRefWalkTarget | null = null;

function Probe({
  docPath,
  workspacePath,
}: {
  docPath: string | null;
  workspacePath: string | null;
}) {
  latest = useKgRefWalkTarget(docPath, CONTENT, workspacePath);
  return null;
}

async function renderProbe(docPath: string | null, workspacePath: string | null) {
  await act(async () => {
    root?.render(<Probe docPath={docPath} workspacePath={workspacePath} />);
  });
}

function publishWalk(paragraph: number, docRoot = "/ws-a") {
  visualModeController.setGraphReferenceFocus({
    source: "editor",
    docPath: "doc.md",
    docRoot,
    nodePaths: ["references/glossary.md"],
    steps: [{ paragraph, nodePaths: ["references/glossary.md"] }],
    nonce: 1,
  });
  visualModeController.setGraphReferenceWalk({ paragraph, step: 0, total: 2, paused: false });
}

beforeEach(() => {
  mocks.kgDocumentRefs.mockReset();
  mocks.kgDocumentRefs.mockResolvedValue({
    docPath: "doc.md",
    docHash: "h",
    vaultStamp: "v",
    refs: REFS,
    computedAt: "2026-09-24T00:00:00Z",
  });
  visualModeController.setGraphReferenceWalk(null);
  visualModeController.setGraphReferenceFocus(null);
  latest = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container.remove();
  visualModeController.setGraphReferenceWalk(null);
  visualModeController.setGraphReferenceFocus(null);
});

describe("useKgRefWalkTarget", () => {
  it("activates only when the pane's workspace matches the focus docRoot", async () => {
    publishWalk(1, "/ws-a");

    // Same relative path, different workspace: the split-editor mismatch.
    await renderProbe("doc.md", "/ws-b");
    expect(latest).toBeNull();
    expect(mocks.kgDocumentRefs).not.toHaveBeenCalled();

    // The owning workspace participates and fetches from its own root.
    await renderProbe("doc.md", "/ws-a");
    expect(mocks.kgDocumentRefs).toHaveBeenCalledWith("/ws-a", "doc.md");
    expect(latest).not.toBeNull();
  });

  it("covers the citing paragraph's full block, not just the cited span", async () => {
    publishWalk(1);
    await renderProbe("doc.md", "/ws-a");

    expect(latest).not.toBeNull();
    expect(latest!.paragraph).toBe(1);
    expect(CONTENT.slice(latest!.start, latest!.end)).toBe(SECOND_BLOCK);
    // The range is the whole block even though the citation is one word.
    expect(latest!.end - latest!.start).toBeGreaterThan("KPI".length);
    expect(latest!.spans).toHaveLength(1);
    expect(CONTENT.slice(latest!.spans[0]!.start, latest!.spans[0]!.end)).toBe("KPI");
  });

  it("tracks the walk to another paragraph block", async () => {
    mocks.kgDocumentRefs.mockResolvedValue({
      docPath: "doc.md",
      docHash: "h",
      vaultStamp: "v",
      refs: [
        ...REFS,
        {
          nodePath: "maru-project.md",
          nodeTitle: "Maru Project",
          matchKind: "entity",
          spans: [byteSpan("Title", 0)],
        },
      ],
      computedAt: "2026-09-24T00:00:00Z",
    });
    publishWalk(1);
    await renderProbe("doc.md", "/ws-a");
    expect(CONTENT.slice(latest!.start, latest!.end)).toBe(SECOND_BLOCK);

    await act(async () => {
      visualModeController.setGraphReferenceWalk({
        paragraph: 0,
        step: 1,
        total: 2,
        paused: true,
      });
    });
    expect(CONTENT.slice(latest!.start, latest!.end)).toBe(FIRST_BLOCK);
  });

  it("highlights nothing for the single-leg fallback (paragraph -1)", async () => {
    publishWalk(-1);
    await renderProbe("doc.md", "/ws-a");
    expect(latest).toBeNull();
    expect(mocks.kgDocumentRefs).not.toHaveBeenCalled();
  });

  it("highlights nothing when the paragraph index has no block", async () => {
    publishWalk(9);
    await renderProbe("doc.md", "/ws-a");
    expect(latest).toBeNull();
  });

  it("stays inactive without a walk, a document, or a workspace path", async () => {
    publishWalk(1);
    await renderProbe(null, "/ws-a");
    expect(latest).toBeNull();
    await renderProbe("doc.md", null);
    expect(latest).toBeNull();
    expect(mocks.kgDocumentRefs).not.toHaveBeenCalled();
  });
});

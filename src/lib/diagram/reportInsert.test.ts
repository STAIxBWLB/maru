import { describe, expect, it, vi } from "vitest";

import {
  REPORT_RENDER_OPTIONS,
  insertDiagramIntoReport,
  scopeDocForRender,
  type ReportInsertDeps,
  type ReportInsertRequest,
} from "./reportInsert";
import { buildManagedBlock } from "./reportLink";
import { createEmptyDoc, type DiagramDoc, type DiagramEdge, type DiagramNode } from "./types";

function makeDoc(id: string = "doc-1") {
  return { ...createEmptyDoc(id, 0), docTitle: "Weekly chart" };
}

/** Deterministic stand-in for sha256 (stable across runs). */
function fakeDigestHex(text: string): Promise<string> {
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const hex = ((h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0"));
  return Promise.resolve(hex.repeat(4).slice(0, 64));
}

interface Harness {
  deps: ReportInsertDeps;
  writes: Array<{ docId: string; fileName: string; bytes: Uint8Array }>;
  saves: Array<{ path: string; content: string; revision: string | null }>;
  setTargetContent: (content: string, revision?: string | null) => void;
}

function makeHarness(initial: { content: string; revision?: string | null } = { content: "# Report\n", revision: "rev-1" }): Harness {
  const harness: Harness = {
    writes: [],
    saves: [],
    setTargetContent: (content, revision = "rev-1") => {
      target = { content, revision };
    },
    deps: {
      writeAsset: (docId, fileName, bytes) => {
        harness.writes.push({ docId, fileName, bytes });
        return Promise.resolve(`attachments/diagrams/${docId}/${fileName}`);
      },
      readTarget: () => Promise.resolve({ content: target.content, revision: target.revision }),
      saveTarget: (path, content, expectedRevision) => {
        harness.saves.push({ path, content, revision: expectedRevision });
        return Promise.resolve({});
      },
      renderAssets: () =>
        Promise.resolve({
          svg: new TextEncoder().encode("<svg/>"),
          png: new Uint8Array([0x89, 0x50]),
        }),
      digestHex: fakeDigestHex,
    },
  };
  let target = { content: initial.content, revision: initial.revision ?? null };
  return harness;
}

function makeRequest(overrides: Partial<ReportInsertRequest> = {}): ReportInsertRequest {
  return {
    diagramName: "example",
    dirty: false,
    doc: makeDoc(),
    scope: "doc",
    target: { path: "reports/weekly.md" },
    ...overrides,
  };
}

describe("insertDiagramIntoReport", () => {
  it("requires a saved diagram (never saved)", async () => {
    const harness = makeHarness();
    const outcome = await insertDiagramIntoReport(
      makeRequest({ diagramName: null }),
      harness.deps,
    );
    expect(outcome.status).toBe("needs-save");
    expect(harness.writes).toHaveLength(0);
  });

  it("requires a saved diagram (dirty)", async () => {
    const harness = makeHarness();
    const outcome = await insertDiagramIntoReport(makeRequest({ dirty: true }), harness.deps);
    expect(outcome.status).toBe("needs-save");
    expect(harness.writes).toHaveLength(0);
  });

  it("asks for a target before writing assets when none is active", async () => {
    const harness = makeHarness();
    const outcome = await insertDiagramIntoReport(makeRequest({ target: null }), harness.deps);
    expect(outcome.status).toBe("needs-target");
    expect(harness.writes).toHaveLength(0);
    expect(harness.saves).toHaveLength(0);
  });

  it("inserts a managed block into the target document", async () => {
    const harness = makeHarness({ content: "# Report\n\nbody\n", revision: "rev-7" });
    const outcome = await insertDiagramIntoReport(makeRequest(), harness.deps);
    expect(outcome).toEqual({ status: "inserted", targetPath: "reports/weekly.md" });
    expect(harness.saves).toHaveLength(1);
    expect(harness.saves[0].revision).toBe("rev-7");
    expect(harness.saves[0].content.startsWith("# Report\n\nbody\n")).toBe(true);
    expect(harness.saves[0].content).toContain("<!-- maru-diagram:v1 ");
    expect(harness.saves[0].content).toContain('"source":"diagrams/example.cmd.json"');
    expect(harness.saves[0].content).toContain('"scope":"doc"');
    expect(harness.saves[0].content).toContain("![Weekly chart](");
  });

  it("writes hash-named svg + png assets under attachments/diagrams/<docId>", async () => {
    const harness = makeHarness();
    await insertDiagramIntoReport(makeRequest({ scope: "pattern:view-9" }), harness.deps);
    expect(harness.writes).toHaveLength(2);
    expect(harness.writes[0].docId).toBe("doc-1");
    // ':' in the scope is sanitized out of the file name (NTFS treats it as
    // an alternate-data-stream separator); block attrs keep the raw scope.
    expect(harness.writes[0].fileName).toMatch(/^pattern-view-9-[0-9a-f]{8}\.svg$/);
    expect(harness.writes[1].fileName).toMatch(/^pattern-view-9-[0-9a-f]{8}\.png$/);
    const stem = (name: string) => name.replace(/\.(svg|png)$/, "");
    expect(stem(harness.writes[0].fileName)).toBe(stem(harness.writes[1].fileName));
  });

  it("is stable: the same doc renders to the same hash and asset paths", async () => {
    const first = makeHarness();
    const second = makeHarness();
    await insertDiagramIntoReport(makeRequest(), first.deps);
    await insertDiagramIntoReport(makeRequest(), second.deps);
    expect(first.writes.map((w) => w.fileName)).toEqual(second.writes.map((w) => w.fileName));
    expect(first.saves[0].content).toBe(second.saves[0].content);
  });

  it("hash changes when the render options change the canonical input", async () => {
    // Guard the canonical-input contract: serializeDoc + render options.
    const harness = makeHarness();
    const spy = vi.fn(harness.deps.digestHex);
    await insertDiagramIntoReport(makeRequest(), { ...harness.deps, digestHex: spy });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toContain(JSON.stringify(REPORT_RENDER_OPTIONS));
    expect(spy.mock.calls[0][0]).toContain('"v":');
  });

  it("updates an existing block in place (same source + scope)", async () => {
    const doc = makeDoc();
    const setup = makeHarness();
    await insertDiagramIntoReport(makeRequest({ doc }), setup.deps);
    const inserted = setup.saves[0].content;

    const harness = makeHarness({ content: inserted, revision: "rev-2" });
    const outcome = await insertDiagramIntoReport(makeRequest({ doc }), harness.deps);
    expect(outcome).toEqual({ status: "updated", targetPath: "reports/weekly.md" });
    // Idempotent re-render: identical content spliced again.
    expect(harness.saves[0].content).toBe(inserted);
  });

  it("keeps blocks of different scopes side by side", async () => {
    const doc = makeDoc();
    const first = makeHarness();
    await insertDiagramIntoReport(makeRequest({ doc, scope: "doc" }), first.deps);
    const second = makeHarness({ content: first.saves[0].content, revision: "rev-2" });
    const outcome = await insertDiagramIntoReport(
      makeRequest({ doc, scope: "pattern:view-1" }),
      second.deps,
    );
    expect(outcome.status).toBe("inserted");
    expect(second.saves[0].content.match(/maru-diagram:v1/g)).toHaveLength(2);
  });

  it("surfaces a revision conflict without retrying", async () => {
    const harness = makeHarness();
    harness.deps.saveTarget = () =>
      Promise.reject(new Error("document_conflict: expected rev-1, found rev-2"));
    const outcome = await insertDiagramIntoReport(makeRequest(), harness.deps);
    expect(outcome.status).toBe("conflict");
    expect((outcome as { message: string }).message).toContain("document_conflict");
    // Assets were written (hash-named orphans are harmless) but no retry save.
    expect(harness.writes).toHaveLength(2);
  });

  it("surfaces asset write denial and never touches the document", async () => {
    const harness = makeHarness();
    harness.deps.writeAsset = () => Promise.reject(new Error("write_not_allowed: workspace is read-only"));
    const outcome = await insertDiagramIntoReport(makeRequest(), harness.deps);
    expect(outcome).toEqual({ status: "error", message: "write_not_allowed: workspace is read-only" });
    expect(harness.saves).toHaveLength(0);
  });

  it("surfaces target read failures", async () => {
    const harness = makeHarness();
    harness.deps.readTarget = () => Promise.reject(new Error("read failed"));
    const outcome = await insertDiagramIntoReport(makeRequest(), harness.deps);
    expect(outcome).toEqual({ status: "error", message: "read failed" });
  });

  it("falls back to the diagram name as caption when the title is empty", async () => {
    const harness = makeHarness();
    const doc = { ...makeDoc(), docTitle: "  " };
    await insertDiagramIntoReport(makeRequest({ doc }), harness.deps);
    expect(harness.saves[0].content).toContain("![example](");
  });

  it("managed block attrs point at the written asset paths", async () => {
    const harness = makeHarness();
    await insertDiagramIntoReport(makeRequest({ scope: "doc" }), harness.deps);
    const svgName = harness.writes[0].fileName;
    const pngName = harness.writes[1].fileName;
    expect(harness.saves[0].content).toContain(`"asset":"attachments/diagrams/doc-1/${svgName}"`);
    expect(harness.saves[0].content).toContain(`"fallback":"attachments/diagrams/doc-1/${pngName}"`);
    expect(harness.saves[0].content).toContain("![Weekly chart](attachments/diagrams/doc-1/");
    // The block the flow builds matches the reportLink contract exactly.
    expect(harness.saves[0].content).toContain(
      buildManagedBlock({
        source: "diagrams/example.cmd.json",
        scope: "doc",
        assetPath: `attachments/diagrams/doc-1/${svgName}`,
        fallbackPath: `attachments/diagrams/doc-1/${pngName}`,
        renderHash: harness.saves[0].content.match(/"renderHash":"(sha256:[0-9a-f]+)"/)?.[1] ?? "",
        caption: "Weekly chart",
      }),
    );
  });
});

describe("scopeDocForRender", () => {
  const node = (id: string): DiagramNode => ({ id, kind: "simple", x: 0, y: 0, w: 100, h: 50 });
  const edge = (id: string, fromNode: string, toNode: string): DiagramEdge => ({
    id,
    fromNode,
    fromPort: "e",
    toNode,
    toPort: "w",
    routeMode: "auto",
    arrowStart: "none",
    arrowEnd: "filled",
    arrowSize: 1,
    dash: "solid",
    width: 1.5,
    midOff: 0,
  });
  const viewDoc = (): DiagramDoc => ({
    ...makeDoc(),
    nodes: [node("a"), node("b"), node("c")],
    edges: [edge("e1", "a", "b"), edge("e2", "b", "c")],
    views: [
      {
        id: "view-1",
        datasetId: "ds-1",
        patternId: "report.table",
        bounds: { x: 0, y: 0, w: 100, h: 50 },
        nodeIds: ["a", "b"],
        edgeIds: ["e1"],
        projectionHash: "h",
      },
    ],
  });

  it("keeps the full doc for the doc scope", () => {
    const doc = viewDoc();
    expect(scopeDocForRender(doc, "doc")).toBe(doc);
  });

  it("filters nodes/edges to the scoped view's members", () => {
    const scoped = scopeDocForRender(viewDoc(), "pattern:view-1");
    expect(scoped.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(scoped.edges.map((e) => e.id)).toEqual(["e1"]);
  });

  it("falls back to the full doc when the view is gone", () => {
    const doc = viewDoc();
    expect(scopeDocForRender(doc, "pattern:missing")).toBe(doc);
  });

  it("renders the scoped sub-doc, not the whole canvas", async () => {
    const harness = makeHarness();
    const seen: DiagramDoc[] = [];
    const inner = harness.deps.renderAssets;
    harness.deps.renderAssets = (doc) => {
      seen.push(doc);
      return inner(doc);
    };
    await insertDiagramIntoReport(
      makeRequest({ doc: viewDoc(), scope: "pattern:view-1" }),
      harness.deps,
    );
    expect(seen).toHaveLength(1);
    expect(seen[0].nodes.map((n) => n.id)).toEqual(["a", "b"]);
  });
});

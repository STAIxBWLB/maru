import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

import {
  REPORT_RENDER_OPTIONS,
  insertDiagramIntoReport,
  scopeDocForRender,
  type ReportInsertDeps,
  type ReportInsertRequest,
} from "./reportInsert";
import { IpcError } from "../ipcError";
import { buildManagedBlock } from "./reportLink";
import { createEmptyDoc, type DiagramDoc, type DiagramEdge, type DiagramNode } from "./types";
import type { ArchifyRenderReceipt } from "../archify";

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

function realDigestHex(text: string): Promise<string> {
  return Promise.resolve(createHash("sha256").update(text).digest("hex"));
}

function byteHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function verifiedAssets() {
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>검증된 다이어그램</text></svg>');
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const inputSpecSha256 = byteHash(new TextEncoder().encode('{"diagram_type":"architecture","fixture":true}'));
  const enginePin = {
    name: "archify",
    version: "3.0.0",
    revision: "9286c3b9c2cef359e98586b420d769d87bcb163f",
  };
  const receipt = (bytes: Uint8Array, outputMimeType: string): ArchifyRenderReceipt => ({
    schemaVersion: 1,
    inputSpecSha256,
    enginePin,
    outputSha256: byteHash(bytes),
    outputMimeType,
    engineOutputSha256: byteHash(new TextEncoder().encode("pinned engine html bytes")),
    gates: {
      schema: { status: "passed", scope: "pinned-engine-validation" },
      artifact: { status: "passed", scope: "pinned-engine-rendered-html" },
      browser: { status: "passed", scope: "verified-static-conversion" },
      visualReview: { status: "not-run", scope: "manual-visual-review" },
    },
  });
  return { svg, png, receipts: { svg: receipt(svg, "image/svg+xml"), png: receipt(png, "image/png") } };
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

  it("sanitizes a hostile doc id out of the asset path (markdown injection)", async () => {
    // Imported docs carry arbitrary ids; newlines/parens in the path would
    // break out of the ![caption](path) image line in the target report.
    const harness = makeHarness();
    const doc = makeDoc("x)\n# injected\n(");
    await insertDiagramIntoReport(makeRequest({ doc }), harness.deps);
    expect(harness.writes[0].docId).toBe("x-injected-");
    expect(harness.saves[0].content).not.toContain("# injected");
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
      Promise.reject(
        new IpcError({ code: "document_conflict", message: "expected rev-1, found rev-2" }),
      );
    const outcome = await insertDiagramIntoReport(makeRequest(), harness.deps);
    expect(outcome.status).toBe("conflict");
    expect((outcome as { message: string }).message).toContain("document_conflict");
    // Assets were written (hash-named orphans are harmless) but no retry save.
    expect(harness.writes).toHaveLength(2);
  });

  it("stops after an async render becomes stale, before writing either asset or target", async () => {
    const harness = makeHarness();
    const assets = verifiedAssets();
    let current = true;
    harness.deps.digestHex = realDigestHex;
    harness.deps.renderAssets = async () => {
      await Promise.resolve();
      current = false;
      return assets;
    };
    const outcome = await insertDiagramIntoReport(
      makeRequest({ isCurrent: () => current }),
      harness.deps,
    );
    expect(outcome.status).toBe("error");
    expect((outcome as { message: string }).message).toMatch(/source diagram changed/i);
    expect(harness.writes).toHaveLength(0);
    expect(harness.saves).toHaveLength(0);
  });

  it("rejects verified receipts whose output hash does not match bytes", async () => {
    const harness = makeHarness();
    const assets = verifiedAssets();
    harness.deps.digestHex = realDigestHex;
    harness.deps.renderAssets = async () => ({
      ...assets,
      receipts: {
        ...assets.receipts,
        svg: { ...assets.receipts.svg, outputSha256: "0".repeat(64) },
      },
    });
    const outcome = await insertDiagramIntoReport(makeRequest(), harness.deps);
    expect(outcome.status).toBe("error");
    expect((outcome as { message: string }).message).toMatch(/receipts do not match/i);
    expect(harness.writes).toHaveLength(0);
    expect(harness.saves).toHaveLength(0);
  });

  it("uses full verified byte hashes in stable managed blocks and preserves exact asset bytes", async () => {
    const assets = verifiedAssets();
    const first = makeHarness({ content: "# Report\n\nbody\n", revision: "rev-1" });
    first.deps.digestHex = realDigestHex;
    first.deps.renderAssets = async () => assets;
    const firstOutcome = await insertDiagramIntoReport(makeRequest(), first.deps);
    expect(firstOutcome).toEqual({ status: "inserted", targetPath: "reports/weekly.md" });
    expect(first.saves[0]!.content.startsWith("# Report\n\nbody\n")).toBe(true);
    expect(first.writes.map((write) => [...write.bytes])).toEqual([[...assets.svg], [...assets.png]]);
    expect(first.writes[0]!.fileName).toMatch(/^doc-[0-9a-f]{64}\.svg$/);
    expect(first.writes[1]!.fileName).toMatch(/^doc-[0-9a-f]{64}\.png$/);
    const expectedRenderHash = await realDigestHex(JSON.stringify({
      svg: assets.receipts.svg.outputSha256,
      png: assets.receipts.png.outputSha256,
      input: assets.receipts.svg.inputSpecSha256,
      engine: assets.receipts.svg.enginePin,
    }));
    expect(first.saves[0]!.content).toContain(`"renderHash":"sha256:${expectedRenderHash}"`);

    const second = makeHarness({ content: first.saves[0]!.content, revision: "rev-2" });
    second.deps.digestHex = realDigestHex;
    second.deps.renderAssets = async () => assets;
    const secondOutcome = await insertDiagramIntoReport(makeRequest(), second.deps);
    expect(secondOutcome).toEqual({ status: "updated", targetPath: "reports/weekly.md" });
    expect(second.writes.map((write) => write.fileName)).toEqual(first.writes.map((write) => write.fileName));
    expect(second.saves[0]!.content).toBe(first.saves[0]!.content);
    expect(second.saves[0]!.revision).toBe("rev-2");
  });

  it("keeps verified report insertion revision conflicts visible without retry", async () => {
    const harness = makeHarness({ content: "# Report\n", revision: "rev-expected" });
    const assets = verifiedAssets();
    harness.deps.digestHex = realDigestHex;
    harness.deps.renderAssets = async () => assets;
    harness.deps.saveTarget = (_path, _content, expectedRevision) => {
      expect(expectedRevision).toBe("rev-expected");
      return Promise.reject(new IpcError({ code: "document_conflict", message: "expected rev-expected, found rev-new" }));
    };
    const outcome = await insertDiagramIntoReport(makeRequest(), harness.deps);
    expect(outcome.status).toBe("conflict");
    expect((outcome as { message: string }).message).toContain("document_conflict");
    expect(harness.writes.map((write) => [...write.bytes])).toEqual([[...assets.svg], [...assets.png]]);
    expect(harness.saves).toHaveLength(0);
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

it("keeps report insertion successful while surfacing a render-history store failure", async () => {
  const harness = makeHarness();
  harness.deps.renderAssets = async () => ({ ...verifiedAssets(), storeWarnings: ["Render history folder is not writable; repair permissions and retry"] });
  const result = await insertDiagramIntoReport(makeRequest(), harness.deps);
  expect(result).toEqual({ status: "inserted", targetPath: "reports/weekly.md", storeWarnings: ["Render history folder is not writable; repair permissions and retry"] });
  expect(harness.writes).toHaveLength(2);
  expect(harness.saves).toHaveLength(1);
});

// @vitest-environment jsdom
import { createHash, webcrypto } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { EngineRenderedCandidate } from "./engine";
import type { EngineReceipt } from "../../../src-tauri/crates/maru-diagram-engine/bindings/engine";
import { archifySpecToDataset } from "./archifyCodec";
import { makeEngineArtifactFixture } from "./__fixtures__/engineArtifact";
import { SEMANTIC_FIXTURES } from "./__fixtures__/semantic";
import { NATIVE_EXPORT_SPEC } from "./__fixtures__/nativeExport";
import { createEmptyDoc } from "./types";

const { rasteriseMock } = vi.hoisted(() => ({ rasteriseMock: vi.fn() }));
vi.mock("./export", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./export")>();
  return { ...actual, rasterise: rasteriseMock };
});

import { exportVerifiedSemanticArtifact } from "./verifiedExport";

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function cjkFixture(type: keyof typeof SEMANTIC_FIXTURES): Record<string, unknown> {
  const spec = structuredClone(SEMANTIC_FIXTURES[type]);
  const label = "한日中";
  spec.meta = { ...(spec.meta as Record<string, unknown>), title: `구조 ${type}` };
  const collection = type === "architecture" ? "components"
    : type === "workflow" ? "nodes"
      : type === "sequence" ? "participants"
        : type === "dataflow" ? "nodes" : "states";
  const entries = spec[collection] as Array<Record<string, unknown>>;
  entries[0] = { ...entries[0], label };
  return spec;
}

function semanticDoc(type: keyof typeof SEMANTIC_FIXTURES) {
  const { dataset } = archifySpecToDataset(type, cjkFixture(type));
  const doc = createEmptyDoc(`verified-${type}`, 1);
  doc.datasets = [dataset];
  return { doc, dataset };
}

function mockHost(type: string, candidateJson: string, options?: { format?: "svg" | "png"; theme?: "light" | "dark" }) {
  return makeEngineArtifactFixture({
    specJson: candidateJson,
    format: options?.format ?? "svg",
    theme: options?.theme,
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" width="800" height="600" data-theme="${options?.theme ?? "light"}"><title>${type}</title><desc>Mock engine artifact</desc><path aria-label="한日中" d="M10 10h30v30H10z"/></svg>`,
  });
}

beforeAll(() => vi.stubGlobal("crypto", webcrypto));
afterAll(() => vi.unstubAllGlobals());

describe("verified semantic export through the engine host", () => {
  it.each(Object.keys(SEMANTIC_FIXTURES) as Array<keyof typeof SEMANTIC_FIXTURES>)(
    "%s verifies outlined CJK SVGs in light and dark themes",
    async (type) => {
      const { doc, dataset } = semanticDoc(type);
      const candidate = JSON.stringify(dataset.spec);
      for (const theme of ["light", "dark"] as const) {
        const exported = await exportVerifiedSemanticArtifact({
          doc, datasetId: dataset.id, workspace: "/unused-by-test-host", format: "svg", theme,
          host: async (diagramType, candidateJson, _context, options) => mockHost(diagramType, candidateJson, options),
        });
        const svg = new TextDecoder().decode(exported.bytes);
        expect(svg).toContain("한日中");
        expect(svg).toContain(`data-theme="${theme}"`);
        expect(svg).not.toMatch(/<text(?:\s|>)|<script|foreignObject|file:|\/Users\/|\/home\//i);
        expect(exported.receipt.inputSpecSha256).toBe(digest(new TextEncoder().encode(candidate)));
        expect(exported.receipt.engineOutputSha256).toBe(digest(exported.bytes));
        expect(exported.receipt.outputSha256).toBe(digest(exported.bytes));
        expect(exported.receipt.outputMimeType).toBe("image/svg+xml");
        expect(exported.receipt.gates.browser.status).toBe("not-run");
      }
    },
  );

  it.each([
    ["schema version", { schemaVersion: 2 }],
    ["spec hash", { inputSpecSha256: "0".repeat(64) }],
    ["engine identity", { engine: { id: "other-engine", version: "1", revision: "r" } }],
    ["output hash", { outputSha256: "0".repeat(64) }],
    ["output MIME", { outputMimeType: "text/html" }],
    ["artifact gate", { gates: { schema: { status: "passed", scope: "architecture-document-validity" }, artifact: { status: "failed", scope: "independent-svg-artifact" }, browser: { status: "not-run", scope: "non-browser-rasterization" }, visualReview: { status: "not-run", scope: "manual" } } }],
  ])("rejects mismatched %s before conversion", async (_name, receiptOverrides) => {
    const { doc, dataset } = semanticDoc("architecture");
    const host = vi.fn(async (type: string, candidateJson: string) => makeEngineArtifactFixture({
      specJson: candidateJson, format: "svg", receiptOverrides: receiptOverrides as Partial<EngineReceipt>,
    }));
    rasteriseMock.mockClear();
    await expect(exportVerifiedSemanticArtifact({
      doc, datasetId: dataset.id, workspace: "/unused-by-test-host", format: "svg", host,
    })).rejects.toThrow(/receipt does not match/i);
    expect(host).toHaveBeenCalledTimes(1);
    expect(rasteriseMock).not.toHaveBeenCalled();
  });

  it("rejects forged outlined-text mode and SVG text content", async () => {
    const { doc, dataset } = semanticDoc("architecture");
    const specJson = JSON.stringify(dataset.spec);
    await expect(exportVerifiedSemanticArtifact({
      doc, datasetId: dataset.id, workspace: "/fixture", format: "svg",
      host: async () => makeEngineArtifactFixture({ specJson, format: "svg", textMode: "text" }),
    })).rejects.toThrow(/outlined SVG text/i);
    await expect(exportVerifiedSemanticArtifact({
      doc, datasetId: dataset.id, workspace: "/fixture", format: "svg",
      host: async () => makeEngineArtifactFixture({
        specJson, format: "svg", svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 600" width="800" height="600"><text>not outlined</text></svg>',
      }),
    })).rejects.toThrow(/emitted a text element/i);
  });

  it.each([
    ["malformed report", async (specJson: string) => ({ ...makeEngineArtifactFixture({ specJson, format: "svg" }), apiVersion: 2 })],
    ["invalid bytes", async (specJson: string) => ({ ...makeEngineArtifactFixture({ specJson, format: "svg" }), bytes: [256] })],
  ])("rejects %s at the report boundary", async (_name, hostFactory) => {
    const { doc, dataset } = semanticDoc("architecture");
    await expect(exportVerifiedSemanticArtifact({
      doc, datasetId: dataset.id, workspace: "/fixture", format: "svg",
      // Deliberately simulate a corrupt transport despite the typed host contract.
      host: async (_type, specJson) => await hostFactory(specJson) as unknown as EngineRenderedCandidate,
    })).rejects.toThrow();
  });

  it.each([["도식", "Diagram"], ["long-title", "아주 긴 제목".repeat(100)]])(
    "keeps static export available for %s when storing the artifact reports a warning",
    async (id, title) => {
      const { doc, dataset } = semanticDoc("architecture");
      doc.id = id; doc.docTitle = title;
      const warning = "Cannot store render: attachments is not a directory; repair the store and retry";
      const result = await exportVerifiedSemanticArtifact({
        doc, workspace: "/fixture", format: "svg",
        host: async (type, json, context) => {
          expect(context?.docId).toBe(id);
          expect(new TextEncoder().encode(context?.documentName).length).toBeLessThanOrEqual(256);
          expect(title.startsWith(context?.documentName ?? "")).toBe(true);
          return { ...mockHost(type, json), storeWarning: warning };
        },
      });
      expect(result.storeWarning).toBe(warning);
      expect(result.receipt.outputMimeType).toBe("image/svg+xml");
      expect(result.receipt.outputSha256).toBe(digest(result.bytes));
      expect(result.receipt.inputSpecSha256).toBe(digest(new TextEncoder().encode(JSON.stringify(dataset.spec))));
    },
  );

  it("uses the fixed native source fixture and drops untrusted receipt metadata", async () => {
    const { dataset } = archifySpecToDataset("architecture", NATIVE_EXPORT_SPEC);
    const doc = { ...createEmptyDoc("native-fixed", 1), datasets: [dataset] };
    const exported = await exportVerifiedSemanticArtifact({
      doc, workspace: "/fixture", format: "svg",
      host: async (_type, specJson) => ({
        ...makeEngineArtifactFixture({ specJson, format: "svg" }),
        receipt: Object.assign(makeEngineArtifactFixture({ specJson, format: "svg" }).receipt, { privateDiagnostics: "/private/fixture-diagnostic" }),
      }),
    });
    expect(new TextDecoder().decode(exported.bytes)).toContain("한日中");
    expect(JSON.stringify(exported.receipt)).not.toContain("privateDiagnostics");
    expect(JSON.stringify(exported.receipt)).not.toContain("fixture-diagnostic");
  });

  it("rejects cancellation before host execution and after a late host result", async () => {
    const { doc, dataset } = semanticDoc("architecture");
    const host = vi.fn(async (type: string, specJson: string) => mockHost(type, specJson));
    rasteriseMock.mockClear();
    await expect(exportVerifiedSemanticArtifact({
      doc, datasetId: dataset.id, workspace: "/fixture", format: "svg", host, isCurrent: () => false,
    })).rejects.toThrow(/cancelled/i);
    expect(host).not.toHaveBeenCalled();
    const lateHost = vi.fn(async (type: string, specJson: string) => mockHost(type, specJson));
    await expect(exportVerifiedSemanticArtifact({
      doc, datasetId: dataset.id, workspace: "/fixture", format: "svg", host: lateHost,
      isCurrent: () => lateHost.mock.results.length === 0,
    })).rejects.toThrow(/cancelled/i);
    expect(lateHost).toHaveBeenCalledTimes(1);
    expect(rasteriseMock).not.toHaveBeenCalled();
  });

  it("propagates host failure without a legacy renderer fallback", async () => {
    const { doc, dataset } = semanticDoc("architecture");
    const host = vi.fn(async () => { throw new Error("native engine unavailable"); });
    rasteriseMock.mockClear();
    await expect(exportVerifiedSemanticArtifact({
      doc, datasetId: dataset.id, workspace: "/fixture", format: "svg", host,
    })).rejects.toThrow("native engine unavailable");
    expect(host).toHaveBeenCalledTimes(1);
    expect(rasteriseMock).not.toHaveBeenCalled();
  });

  it("accepts only PNG-signature bytes and preserves the engine output hash lineage", async () => {
    const { doc, dataset } = semanticDoc("sequence");
    const specJson = JSON.stringify(dataset.spec);
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const result = await exportVerifiedSemanticArtifact({
      doc, datasetId: dataset.id, workspace: "/fixture", format: "png", theme: "dark",
      host: async (_type, json, _context, options) => makeEngineArtifactFixture({
        specJson: json, format: "png", theme: options?.theme, bytes: pngBytes,
      }),
    });
    expect([...result.bytes]).toEqual([...pngBytes]);
    expect(result.receipt.engineOutputSha256).toBeTruthy();
    expect(result.receipt.outputSha256).toBe(digest(pngBytes));
    expect(result.receipt.outputMimeType).toBe("image/png");
    expect(result.receipt.conversion).toEqual({ format: "png", theme: "dark", pixelRatio: 1 });
    await expect(exportVerifiedSemanticArtifact({
      doc, datasetId: dataset.id, workspace: "/fixture", format: "png",
      host: async (_type, json) => makeEngineArtifactFixture({ specJson: json, format: "png", bytes: [1, 2, 3] }),
    })).rejects.toThrow(/PNG artifact has an invalid signature/i);
  });
});

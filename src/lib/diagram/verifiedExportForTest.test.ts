// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { archifySpecToDataset } from "./archifyCodec";
import { SEMANTIC_FIXTURES } from "./__fixtures__/semantic";
import { createEmptyDoc } from "./types";
import { exportVerifiedEngineArtifactForTest } from "./verifiedExport";
import type { EngineArtifactHost } from "./engineArtifactForTest";

const { rasteriseMock } = vi.hoisted(() => ({ rasteriseMock: vi.fn() }));
vi.mock("./export", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./export")>();
  return { ...actual, rasterise: rasteriseMock };
});

function digest(bytes: Uint8Array): Promise<string> {
  return globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer)
    .then((hash) => [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join(""));
}

function sourceDoc() {
  const { dataset } = archifySpecToDataset("architecture", SEMANTIC_FIXTURES.architecture, { id: "engine-source" });
  const doc = createEmptyDoc("engine-export", 1);
  doc.datasets = [dataset];
  return { doc, dataset };
}

function hostWith(mutate?: (report: Record<string, unknown>, request: Record<string, unknown>) => void): EngineArtifactHost {
  return async (inputJson) => {
    const request = JSON.parse(inputJson) as Record<string, unknown>;
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10" data-kind="artifact" aria-label="한글 도식"><text>한글</text></svg>';
    const svgBytes = new TextEncoder().encode(svg);
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const format = request.format as "svg" | "png";
    const bytes = format === "svg" ? svgBytes : pngBytes;
    const receipt = {
      schemaVersion: 1,
      inputSpecSha256: await digest(new TextEncoder().encode(request.specJson as string)),
      engine: { id: "maru-diagram-engine", version: "1.2.0", revision: "test-rev" },
      engineOutputSha256: await digest(svgBytes),
      outputSha256: await digest(bytes),
      outputMimeType: format === "svg" ? "image/svg+xml" : "image/png",
      conversion: { format, theme: request.theme, pixelRatio: request.pixelRatio },
      gates: {
        schema: { status: "passed", scope: "architecture-document-validity" },
        artifact: { status: "passed", scope: format === "svg" ? "independent-svg-artifact" : "independent-svg-and-png-artifacts" },
        browser: { status: "not-run", scope: "non-browser-rasterization" },
        visualReview: { status: "not-run", scope: "manual" },
      },
      readback: { status: "not-run", scope: "saved-file-byte-comparison" },
    };
    const report: Record<string, unknown> = {
      apiVersion: 1,
      ok: true,
      bytes: [...bytes],
      svg,
      width: format === "png" ? 20 * Number(request.pixelRatio) : 20,
      height: format === "png" ? 10 * Number(request.pixelRatio) : 10,
      diagnostics: [],
      receipt,
    };
    mutate?.(report, request);
    return JSON.stringify(report);
  };
}

const forgedReceiptMutations: Array<[string, (report: Record<string, unknown>) => void]> = [
  ["input hash", (report) => { (report.receipt as Record<string, unknown>).inputSpecSha256 = "0".repeat(64); }],
  ["SVG hash", (report) => { (report.receipt as Record<string, unknown>).engineOutputSha256 = "0".repeat(64); }],
  ["output hash", (report) => { (report.receipt as Record<string, unknown>).outputSha256 = "0".repeat(64); }],
  ["engine identity", (report) => { ((report.receipt as Record<string, unknown>).engine as Record<string, unknown>).id = "archify"; }],
  ["artifact gate", (report) => { (((report.receipt as Record<string, unknown>).gates as Record<string, unknown>).artifact as Record<string, unknown>).status = "not-run"; }],
];

beforeAll(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllEnvs());
afterAll(() => vi.unstubAllGlobals());

describe("verified native engine artifact test adapter", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_ENGINE_GEOMETRY_TEST", "1");
    rasteriseMock.mockClear();
  });

  it.each([
    ["svg", 1],
    ["png", 2],
  ] as const)("verifies the complete Rust %s report and hashes", async (format, pixelRatio) => {
    const { doc, dataset } = sourceDoc();
    const host = hostWith();
    const result = await exportVerifiedEngineArtifactForTest({
      doc,
      datasetId: dataset.id,
      format,
      theme: "dark",
      pixelRatio,
      host,
    });
    expect(result.receipt.engine.id).toBe("maru-diagram-engine");
    expect(result.receipt.inputSpecSha256).toBe(await digest(new TextEncoder().encode(JSON.stringify(dataset.spec))));
    expect(result.receipt.engineOutputSha256).toBe(await digest(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10" data-kind="artifact" aria-label="한글 도식"><text>한글</text></svg>')));
    expect(result.receipt.outputSha256).toBe(await digest(result.bytes));
    expect(result.receipt.conversion).toEqual({ format, theme: "dark", pixelRatio });
    expect(result.receipt.gates.artifact.scope).toBe(format === "svg" ? "independent-svg-artifact" : "independent-svg-and-png-artifacts");
    expect(result.svgForDom).toContain("한글");
    expect(result.svgForDom).toContain('aria-label="한글 도식"');
    expect(result.svgForDom).toContain('data-kind="artifact"');
    expect(Array.from(result.bytes)).toEqual(Array.from(format === "svg" ? new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10" data-kind="artifact" aria-label="한글 도식"><text>한글</text></svg>') : new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3])));
    expect(rasteriseMock).not.toHaveBeenCalled();
  });

  it.each(forgedReceiptMutations)("rejects forged %s receipts", async (_name, mutate) => {
    const { doc } = sourceDoc();
    await expect(exportVerifiedEngineArtifactForTest({ doc, format: "svg", host: hostWith((report) => mutate(report)) }))
      .rejects.toThrow(/receipt does not match/i);
  });

  it("rejects SVG byte/string disagreement and untrusted PNG bytes", async () => {
    const { doc } = sourceDoc();
    const changedSvgBytes = hostWith((report) => { report.bytes = [1, 2, 3]; });
    await expect(exportVerifiedEngineArtifactForTest({ doc, format: "svg", host: changedSvgBytes }))
      .rejects.toThrow(/differ from the receipt/i);
    const invalidPng = hostWith((report) => { report.bytes = [1, 2, 3]; });
    await expect(exportVerifiedEngineArtifactForTest({ doc, format: "png", host: invalidPng }))
      .rejects.toThrow(/invalid signature/i);
  });

  it("preserves the first Rust refusal cause and repair fix instead of blaming the dataset", async () => {
    const { doc } = sourceDoc();
    const refusal = hostWith((report) => {
      report.ok = false;
      report.bytes = null;
      report.svg = null;
      report.width = null;
      report.height = null;
      report.diagnostics = [{
        code: "render/png-pixel-budget",
        path: "/pixelRatio",
        rule: "render-v1/png-pixel-budget",
        message: "PNG pixel ratio exceeds the raster pixel budget.",
        fix: "Reduce pixel ratio or logical viewBox dimensions and retry.",
      }];
    });
    await expect(exportVerifiedEngineArtifactForTest({
      doc,
      format: "png",
      pixelRatio: 4,
      host: refusal,
    })).rejects.toThrow(/PNG pixel ratio exceeds the raster pixel budget.*Reduce pixel ratio or logical viewBox dimensions and retry/);
  });

  it("distinguishes missing and malformed refusal diagnostics", async () => {
    const { doc } = sourceDoc();
    const refusedWithoutDiagnostic = hostWith((report) => {
      report.ok = false;
      report.bytes = null;
      report.svg = null;
      report.width = null;
      report.height = null;
      report.diagnostics = [];
    });
    await expect(exportVerifiedEngineArtifactForTest({ doc, format: "svg", host: refusedWithoutDiagnostic }))
      .rejects.toThrow(/refused the artifact without an actionable diagnostic/i);

    const malformedDiagnostic = hostWith((report) => {
      report.ok = false;
      report.bytes = null;
      report.svg = null;
      report.width = null;
      report.height = null;
      report.diagnostics = [{ code: "render/failure", message: "missing path, rule, and fix" }];
    });
    await expect(exportVerifiedEngineArtifactForTest({ doc, format: "svg", host: malformedDiagnostic }))
      .rejects.toThrow(/artifact report has an incompatible shape/i);
  });

  it("checks cancellation after hashing and before calling the native host", async () => {
    const { doc } = sourceDoc();
    const host = vi.fn(hostWith());
    let checks = 0;
    await expect(exportVerifiedEngineArtifactForTest({
      doc,
      format: "svg",
      host,
      isCurrent: () => ++checks < 2,
    })).rejects.toThrow(/cancelled/i);
    expect(host).not.toHaveBeenCalled();
  });

  it("checks cancellation again after the native report returns", async () => {
    const { doc } = sourceDoc();
    const host = vi.fn(hostWith());
    let checks = 0;
    await expect(exportVerifiedEngineArtifactForTest({
      doc,
      format: "svg",
      host,
      isCurrent: () => ++checks < 3,
    })).rejects.toThrow(/cancelled/i);
    expect(host).toHaveBeenCalledTimes(1);
  });
});

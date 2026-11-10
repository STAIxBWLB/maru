// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  Diagnostic,
  EngineReceipt,
  GeometryReport,
  LayoutRequest,
  ValidationReport,
} from "../../../src-tauri/crates/maru-diagram-engine/bindings/engine";
import {
  createProductDiagramEngine,
  type ProductDiagramEnginePorts,
} from "./engine";
import {
  renderEngineArtifact,
  type EngineArtifactPorts,
  type EngineArtifactReport,
  type EngineArtifactRequest,
} from "./engineArtifact";

const spec = {
  schema_version: 1,
  diagram_type: "architecture",
  meta: { title: "Engine facade", output: "engine.html" },
  components: [{ id: "api", type: "backend", label: "API" }],
};
const specJson = JSON.stringify(spec);

beforeAll(() => vi.stubGlobal("crypto", webcrypto));
afterAll(() => vi.unstubAllGlobals());

async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const hash = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function receipt(inputSpecSha256: string, artifact = false): EngineReceipt {
  return {
    schemaVersion: 1,
    inputSpecSha256,
    engine: { id: "maru-diagram-engine", version: "0.1.0", revision: "e1-document-validity-v1" },
    gates: {
      schema: { status: "passed", scope: "architecture-document-validity" },
      artifact: { status: artifact ? "passed" : "not-run", scope: artifact ? "independent-svg-artifact" : "layout-only" },
      browser: { status: "not-run", scope: "non-browser-rasterization" },
      visualReview: { status: "not-run", scope: "manual" },
    },
    readback: { status: "not-run", scope: "saved-file-byte-comparison" },
  };
}

function validationReport(ok: boolean, inputSpecSha256: string, diagnostics: Diagnostic[] = []): ValidationReport {
  return { apiVersion: 1, ok, diagnostics, receipt: receipt(inputSpecSha256) };
}

function geometryReport(ok: boolean, inputSpecSha256: string, diagnostics: Diagnostic[] = []): GeometryReport {
  return { apiVersion: 1, ok, diagnostics, receipt: receipt(inputSpecSha256) };
}

function diagnostic(message: string, fix: string): Diagnostic {
  return {
    code: "architecture/label-overflow",
    path: "/components/0/label",
    rule: "geometry-v1/text-fit",
    message,
    fix,
  };
}

async function artifactReport(input: EngineArtifactRequest, textMode?: "text" | "outlines"): Promise<EngineArtifactReport> {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><path d="M0 0h1"/></svg>';
  const svgBytes = new TextEncoder().encode(svg);
  const bytes = input.format === "svg" ? svgBytes : new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const pixelRatio = input.pixelRatio ?? 1;
  const sourceHash = await sha256(input.specJson);
  const outputHash = await sha256(bytes);
  const svgHash = await sha256(svgBytes);
  return {
    apiVersion: 1,
    ok: true,
    bytes: [...bytes],
    svg,
    width: 20 * pixelRatio,
    height: 10 * pixelRatio,
    diagnostics: [],
    ...(textMode ? { textMode } : {}),
    receipt: {
      ...receipt(sourceHash, true),
      engineOutputSha256: svgHash,
      outputSha256: outputHash,
      outputMimeType: input.format === "svg" ? "image/svg+xml" : "image/png",
      conversion: { format: input.format, theme: input.theme, pixelRatio },
      gates: {
        schema: { status: "passed", scope: "architecture-document-validity" },
        artifact: {
          status: "passed",
          scope: input.format === "svg" ? "independent-svg-artifact" : "independent-svg-and-png-artifacts",
        },
        browser: { status: "not-run", scope: "non-browser-rasterization" },
        visualReview: { status: "not-run", scope: "manual" },
      },
    },
  };
}

describe("product diagram engine facade", () => {
  it("runs E1 before layout and uses the layout report's ok as admission", async () => {
    const hash = await sha256(specJson);
    const calls: string[] = [];
    const ports: ProductDiagramEnginePorts = {
      validate: async (input) => {
        calls.push("validate");
        expect(input).toBe(specJson);
        return validationReport(true, hash);
      },
      layout: async (request: LayoutRequest) => {
        calls.push("layout");
        expect(request.specJson).toBe(specJson);
        return geometryReport(false, hash, [diagnostic("Label overflows its node.", "Shorten the label or enlarge its node.")]);
      },
      render: async () => { throw new Error("render is not expected in a validation test"); },
    };

    const engine = createProductDiagramEngine(ports);
    const result = await engine.validateCandidate("architecture", specJson);
    expect(calls).toEqual(["validate", "layout"]);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("Label overflows its node.");
    expect(result.errors.join(" ")).toContain("Shorten the label or enlarge its node.");
    expect(result.candidateSha256).toBe(hash);
    expect(result.receipt?.inputSpecSha256).toBe(hash);
  });

  it("stops after an E1 refusal and preserves its cause and repair", async () => {
    const hash = await sha256(specJson);
    const calls: string[] = [];
    const engine = createProductDiagramEngine({
      validate: async () => {
        calls.push("validate");
        return validationReport(false, hash, [diagnostic("Unknown component type.", "Choose a supported type.")]);
      },
      layout: async () => {
        calls.push("layout");
        return geometryReport(true, hash);
      },
      render: async () => { throw new Error("render is not expected in a validation test"); },
    });
    const result = await engine.validateCandidate("architecture", specJson);
    expect(calls).toEqual(["validate"]);
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("Unknown component type.");
    expect(result.errors.join(" ")).toContain("Choose a supported type.");
  });

  it("refuses type mismatch before the SDK sees the candidate and preserves raw JSON text", async () => {
    const validate = vi.fn(async () => validationReport(true, await sha256(specJson)));
    const layout = vi.fn(async () => geometryReport(true, await sha256(specJson)));
    const engine = createProductDiagramEngine({
      validate,
      layout,
      render: async () => { throw new Error("render is not expected in a validation test"); },
    });
    const mismatch = await engine.validateCandidate("workflow", specJson);
    expect(mismatch.ok).toBe(false);
    expect(mismatch.errors.join(" ")).toContain("does not match");
    expect(validate).not.toHaveBeenCalled();

    const whitespace = ` ${specJson}\n`;
    const hash = await sha256(whitespace);
    const sourceCalls: string[] = [];
    const preserving = createProductDiagramEngine({
      validate: async (input) => { sourceCalls.push(input); return validationReport(true, hash); },
      layout: async (request) => { sourceCalls.push(request.specJson); return geometryReport(true, hash); },
      render: async () => { throw new Error("render is not expected in a validation test"); },
    });
    const accepted = await preserving.validateCandidate("architecture", whitespace);
    expect(accepted.ok).toBe(true);
    expect(sourceCalls).toEqual([whitespace, whitespace]);
  });

  it("rejects a mismatched SDK receipt instead of trusting its ok flag", async () => {
    const engine = createProductDiagramEngine({
      validate: async () => validationReport(true, "0".repeat(64)),
      layout: async () => geometryReport(true, "0".repeat(64)),
      render: async () => { throw new Error("render is not expected in a validation test"); },
    });
    await expect(engine.validateCandidate("architecture", specJson)).rejects.toThrow(/receipt does not match/i);
  });
});

describe("product artifact transport", () => {
  it("uses WASM text SVG for previews and normalizes an omitted preview textMode", async () => {
    const renderSvgPreview = vi.fn(async (requestJson: string) => {
      const request = JSON.parse(requestJson) as Record<string, unknown>;
      expect(request.textMode).toBeUndefined();
      return artifactReport({ specJson, format: "svg", theme: "dark", purpose: "preview" });
    });
    const renderSvgExport = vi.fn(async () => { throw new Error("export port must not be selected"); });
    const renderPng = vi.fn(async () => { throw new Error("PNG port must not be selected"); });
    const report = await renderEngineArtifact({
      specJson,
      format: "svg",
      theme: "dark",
      purpose: "preview",
    }, { renderSvgPreview, renderSvgExport, renderPng });
    expect(report.textMode).toBe("text");
    expect(renderSvgPreview).toHaveBeenCalledTimes(1);
    expect(renderSvgExport).not.toHaveBeenCalled();
    expect(renderPng).not.toHaveBeenCalled();
  });

  it("uses native outlined SVG for exports and requires the proof field", async () => {
    const renderSvgExport = vi.fn(async (requestJson: string) => {
      expect(JSON.parse(requestJson)).toMatchObject({ textMode: "outlines" });
      return artifactReport({ specJson, format: "svg", theme: "light", purpose: "export" }, "outlines");
    });
    const renderSvgPreview = vi.fn(async () => { throw new Error("preview port must not be selected"); });
    const report = await renderEngineArtifact({ specJson, format: "svg", theme: "light" }, {
      renderSvgExport,
      renderSvgPreview,
    });
    expect(report.textMode).toBe("outlines");
    expect(renderSvgExport).toHaveBeenCalledTimes(1);
    expect(renderSvgPreview).not.toHaveBeenCalled();

    await expect(renderEngineArtifact({ specJson, format: "svg", theme: "light" }, {
      renderSvgExport: async () => artifactReport({ specJson, format: "svg", theme: "light" }),
    })).rejects.toThrow(/outlined SVG text/i);
  });

  it("always sends PNG requests to the native port", async () => {
    const renderPng = vi.fn(async (requestJson: string) => {
      expect(JSON.parse(requestJson)).toMatchObject({ format: "png", pixelRatio: 2 });
      return artifactReport({ specJson, format: "png", theme: "dark", pixelRatio: 2 });
    });
    const renderSvgPreview = vi.fn(async () => { throw new Error("PNG must not use WASM"); });
    const report = await renderEngineArtifact({
      specJson,
      format: "png",
      theme: "dark",
      pixelRatio: 2,
      purpose: "preview",
    }, { renderPng, renderSvgPreview });
    expect(report.receipt.outputMimeType).toBe("image/png");
    expect(renderPng).toHaveBeenCalledTimes(1);
    expect(renderSvgPreview).not.toHaveBeenCalled();
  });
});

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

  describe("receipt envelope (#137)", () => {
    type Mutate = (receipt: Record<string, unknown>) => void;
    const cases: Array<[string, Mutate, RegExp]> = [
      ["missing schemaVersion", (r) => { delete r.schemaVersion; }, /schemaVersion is missing, not the supported 1/],
      ["unsupported schemaVersion", (r) => { r.schemaVersion = 2; }, /schemaVersion is 2, not the supported 1/],
      ["non-number schemaVersion, not echoed", (r) => { r.schemaVersion = "/Users/someone/secret"; }, /schemaVersion is of type string, not the supported 1/],
      ["missing gates", (r) => { delete r.gates; }, /no gates record/],
      ["missing gate", (r) => { delete (r.gates as Record<string, unknown>).visualReview; }, /gate "visualReview" is missing or malformed/],
      ["unknown gate status", (r) => { (r.gates as Record<string, Record<string, unknown>>).schema!.status = "skipped"; }, /gate "schema" is missing or malformed/],
      ["empty gate scope", (r) => { (r.gates as Record<string, Record<string, unknown>>).browser!.scope = ""; }, /gate "browser" is missing or malformed/],
    ];

    for (const where of ["validation", "layout"] as const) {
      for (const [name, mutate, message] of cases) {
        it(`fails closed on ${name} in the ${where} receipt, naming the next step`, async () => {
          const hash = await sha256(specJson);
          const broken = (report: ValidationReport | GeometryReport) => {
            const receiptCopy = structuredClone(report.receipt) as unknown as Record<string, unknown>;
            mutate(receiptCopy);
            return { ...report, receipt: receiptCopy as unknown as EngineReceipt };
          };
          const layout = vi.fn(async () => where === "layout" ? broken(geometryReport(true, hash)) as GeometryReport : geometryReport(true, hash));
          const engine = createProductDiagramEngine({
            validate: async () => where === "validation" ? broken(validationReport(true, hash)) as ValidationReport : validationReport(true, hash),
            layout,
            render: async () => { throw new Error("render is not expected in a validation test"); },
          });
          const rejection = engine.validateCandidate("architecture", specJson);
          await expect(rejection).rejects.toThrow(message);
          await expect(rejection).rejects.toThrow(/update Maru so the app and engine match, then retry/);
          await expect(rejection).rejects.not.toThrow(/\/Users\//);
          if (where === "validation") expect(layout).not.toHaveBeenCalled();
        });
      }

      for (const status of ["failed", "not-run"]) {
        it(`fails closed on an ok ${where} report whose schema gate is ${status} (T137-R1)`, async () => {
          const hash = await sha256(specJson);
          const stamp = <T extends ValidationReport | GeometryReport>(report: T): T => {
            report.receipt.gates.schema = { status, scope: "architecture-document-validity" };
            return report;
          };
          const layout = vi.fn(async () => where === "layout" ? stamp(geometryReport(true, hash)) : geometryReport(true, hash));
          const engine = createProductDiagramEngine({
            validate: async () => where === "validation" ? stamp(validationReport(true, hash)) : validationReport(true, hash),
            layout,
            render: async () => { throw new Error("render is not expected in a validation test"); },
          });
          const rejection = engine.validateCandidate("architecture", specJson);
          await expect(rejection).rejects.toThrow(new RegExp(`${where} report says ok but its receipt's schema gate is "${status}"`));
          await expect(rejection).rejects.toThrow(/update Maru so the app and engine match, then retry/);
          if (where === "validation") expect(layout).not.toHaveBeenCalled();
        });

        it(`still reports a refused ${where} report whose schema gate is ${status}`, async () => {
          const hash = await sha256(specJson);
          const refuse = <T extends ValidationReport | GeometryReport>(report: T): T => {
            report.receipt.gates.schema = { status, scope: "architecture-document-validity" };
            return report;
          };
          const engine = createProductDiagramEngine({
            validate: async () => where === "validation" ? refuse(validationReport(false, hash, [diagnostic("Bad.", "Fix it.")])) : validationReport(true, hash),
            layout: async () => where === "layout" ? refuse(geometryReport(false, hash, [diagnostic("Bad.", "Fix it.")])) : geometryReport(true, hash),
            render: async () => { throw new Error("render is not expected in a validation test"); },
          });
          const result = await engine.validateCandidate("architecture", specJson);
          expect(result.ok).toBe(false);
          expect(result.errors.join(" ")).toContain("Bad.");
        });
      }
    }

    it("accepts every gate status the engine emits", async () => {
      const hash = await sha256(specJson);
      const withStatus = (status: string) => {
        const report = geometryReport(true, hash);
        report.receipt.gates.artifact = { status, scope: "layout-only" };
        return report;
      };
      for (const status of ["passed", "failed", "not-run"]) {
        const engine = createProductDiagramEngine({
          validate: async () => validationReport(true, hash),
          layout: async () => withStatus(status),
          render: async () => { throw new Error("render is not expected in a validation test"); },
        });
        expect((await engine.validateCandidate("architecture", specJson)).ok).toBe(true);
      }
    });
  });

  it("routes floorplan to its own engine entry, never the diagram_type validator", async () => {
    const floorplanJson = JSON.stringify({ $schema: "floorplan/architecture@1", project: { name: "Map" }, nodes: [{ id: "a", label: "A", kind: "service" }], edges: [] });
    const hash = await sha256(floorplanJson);
    const validate = vi.fn(async () => validationReport(true, hash));
    const layout = vi.fn(async () => geometryReport(true, hash));
    const layoutFloorplan = vi.fn(async () => geometryReport(false, hash, [diagnostic("A frame nests too deep.", "Flatten the deepest frames.")]));
    const engine = createProductDiagramEngine({ validate, layout, layoutFloorplan, render: async () => { throw new Error("render is not expected"); } });
    const result = await engine.validateCandidate("floorplan", floorplanJson);
    expect(validate).not.toHaveBeenCalled();
    expect(layout).not.toHaveBeenCalled();
    expect(layoutFloorplan).toHaveBeenCalledWith({ specJson: floorplanJson });
    expect(result.ok).toBe(false);
    expect(result.errors.join(" ")).toContain("A frame nests too deep.");
    expect(result.errors.join(" ")).toContain("Flatten the deepest frames.");
    expect(result.receipt?.inputSpecSha256).toBe(hash);
  });

  it("fails closed when a floorplan receipt names another source or the floorplan entry is missing", async () => {
    const floorplanJson = JSON.stringify({ $schema: "floorplan/architecture@1", project: { name: "Map" }, nodes: [{ id: "a", label: "A", kind: "service" }], edges: [] });
    const base = { validate: async () => validationReport(true, "0".repeat(64)), layout: async () => geometryReport(true, "0".repeat(64)), render: async () => { throw new Error("render is not expected"); } };
    const forged = createProductDiagramEngine({ ...base, layoutFloorplan: async () => geometryReport(true, "0".repeat(64)) });
    await expect(forged.validateCandidate("floorplan", floorplanJson)).rejects.toThrow(/receipt does not match/i);
    const missing = createProductDiagramEngine(base);
    await expect(missing.validateCandidate("floorplan", floorplanJson)).rejects.toThrow(/Floorplan engine entry is missing/);
    const enveloped = await forged.validateCandidate("floorplan", JSON.stringify({ diagram_type: "architecture" }));
    expect(enveloped.ok).toBe(false);
    expect(enveloped.errors.join(" ")).toContain("not a Floorplan document");
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

// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { name, revision, version } from "../../../sidecars/archify/PIN.json";
import { archifySpecToDataset } from "./archifyCodec";
import { SEMANTIC_FIXTURES } from "./__fixtures__/semantic";
import { ARCHIFY_STATIC_TYPES } from "./export";
import { NATIVE_EXPORT_SPEC } from "./__fixtures__/nativeExport";
import { createEmptyDoc } from "./types";
import type { ArchifyRenderArtifact } from "../archify";

const { rasteriseMock } = vi.hoisted(() => ({ rasteriseMock: vi.fn() }));
vi.mock("./export", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./export")>();
  return { ...actual, rasterise: rasteriseMock };
});

import { exportVerifiedSemanticArtifact } from "./verifiedExport";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const enginePath = join(repoRoot, "sidecars/archify/bin/archify.mjs");
const renderCache = new Map<string, ArchifyRenderArtifact>();

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

function pinnedNodeArtifact(diagramType: string, candidateJson: string): ArchifyRenderArtifact {
  const cacheKey = `${diagramType}\n${candidateJson}`;
  const cached = renderCache.get(cacheKey);
  if (cached) return cached;

  const work = mkdtempSync(join(tmpdir(), "maru-verified-export-"));
  try {
    const input = join(work, "candidate.json");
    const output = join(work, "rendered.html");
    writeFileSync(input, candidateJson, { encoding: "utf8", flag: "wx" });
    const validate = spawnSync(process.execPath, [enginePath, "validate", diagramType, input, "--json"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (validate.error || validate.status !== 0) {
      throw new Error(`Pinned validation failed (status ${validate.status}, signal ${validate.signal}): ${validate.error?.message ?? (validate.stderr || validate.stdout)}`);
    }
    const validation = JSON.parse(validate.stdout) as {
      ok?: boolean;
      candidate?: { sha256?: string };
      diagnostics?: unknown[];
    };
    if (validation.ok !== true || validation.candidate?.sha256 !== digest(new TextEncoder().encode(candidateJson))) {
      throw new Error(`Pinned validation rejected ${diagramType}: ${JSON.stringify(validation.diagnostics)}`);
    }
    const render = spawnSync(process.execPath, [enginePath, "render", diagramType, input, output], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (render.error || render.status !== 0) {
      throw new Error(`Pinned render failed (status ${render.status}, signal ${render.signal}): ${render.error?.message ?? (render.stderr || render.stdout)}`);
    }
    const bytes = new Uint8Array(readFileSync(output));
    const artifact: ArchifyRenderArtifact = {
      bytes: [...bytes],
      receipt: {
        schemaVersion: 1,
        inputSpecSha256: validation.candidate.sha256,
        enginePin: { name, version, revision },
        outputSha256: digest(bytes),
        outputMimeType: "text/html",
        gates: {
          schema: { status: "passed", scope: "pinned-engine-validation" },
          artifact: { status: "passed", scope: "pinned-engine-rendered-html" },
          browser: { status: "not-run", scope: "none" },
          visualReview: { status: "not-run", scope: "manual" },
        },
      },
    };
    renderCache.set(cacheKey, artifact);
    return artifact;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

function semanticDoc(type: keyof typeof SEMANTIC_FIXTURES) {
  const { dataset } = archifySpecToDataset(type, cjkFixture(type));
  const doc = createEmptyDoc(`verified-${type}`, 1);
  doc.datasets = [dataset];
  return { doc, dataset };
}

beforeAll(async () => {
  const { webcrypto } = await import("node:crypto");
  vi.stubGlobal("crypto", webcrypto);
});

afterAll(() => {
  vi.unstubAllGlobals();
  rasteriseMock.mockReset();
});

describe("verified semantic export against the pinned renderer", () => {
  it.each(ARCHIFY_STATIC_TYPES)(
    "%s preserves CJK in sanitized light and dark SVG and binds both hashes",
    async (type) => {
      const { doc, dataset } = semanticDoc(type);
      const candidate = JSON.stringify(dataset.spec);
      const host = async (diagramType: string, candidateJson: string) => pinnedNodeArtifact(diagramType, candidateJson);
      for (const theme of ["light", "dark"] as const) {
        const exported = await exportVerifiedSemanticArtifact({
          doc,
          datasetId: dataset.id,
          workspace: "/unused-by-test-host",
          format: "svg",
          theme,
          host,
        });
        const svg = new TextDecoder().decode(exported.bytes);
        const engine = pinnedNodeArtifact(type, candidate);
        expect(svg).toContain("한日中");
        expect(svg).toContain(`data-theme="${theme}"`);
        expect(svg).not.toMatch(/<script|foreignObject|file:|\/Users\/|\/home\//i);
        expect(exported.receipt.inputSpecSha256).toBe(digest(new TextEncoder().encode(candidate)));
        expect(exported.receipt.engineOutputSha256).toBe(engine.receipt.outputSha256);
        expect(exported.receipt.outputSha256).toBe(digest(exported.bytes));
        expect(exported.receipt.outputMimeType).toBe("image/svg+xml");
        expect(exported.receipt.gates.browser.status).toBe("passed");
      }
    },
  );

  it.each([
    ["schema version", (artifact: ArchifyRenderArtifact) => ({ ...artifact.receipt, schemaVersion: 2 as 1 })],
    ["spec hash", (artifact: ArchifyRenderArtifact) => ({ ...artifact.receipt, inputSpecSha256: "0".repeat(64) })],
    ["pinned revision", (artifact: ArchifyRenderArtifact) => ({ ...artifact.receipt, enginePin: { ...artifact.receipt.enginePin, revision: "wrong" } })],
    ["output hash", (artifact: ArchifyRenderArtifact) => ({ ...artifact.receipt, outputSha256: "0".repeat(64) })],
    ["output MIME", (artifact: ArchifyRenderArtifact) => ({ ...artifact.receipt, outputMimeType: "image/svg+xml" })],
  ])("rejects a mismatched %s before conversion", async (_name, mutateReceipt) => {
    const { doc, dataset } = semanticDoc("architecture");
    const valid = pinnedNodeArtifact("architecture", JSON.stringify(dataset.spec));
    const host = vi.fn(async () => ({ ...valid, receipt: mutateReceipt(valid) }));
    rasteriseMock.mockClear();
    await expect(exportVerifiedSemanticArtifact({
      doc, datasetId: dataset.id, workspace: "/unused-by-test-host", format: "svg", host,
    })).rejects.toThrow(/receipt does not match/i);
    expect(host).toHaveBeenCalledTimes(1);
    expect(rasteriseMock).not.toHaveBeenCalled();
  });

  it("validates the exact fixed native fixture and drops unknown receipt diagnostics", async () => {
    const { dataset } = archifySpecToDataset("architecture", NATIVE_EXPORT_SPEC);
    const doc = { ...createEmptyDoc("native-fixed", 1), datasets: [dataset] };
    const exported = await exportVerifiedSemanticArtifact({ doc, workspace: "/unused-by-test-host", format: "svg", host: async (type, json) => {
      const artifact = pinnedNodeArtifact(type, json);
      return { ...artifact, receipt: Object.assign({}, artifact.receipt, { privateDiagnostics: "/private/fixture-diagnostic" }) };
    } });
    expect(new TextDecoder().decode(exported.bytes)).toContain("한日中");
    expect(JSON.stringify(exported.receipt)).not.toContain("privateDiagnostics");
    expect(JSON.stringify(exported.receipt)).not.toContain("fixture-diagnostic");
  });

  it("rejects cancellation before calling the host and rejects late cancellation before conversion", async () => {
    const { doc, dataset } = semanticDoc("architecture");
    const host = vi.fn(async (type: string, candidateJson: string) => pinnedNodeArtifact(type, candidateJson));
    rasteriseMock.mockClear();
    await expect(exportVerifiedSemanticArtifact({
      doc, datasetId: dataset.id, workspace: "/unused-by-test-host", format: "svg", host, isCurrent: () => false,
    })).rejects.toThrow(/cancelled/i);
    expect(host).not.toHaveBeenCalled();

    const lateHost = vi.fn(async (type: string, candidateJson: string) => pinnedNodeArtifact(type, candidateJson));
    await expect(exportVerifiedSemanticArtifact({
      doc,
      datasetId: dataset.id,
      workspace: "/unused-by-test-host",
      format: "svg",
      host: lateHost,
      isCurrent: () => lateHost.mock.results.length === 0,
    })).rejects.toThrow(/cancelled/i);
    expect(lateHost).toHaveBeenCalledTimes(1);
    expect(rasteriseMock).not.toHaveBeenCalled();
  });

  it("propagates renderer failure without attempting a legacy export fallback", async () => {
    const { doc, dataset } = semanticDoc("architecture");
    const host = vi.fn(async () => { throw new Error("pinned renderer unavailable"); });
    rasteriseMock.mockClear();
    await expect(exportVerifiedSemanticArtifact({
      doc, datasetId: dataset.id, workspace: "/unused-by-test-host", format: "svg", host,
    })).rejects.toThrow("pinned renderer unavailable");
    expect(host).toHaveBeenCalledTimes(1);
    expect(rasteriseMock).not.toHaveBeenCalled();
  });

  it("uses the sanitized SVG to PNG rasterise boundary and records final-byte hash lineage", async () => {
    const { doc, dataset } = semanticDoc("sequence");
    const candidate = JSON.stringify(dataset.spec);
    const engine = pinnedNodeArtifact("sequence", candidate);
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    rasteriseMock.mockImplementation(async (svg: SVGSVGElement, mime: string, background: string | null, pixelRatio: number) => {
      expect(svg.localName).toBe("svg");
      expect(svg.textContent).toContain("한日中");
      expect(svg.outerHTML).not.toMatch(/<script|foreignObject|file:|\/Users\/|\/home\//i);
      expect(mime).toBe("image/png");
      expect(background).toBeNull();
      expect(pixelRatio).toBe(1);
      return { blob: new Blob([png], { type: mime }), width: 800, height: 600, mimeType: mime, extension: "png" };
    });
    const exported = await exportVerifiedSemanticArtifact({
      doc,
      datasetId: dataset.id,
      workspace: "/unused-by-test-host",
      format: "png",
      theme: "dark",
      host: async (type, candidateJson) => pinnedNodeArtifact(type, candidateJson),
    });
    expect([...exported.bytes]).toEqual([...png]);
    expect(exported.receipt.engineOutputSha256).toBe(engine.receipt.outputSha256);
    expect(exported.receipt.outputSha256).toBe(digest(png));
    expect(exported.receipt.outputMimeType).toBe("image/png");
    expect(exported.receipt.conversion).toEqual({ format: "png", theme: "dark", pixelRatio: 1 });
    expect(rasteriseMock).toHaveBeenCalledTimes(1);
  });
});

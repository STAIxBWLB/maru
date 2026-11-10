// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { renderEngineCandidate } from "./engineCandidate";

const specJson = JSON.stringify({
  schema_version: 1,
  diagram_type: "architecture",
  meta: { title: "Stored SVG", output: "stored.html" },
  components: [{ id: "api", type: "backend", label: "API" }],
});

beforeAll(() => vi.stubGlobal("crypto", webcrypto));
afterAll(() => vi.unstubAllGlobals());

async function hash(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

describe("renderEngineCandidate", () => {
  it("sends outlined SVG to the native render-and-store command and verifies the raw report", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><path d="M0 0h1"/></svg>';
    const bytes = new TextEncoder().encode(svg);
    const sourceHash = await hash(new TextEncoder().encode(specJson));
    const outputHash = await hash(bytes);
    const call = vi.fn(async (_command: string, _args: Record<string, unknown>) => ({
      report: {
        apiVersion: 1,
        ok: true,
        bytes: [...bytes],
        svg,
        width: 20,
        height: 10,
        textMode: "outlines",
        diagnostics: [],
        receipt: {
          schemaVersion: 1,
          inputSpecSha256: sourceHash,
          engine: { id: "maru-diagram-engine", version: "0.2.0", revision: "render-v1" },
          engineOutputSha256: outputHash,
          outputSha256: outputHash,
          outputMimeType: "image/svg+xml",
          conversion: { format: "svg", theme: "light", pixelRatio: 1 },
          gates: {
            schema: { status: "passed", scope: "architecture-document-validity" },
            artifact: { status: "passed", scope: "independent-svg-artifact" },
            browser: { status: "not-run", scope: "non-browser-rasterization" },
            visualReview: { status: "not-run", scope: "manual" },
          },
          readback: { status: "not-run", scope: "saved-file-byte-comparison" },
        },
      },
      storeWarning: "Render was generated but not saved.",
    }));
    const context = {
      docId: "doc-1",
      documentName: "Architecture",
      documentRevision: "rev-1",
      datasetId: "dataset-1",
      diagramType: "architecture",
    };

    const rendered = await renderEngineCandidate("/workspace", "architecture", specJson, context, {}, call);
    expect(call).toHaveBeenCalledWith("plugin:maru-diagram|render_and_store", {
      workspace: "/workspace",
      input: JSON.stringify({ specJson, theme: "light", format: "svg", pixelRatio: 1, textMode: "outlines" }),
      context,
    });
    expect(rendered.bytes).toEqual([...bytes]);
    expect(rendered.svg).toBe(svg);
    expect(rendered.width).toBe(20);
    expect(rendered.height).toBe(10);
    expect(rendered.textMode).toBe("outlines");
    expect(rendered.receipt.engine.id).toBe("maru-diagram-engine");
    expect(rendered.storeWarning).toBe("Render was generated but not saved.");
  });

  it("does not accept the render-and-store wrapper as the artifact report itself", async () => {
    const call = vi.fn(async () => ({ apiVersion: 1, ok: true }));
    await expect(renderEngineCandidate("/workspace", "architecture", specJson, undefined, {}, call))
      .rejects.toThrow(/incompatible render-and-store result/);
  });

  it("sends PNG through the combined native command without an SVG text-mode field", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><path d="M0 0h1"/></svg>';
    const svgBytes = new TextEncoder().encode(svg);
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2]);
    const sourceHash = await hash(new TextEncoder().encode(specJson));
    const svgHash = await hash(svgBytes);
    const outputHash = await hash(pngBytes);
    const call = vi.fn(async (_command: string, _args: Record<string, unknown>) => ({
      report: {
        apiVersion: 1,
        ok: true,
        bytes: [...pngBytes],
        svg,
        width: 40,
        height: 20,
        diagnostics: [],
        receipt: {
          schemaVersion: 1,
          inputSpecSha256: sourceHash,
          engine: { id: "maru-diagram-engine", version: "0.2.0", revision: "render-v1" },
          engineOutputSha256: svgHash,
          outputSha256: outputHash,
          outputMimeType: "image/png",
          conversion: { format: "png", theme: "dark", pixelRatio: 2 },
          gates: {
            schema: { status: "passed", scope: "architecture-document-validity" },
            artifact: { status: "passed", scope: "independent-svg-and-png-artifacts" },
            browser: { status: "not-run", scope: "non-browser-rasterization" },
            visualReview: { status: "not-run", scope: "manual" },
          },
          readback: { status: "not-run", scope: "saved-file-byte-comparison" },
        },
      },
    }));

    const rendered = await renderEngineCandidate(
      "/workspace", "architecture", specJson, undefined,
      { format: "png", theme: "dark", pixelRatio: 2 }, call,
    );
    const request = JSON.parse(call.mock.calls[0]![1].input as string) as Record<string, unknown>;
    expect(call).toHaveBeenCalledWith("plugin:maru-diagram|render_and_store", {
      workspace: "/workspace",
      input: expect.any(String),
    });
    expect(request).toEqual({ specJson, theme: "dark", format: "png", pixelRatio: 2 });
    expect(request.textMode).toBeUndefined();
    expect(rendered.bytes).toEqual([...pngBytes]);
    expect(rendered.svg).toBe(svg);
    expect(rendered.width).toBe(40);
    expect(rendered.height).toBe(20);
    expect(rendered.receipt.conversion).toEqual({ format: "png", theme: "dark", pixelRatio: 2 });
  });
});

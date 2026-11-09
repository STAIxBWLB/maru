// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderEngineArtifactForTest } from "./engineArtifactForTest";

const receipt = {
  schemaVersion: 1,
  inputSpecSha256: "a".repeat(64),
  engine: { id: "maru-diagram-engine", version: "1", revision: "r" },
  gates: {
    schema: { status: "passed", scope: "architecture-document-validity" },
    artifact: { status: "passed", scope: "independent-svg-artifact" },
    browser: { status: "not-run", scope: "non-browser-rasterization" },
    visualReview: { status: "not-run", scope: "manual" },
  },
};
const baseReport = {
  apiVersion: 1,
  ok: true,
  bytes: [60, 115, 118, 103, 47, 62],
  svg: "<svg/>",
  width: 10,
  height: 20,
  diagnostics: [],
  receipt,
};

afterEach(() => vi.unstubAllEnvs());

describe("test-only Rust artifact adapter", () => {
  it("sends source, theme, format, pixel ratio, and pins through the high-level ABI", async () => {
    vi.stubEnv("VITE_ENGINE_GEOMETRY_TEST", "1");
    const host = vi.fn(async (input: string) => {
      expect(typeof input).toBe("string");
      return JSON.stringify(baseReport);
    });
    const result = await renderEngineArtifactForTest({
      specJson: "{\"diagram_type\":\"architecture\"}",
      theme: "dark",
      format: "svg",
      pinSet: { sourceSpecSha256: "a".repeat(64), pins: [] },
    }, host);
    const request = JSON.parse(host.mock.calls[0]![0] as string);
    expect(request).toEqual({
      specJson: "{\"diagram_type\":\"architecture\"}",
      theme: "dark",
      format: "svg",
      pixelRatio: 1,
      pinSet: { sourceSpecSha256: "a".repeat(64), pins: [] },
    });
    expect(result.bytes).toEqual(baseReport.bytes);
  });

  it("keeps refused reports without inventing bytes and rejects forged byte values", async () => {
    vi.stubEnv("VITE_ENGINE_GEOMETRY_TEST", "1");
    const refused = { ...baseReport, ok: false, bytes: null, svg: null, width: null, height: null };
    await expect(renderEngineArtifactForTest({ specJson: "{}", theme: "light", format: "svg" }, async () => refused))
      .resolves.toMatchObject({ ok: false, bytes: null, svg: null });
    await expect(renderEngineArtifactForTest({ specJson: "{}", theme: "light", format: "svg" }, async () => ({ ...baseReport, bytes: [256] })))
      .rejects.toThrow(/invalid byte values/i);
  });

  it("requires vector pixel ratio one and remains disabled outside the geometry test build", async () => {
    vi.stubEnv("VITE_ENGINE_GEOMETRY_TEST", "1");
    await expect(renderEngineArtifactForTest({ specJson: "{}", theme: "light", format: "svg", pixelRatio: 2 }, async () => baseReport))
      .rejects.toThrow(/pixelRatio 1/i);
    vi.stubEnv("VITE_ENGINE_GEOMETRY_TEST", "0");
    await expect(renderEngineArtifactForTest({ specJson: "{}", theme: "light", format: "svg" }, async () => baseReport))
      .rejects.toThrow(/disabled/i);
  });
});

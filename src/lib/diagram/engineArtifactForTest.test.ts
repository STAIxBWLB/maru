// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EngineArtifactTransportError,
  prepareEngineArtifactForTest,
  renderEngineArtifactForTest,
} from "./engineArtifactForTest";

const { pluginInvoke } = vi.hoisted(() => ({ pluginInvoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: pluginInvoke }));

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

beforeEach(() => pluginInvoke.mockReset());
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

  it("dispatches PNG through the registered Tauri command and serializes the high-level request", async () => {
    vi.stubEnv("VITE_ENGINE_GEOMETRY_TEST", "1");
    pluginInvoke.mockResolvedValue(baseReport);
    const request = { specJson: "{\"diagram_type\":\"architecture\"}", theme: "dark" as const, format: "png" as const, pixelRatio: 2 };
    const report = await renderEngineArtifactForTest(request);
    expect(report).toMatchObject({ ok: true, bytes: baseReport.bytes });
    expect(pluginInvoke).toHaveBeenCalledWith("plugin:maru-diagram|render_png", {
      input: JSON.stringify({ ...request, pinSet: undefined }),
    });

    pluginInvoke.mockClear();
    const prepared = await prepareEngineArtifactForTest("png");
    await prepared(JSON.stringify(request));
    expect(pluginInvoke).toHaveBeenCalledWith("plugin:maru-diagram|render_png", { input: JSON.stringify(request) });
  });

  it("keeps the Tauri host disabled when the test flag is off", async () => {
    vi.stubEnv("VITE_ENGINE_GEOMETRY_TEST", "0");
    await expect(renderEngineArtifactForTest({ specJson: "{}", theme: "light", format: "png" }))
      .rejects.toThrow(/disabled/i);
    await expect(prepareEngineArtifactForTest("png")).rejects.toThrow(/disabled/i);
    expect(pluginInvoke).not.toHaveBeenCalled();
  });

  it("preserves structured native IPC errors and diagnostics", async () => {
    vi.stubEnv("VITE_ENGINE_GEOMETRY_TEST", "1");
    const diagnostic = {
      code: "layout/input-type",
      path: "/components/0/type",
      rule: "architecture/type",
      message: "The component type is unsupported.",
      fix: "Choose a supported component type and retry.",
    };
    pluginInvoke.mockRejectedValue({
      code: "diagram_render_refused",
      message: "The Rust renderer refused the request.",
      nextStep: "Correct the source and retry.",
      diagnostics: [diagnostic],
    });
    await expect(renderEngineArtifactForTest({ specJson: "{}", theme: "light", format: "png" }))
      .rejects.toMatchObject({
        name: "EngineArtifactTransportError",
        code: "diagram_render_refused",
        nextStep: "Correct the source and retry.",
        diagnostics: [diagnostic],
      } satisfies Partial<EngineArtifactTransportError>);
    await expect(renderEngineArtifactForTest({ specJson: "{}", theme: "light", format: "png" }))
      .rejects.toThrow(/The Rust renderer refused the request.*The component type is unsupported.*Choose a supported component type.*Correct the source/);
  });

  it("keeps native transport causes actionable and refuses malformed diagnostics", async () => {
    vi.stubEnv("VITE_ENGINE_GEOMETRY_TEST", "1");
    pluginInvoke.mockRejectedValue("command not allowed");
    await expect(renderEngineArtifactForTest({ specJson: "{}", theme: "light", format: "png" }))
      .rejects.toThrow(/command not allowed.*native-e2e.*PNG plugin permission/);
    pluginInvoke.mockRejectedValue({ code: "refused", message: "bad scene", nextStep: "repair scene", diagnostics: [{}] });
    await expect(renderEngineArtifactForTest({ specJson: "{}", theme: "light", format: "png" }))
      .rejects.toThrow(/malformed diagnostics.*rebuild matching plugin bindings/);
  });

  it("returns structured source refusal diagnostics with no artifact bytes", async () => {
    vi.stubEnv("VITE_ENGINE_GEOMETRY_TEST", "1");
    const refused = {
      ...baseReport,
      ok: false,
      bytes: null,
      svg: null,
      width: null,
      height: null,
      diagnostics: [{ code: "layout/refused", path: "/", rule: "layout", message: "Layout was refused.", fix: "Repair the source." }],
    };
    pluginInvoke.mockResolvedValue(refused);
    const report = await renderEngineArtifactForTest({ specJson: "{}", theme: "light", format: "png" });
    expect(report).toMatchObject({ ok: false, bytes: null, svg: null, diagnostics: refused.diagnostics });
  });
});

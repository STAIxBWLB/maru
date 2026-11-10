// Verifies semantic apply/undo and SVG/PNG export through the real native app
// and saved-file byte-readback bridge. This is native-e2e evidence, not release proof.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {} from "webdriverio";
import type { EngineReceipt } from "../../src-tauri/crates/maru-diagram-engine/bindings/engine";

import { fixtureRootDir } from "../helpers/fixtureWorkspace";

interface DiagramStaticExportResult {
  svgPath: "diagrams/native-static-export.svg";
  pngPath: "diagrams/native-static-export.png";
  svgReceipt: EngineReceipt;
  pngReceipt: EngineReceipt;
  svgEngineSource: string;
  pngEngineSource: string;
  svgTextMode: "text" | "outlines";
  pngTextMode: "text" | "outlines";
  applyProbe: {
    refused: boolean;
    unchangedAfterRefusal: boolean;
    historyAfterRefusal: number;
    refusalKeys: string[];
    applied: boolean;
    historyAfterApply: number;
    undoRestoredDocument: boolean;
  };
}

interface BridgeFixtureApi {
  readAppState(): { booting: boolean; settingsLoaded: boolean; workspacePath: string | null } | null;
  diagramStaticExportFixture?: () => Promise<DiagramStaticExportResult>;
}

type ExportRunState =
  | { status: "pending" }
  | { status: "complete"; result: DiagramStaticExportResult }
  | { status: "failed"; error: string };

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function waitForNativeExportBridge(): Promise<void> {
  await browser.waitUntil(async () => browser.execute(() => {
    const bridge = (window as unknown as { __MARU_NATIVE_E2E__?: BridgeFixtureApi }).__MARU_NATIVE_E2E__;
    const state = bridge?.readAppState();
    const workspace = state?.workspacePath?.replace(/\\/g, "/").replace(/\/+$/, "") ?? "";
    return Boolean(
      state?.booting === false && state.settingsLoaded === true
      && /(?:^|\/)maru-native-e2e-[^/]+\/workspace$/.test(workspace)
      && typeof bridge?.diagramStaticExportFixture === "function",
    );
  }), {
    timeout: 30_000,
    interval: 250,
    timeoutMsg: "Native export bridge or isolated fixture workspace is unavailable; rebuild with pnpm build:frontend:native-e2e and rerun make test-e2e-native",
  });
}

async function runNativeExportFixture(): Promise<DiagramStaticExportResult> {
  const started = await browser.execute(() => {
    const target = window as unknown as {
      __MARU_DIAGRAM_STATIC_EXPORT_RESULT__?: ExportRunState;
      __MARU_NATIVE_E2E__?: BridgeFixtureApi;
    };
    const fixture = target.__MARU_NATIVE_E2E__?.diagramStaticExportFixture;
    if (typeof fixture !== "function") return false;
    target.__MARU_DIAGRAM_STATIC_EXPORT_RESULT__ = { status: "pending" };
    void fixture().then(
      (result) => { target.__MARU_DIAGRAM_STATIC_EXPORT_RESULT__ = { status: "complete", result }; },
      (error) => { target.__MARU_DIAGRAM_STATIC_EXPORT_RESULT__ = { status: "failed", error: String(error) }; },
    );
    return true;
  });
  assert.equal(started, true, "Native export fixture method is missing; rebuild with pnpm build:frontend:native-e2e and rerun make test-e2e-native");

  await browser.waitUntil(async () => browser.execute(() => {
    const state = (window as unknown as {
      __MARU_DIAGRAM_STATIC_EXPORT_RESULT__?: ExportRunState;
    }).__MARU_DIAGRAM_STATIC_EXPORT_RESULT__;
    return state?.status === "complete" || state?.status === "failed";
  }), {
    timeout: 90_000,
    interval: 250,
    timeoutMsg: "Native SVG/PNG export exceeded 90 seconds; inspect the engine renderer logs and rerun make test-e2e-native",
  });
  const state = await browser.execute(() => (window as unknown as {
    __MARU_DIAGRAM_STATIC_EXPORT_RESULT__?: ExportRunState;
  }).__MARU_DIAGRAM_STATIC_EXPORT_RESULT__ ?? null);
  assert.ok(state, "Native export result is missing; inspect the renderer logs and rerun make test-e2e-native");
  if (state.status !== "complete") {
    assert.fail(state.status === "failed" ? state.error : "native export is still pending; inspect the engine and rerun the native export spec");
  }
  assert.equal(state.status, "complete");
  return state.result;
}

describe("native diagram engine apply and export", () => {
  it("refuses an invalid edit, restores an accepted edit with undo, and writes verified SVG and PNG", async () => {
    await waitForNativeExportBridge();
    const result = await runNativeExportFixture();
    assert.equal(result.svgPath, "diagrams/native-static-export.svg");
    assert.equal(result.pngPath, "diagrams/native-static-export.png");

    const workspace = path.join(fixtureRootDir(), "workspace");
    const svgBytes = new Uint8Array(await fs.readFile(path.join(workspace, result.svgPath)));
    const pngBytes = new Uint8Array(await fs.readFile(path.join(workspace, result.pngPath)));
    const svg = new TextDecoder("utf-8", { fatal: true }).decode(svgBytes);
    assert.equal(sha256(svgBytes), result.svgReceipt.outputSha256, "saved SVG bytes must match the final receipt hash");
    assert.equal(sha256(pngBytes), result.pngReceipt.outputSha256, "saved PNG bytes must match the final receipt hash");
    for (const receipt of [result.svgReceipt, result.pngReceipt]) {
      assert.equal(receipt.schemaVersion, 1);
      assert.equal(receipt.engine.id, "maru-diagram-engine");
      assert.ok(receipt.engine.version.length > 0);
      assert.ok(receipt.engine.revision.length > 0);
      assert.match(receipt.inputSpecSha256, /^[0-9a-f]{64}$/);
      assert.equal(receipt.gates.schema.status, "passed");
      assert.equal(receipt.gates.artifact.status, "passed");
      assert.equal(receipt.gates.browser.status, "not-run");
      assert.equal(receipt.gates.visualReview.status, "not-run");
      assert.equal(receipt.readback?.status, "passed", "readback is passed only after the native bridge verifies saved bytes");
      assert.equal(receipt.readback?.scope, "native-saved-file-byte-comparison");
      assert.match(receipt.engineOutputSha256 ?? "", /^[0-9a-f]{64}$/);
      assert.match(receipt.outputSha256 ?? "", /^[0-9a-f]{64}$/);
    }
    assert.equal(result.svgTextMode, "outlines");
    assert.equal(result.pngTextMode, "text");
    assert.equal(result.svgEngineSource, svg, "saved SVG must be the engine source SVG for the outlined receipt");
    assert.match(result.svgEngineSource, /data-theme="light"/);
    assert.equal(
      sha256(new TextEncoder().encode(result.svgEngineSource)),
      result.svgReceipt.engineOutputSha256,
      "outlined SVG receipt must bind its returned intermediate SVG source",
    );
    assert.equal(
      sha256(new TextEncoder().encode(result.pngEngineSource)),
      result.pngReceipt.engineOutputSha256,
      "PNG receipt must bind its own text-mode intermediate SVG source",
    );
    assert.notEqual(result.pngEngineSource, result.svgEngineSource, "dark PNG source is independently rendered in text mode");
    assert.doesNotMatch(result.svgEngineSource, /<text(?:\s|>)/i);
    assert.match(result.pngEngineSource, /<text(?:\s|>)/i, "PNG rasterization source retains text-mode label elements");
    assert.match(result.pngEngineSource, /data-theme="dark"/);
    assert.ok(result.pngEngineSource.includes("한日中"), "PNG source must contain the same semantic CJK label before rasterization");
    assert.equal(result.svgReceipt.outputMimeType, "image/svg+xml");
    assert.equal(result.svgReceipt.conversion?.format, "svg");
    assert.equal(result.svgReceipt.conversion?.theme, "light");
    assert.equal(result.pngReceipt.outputMimeType, "image/png");
    assert.equal(result.pngReceipt.conversion?.format, "png");
    assert.equal(result.pngReceipt.conversion?.theme, "dark");

    assert.equal(result.applyProbe.refused, true, "engine refusal must prevent semantic apply");
    assert.equal(result.applyProbe.unchangedAfterRefusal, true, "refused candidate must leave the source document unchanged");
    assert.equal(result.applyProbe.historyAfterRefusal, 0, "refused candidate must not create a history entry");
    assert.ok(result.applyProbe.refusalKeys.includes("diagram.semantic.engineRejected"));
    assert.equal(result.applyProbe.applied, true, "engine-approved edit must apply");
    assert.equal(result.applyProbe.historyAfterApply, 1, "approved edit must create one undo step");
    assert.equal(result.applyProbe.undoRestoredDocument, true, "undo must restore the exact source document");

    assert.match(svg, /<svg\b/);
    assert.match(svg, /role="img"/);
    assert.ok(svg.includes("한日中"), "CJK semantic label must survive conversion");
    assert.doesNotMatch(svg, /<text(?:\s|>)|<script\b|<foreignObject\b|\son[a-z]+\s*=|file:|\/Users\/|\/home\//i);
    assert.ok(svgBytes.length > 100 && svgBytes.length < 8 * 1024 * 1024, `unexpected SVG size ${svgBytes.length}`);

    const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(Buffer.from(pngBytes.subarray(0, 8)).equals(pngSignature), "saved fallback must have a PNG signature");
    assert.ok(pngBytes.length > 100 && pngBytes.length < 8 * 1024 * 1024, `unexpected PNG size ${pngBytes.length}`);
    assert.ok(pngBytes.length >= 24, "PNG is long enough to include its IHDR dimensions");
    const width = Buffer.from(pngBytes).readUInt32BE(16);
    const height = Buffer.from(pngBytes).readUInt32BE(20);
    assert.ok(width > 0 && height > 0, `PNG has invalid dimensions ${width}x${height}`);
    assert.ok(width <= 8192 && height <= 8192, `PNG dimensions are unexpectedly large ${width}x${height}`);
    console.log(`NATIVE_DIAGRAM_ENGINE_ARTIFACTS ${JSON.stringify({
      svg: { engine: result.svgReceipt.engine, engineOutputSha256: result.svgReceipt.engineOutputSha256, outputSha256: result.svgReceipt.outputSha256, textMode: result.svgTextMode },
      png: { engine: result.pngReceipt.engine, engineOutputSha256: result.pngReceipt.engineOutputSha256, outputSha256: result.pngReceipt.outputSha256, textMode: result.pngTextMode },
      engineSources: {
        svgSha256: sha256(new TextEncoder().encode(result.svgEngineSource)),
        pngSha256: sha256(new TextEncoder().encode(result.pngEngineSource)),
      },
      applyProbe: result.applyProbe,
    })}`);
  }).timeout(120_000);
});

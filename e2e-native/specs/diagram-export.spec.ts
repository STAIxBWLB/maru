// Verifies static semantic SVG/PNG export through the real native app and
// saved-file byte-readback bridge. This proves the custom-protocol native-e2e
// build and current pinned engine, not a shipped release bundle.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {} from "webdriverio";

import { fixtureRootDir } from "../helpers/fixtureWorkspace";

interface ExportGate {
  status: "passed" | "not-run";
  scope: string;
}

interface ExportReceipt {
  schemaVersion: number;
  inputSpecSha256: string;
  enginePin: { name: string; version: string; revision: string };
  outputSha256: string;
  outputMimeType: string;
  conversion?: { format: "svg" | "png"; theme: "light" | "dark"; pixelRatio: 1 };
  gates: {
    schema: ExportGate;
    artifact: ExportGate;
    browser: ExportGate;
    visualReview: ExportGate;
  };
  readback?: ExportGate;
}

interface DiagramStaticExportResult {
  svgPath: "diagrams/native-static-export.svg";
  pngPath: "diagrams/native-static-export.png";
  svgReceipt: ExportReceipt;
  pngReceipt: ExportReceipt;
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
    timeoutMsg: "Native SVG/PNG export exceeded 90 seconds; inspect the Archify renderer logs and rerun make test-e2e-native",
  });
  const state = await browser.execute(() => (window as unknown as {
    __MARU_DIAGRAM_STATIC_EXPORT_RESULT__?: ExportRunState;
  }).__MARU_DIAGRAM_STATIC_EXPORT_RESULT__ ?? null);
  assert.ok(state, "Native export result is missing; inspect the renderer logs and rerun make test-e2e-native");
  if (state.status !== "complete") {
    assert.fail(state.status === "failed" ? state.error : "native export is still pending; inspect the renderer and rerun the native export spec");
  }
  assert.equal(state.status, "complete");
  return state.result;
}

describe("native verified semantic export", () => {
  it("writes receipt-bound SVG and PNG through the native save bridge", async () => {
    await waitForNativeExportBridge();
    const result = await runNativeExportFixture();
    assert.equal(result.svgPath, "diagrams/native-static-export.svg");
    assert.equal(result.pngPath, "diagrams/native-static-export.png");

    const workspace = path.join(fixtureRootDir(), "workspace");
    const svgBytes = new Uint8Array(await fs.readFile(path.join(workspace, result.svgPath)));
    const pngBytes = new Uint8Array(await fs.readFile(path.join(workspace, result.pngPath)));
    const svg = new TextDecoder("utf-8", { fatal: true }).decode(svgBytes);
    const pin = JSON.parse(await fs.readFile(new URL("../../sidecars/archify/PIN.json", import.meta.url), "utf8")) as {
      name: string;
      version: string;
      revision: string;
    };

    assert.equal(sha256(svgBytes), result.svgReceipt.outputSha256, "saved SVG bytes must match the final receipt hash");
    assert.equal(sha256(pngBytes), result.pngReceipt.outputSha256, "saved PNG bytes must match the final receipt hash");
    for (const receipt of [result.svgReceipt, result.pngReceipt]) {
      assert.equal(receipt.schemaVersion, 1);
      assert.equal(receipt.enginePin.name, pin.name);
      assert.equal(receipt.enginePin.version, pin.version);
      assert.equal(receipt.enginePin.revision, pin.revision);
      assert.match(receipt.inputSpecSha256, /^[0-9a-f]{64}$/);
      assert.equal(receipt.gates.schema.status, "passed");
      assert.equal(receipt.gates.artifact.status, "passed");
      assert.equal(receipt.gates.browser.status, "passed");
      assert.equal(receipt.gates.visualReview.status, "not-run");
      assert.equal(receipt.readback?.status, "passed", "readback is passed only after the native bridge verifies saved bytes");
      assert.equal(receipt.readback?.scope, "native-saved-file-byte-comparison");
    }
    assert.equal(result.svgReceipt.outputMimeType, "image/svg+xml");
    assert.equal(result.svgReceipt.conversion?.format, "svg");
    assert.equal(result.svgReceipt.conversion?.theme, "light");
    assert.equal(result.pngReceipt.outputMimeType, "image/png");
    assert.equal(result.pngReceipt.conversion?.format, "png");
    assert.equal(result.pngReceipt.conversion?.theme, "dark");

    assert.match(svg, /<svg\b/);
    assert.match(svg, /role="img"/);
    assert.ok(svg.includes("한日中"), "CJK semantic label must survive conversion");
    assert.doesNotMatch(svg, /<script\b|<foreignObject\b|\son[a-z]+\s*=|file:|\/Users\/|\/home\//i);
    assert.ok(svgBytes.length > 100 && svgBytes.length < 8 * 1024 * 1024, `unexpected SVG size ${svgBytes.length}`);

    const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    assert.ok(Buffer.from(pngBytes.subarray(0, 8)).equals(pngSignature), "saved fallback must have a PNG signature");
    assert.ok(pngBytes.length > 100 && pngBytes.length < 8 * 1024 * 1024, `unexpected PNG size ${pngBytes.length}`);
    assert.ok(pngBytes.length >= 24, "PNG is long enough to include its IHDR dimensions");
    const width = Buffer.from(pngBytes).readUInt32BE(16);
    const height = Buffer.from(pngBytes).readUInt32BE(20);
    assert.ok(width > 0 && height > 0, `PNG has invalid dimensions ${width}x${height}`);
    assert.ok(width <= 8192 && height <= 8192, `PNG dimensions are unexpectedly large ${width}x${height}`);
  }).timeout(120_000);
});

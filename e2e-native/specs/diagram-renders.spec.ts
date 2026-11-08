// Real WKWebView asset viewer proof; Chromium cannot establish native IPC or
// asset-protocol isolation. Ported from the retired architecture gallery probe.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {} from "webdriverio";
import { fixtureRootDir } from "../helpers/fixtureWorkspace";

interface Probe { source: "diagram-render-probe"; theme: string | null; ipc: string; parent: string }
const HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Render probe</title></head><body><script>
let parentAccess; try { parentAccess = String(window.parent.document.title); } catch { parentAccess = "blocked"; }
window.parent.postMessage({source:"diagram-render-probe",theme:new URLSearchParams(location.search).get("theme"),ipc:typeof window.__TAURI_INTERNALS__,parent:parentAccess},"*");
</script></body></html>`;
async function probes(): Promise<Probe[]> {
  return browser.execute(() => (window as unknown as { __renderProbes?: Probe[] }).__renderProbes ?? []);
}
async function waitProbe(count: number): Promise<Probe> {
  await browser.waitUntil(async () => (await probes()).length >= count, {
    timeout: 30_000, timeoutMsg: "Saved render did not send its sandbox probe; inspect diagram_prepare_render_view and rerun make test-e2e-native",
  });
  return (await probes())[count - 1];
}

async function currentFrame(markPrevious = false) {
  // Read fresh DOM properties together; WebDriver element IDs do not survive
  // React's theme remount. The old DOM reference is used only to prove removal.
  return browser.execute((mark) => {
    const frame = document.querySelector<HTMLIFrameElement>('[data-testid="diagram-render-frame"]');
    if (!frame) return null;
    const target = window as unknown as { __previousRenderFrame?: HTMLIFrameElement };
    const previous = target.__previousRenderFrame;
    const state = { sandbox: frame.getAttribute("sandbox"), referrer: frame.getAttribute("referrerpolicy"), src: frame.src,
      replaced: Boolean(previous && previous !== frame), previousDetached: Boolean(previous && !previous.isConnected) };
    if (mark) target.__previousRenderFrame = frame;
    return state;
  }, markPrevious);
}

describe("native saved Diagram renders", () => {
  it("loads only a verified asset with opaque-origin IPC and parent isolation and theme remount", async () => {
    // As in the retired gallery spec: explicitly select the current main
    // window to avoid the service's unsupported global-Tauri focus probes.
    await browser.switchToWindow(await browser.getWindowHandle());
    const workspace = path.join(fixtureRootDir(), "workspace");
    const folder = path.join(workspace, "attachments/diagrams/native-render-doc/renders/0123456789abcdef0123456789abcdef");
    await fs.mkdir(folder, { recursive: true });
    await fs.mkdir(path.join(workspace, "diagrams"), { recursive: true });
    const source = JSON.stringify({ v: 9, id: "native-render-doc", docTitle: "Native render", createdAt: 1, updatedAt: 1, nodes: [], edges: [], layers: [] });
    await fs.writeFile(path.join(workspace, "diagrams/native-render.cmd.json"), source);
    await fs.writeFile(path.join(folder, "index.html"), HTML);
    await fs.writeFile(path.join(folder, "neighbor.html"), "Never granted");
    const pin = JSON.parse(await fs.readFile(new URL("../../sidecars/archify/PIN.json", import.meta.url), "utf8")) as { name: string; version: string; revision: string };
    const hash = (body: string) => createHash("sha256").update(body).digest("hex");
    await fs.writeFile(path.join(folder, "receipt.json"), JSON.stringify({
      schemaVersion: 1, docId: "native-render-doc", documentName: "native-render", documentRevision: hash(source), diagramType: "architecture", renderedAt: "2026-11-08T00:00:00Z",
      inputSpecSha256: hash("copied fixture spec"), outputSha256: hash(HTML), outputMimeType: "text/html", enginePin: pin,
      gates: { schema: { status: "passed", scope: "pinned-engine-validation" }, artifact: { status: "passed", scope: "pinned-engine-rendered-html" }, browser: { status: "not-run", scope: "none" }, visualReview: { status: "not-run", scope: "manual" } },
    }));
    await browser.execute(() => {
      const target = window as unknown as { __renderProbes?: Probe[] };
      target.__renderProbes = [];
      window.addEventListener("message", (event) => {
        if ((event.data as { source?: string } | null)?.source === "diagram-render-probe") target.__renderProbes!.push(event.data);
      });
    });
    const rail = await browser.$('.activity-rail button[aria-label="다이어그램"]');
    await rail.waitForDisplayed({ timeout: 30_000 }); await (await browser.$('.activity-rail button[aria-label="다이어그램"]')).click();
    await (await browser.$('[role="tab"]*=파일')).click();
    await (await browser.$('button*=렌더')).click();
    const entry = await browser.$('[data-testid="diagram-render-entry"]');
    await entry.waitForDisplayed({ timeout: 30_000 }); await (await browser.$('[data-testid="diagram-render-entry"]')).click();
    const first = await waitProbe(1);
    const theme = await browser.execute(() => document.documentElement.dataset.theme ?? "light");
    assert.equal(first.theme, theme, "Render theme differs from the app; inspect the viewer theme query and rerun the spec");
    assert.equal(first.ipc, "undefined", "Render can reach native IPC; keep the opaque-origin sandbox and inspect Tauri initialization");
    assert.equal(first.parent, "blocked", "Render can reach the app document; restore the sandbox without allow-same-origin");
    const frame = await currentFrame(true);
    assert.ok(frame, "Prepared viewer is missing; inspect prepare-render diagnostics and rerun the spec");
    assert.equal(frame.sandbox, "allow-scripts allow-downloads allow-popups allow-popups-to-escape-sandbox", "Viewer sandbox changed; restore the reviewed flags without allow-same-origin");
    assert.equal(frame.referrer, "no-referrer", "Viewer leaks referrers; restore referrerPolicy=no-referrer");
    const denied = await browser.execute(async (file) => {
      const internals = (window as unknown as { __TAURI_INTERNALS__?: { convertFileSrc: (file: string, protocol?: string) => string } }).__TAURI_INTERNALS__;
      if (!internals) return false;
      try { const response = await fetch(internals.convertFileSrc(file, "asset")); return !response.ok; } catch { return true; }
    }, path.join(folder, "neighbor.html"));
    assert.equal(denied, true, "A neighboring file was granted; prepare must allow only the receipt-verified artifact");
    const nextTheme = theme === "dark" ? "light" : "dark";
    await browser.execute((value) => { document.documentElement.dataset.themePreference = value; document.documentElement.dataset.theme = value; }, nextTheme);
    const next = await waitProbe(2);
    assert.equal(next.theme, nextTheme, "Theme change did not remount the render; inspect the iframe key and theme query");
    assert.equal(next.ipc, "undefined"); assert.equal(next.parent, "blocked");
    const replacement = await currentFrame();
    assert.ok(replacement?.replaced && replacement.previousDetached, "Theme did not replace the old iframe; inspect the key and recheck after its new probe");
    assert.ok(replacement.src.includes(`theme=${nextTheme}`), "Current frame has a stale theme; inspect the theme query and rerun the spec");
    assert.equal(replacement.referrer, "no-referrer");
    assert.equal(replacement.sandbox, frame.sandbox, "Theme replacement changed sandbox flags; restore the reviewed viewer contract");
  }).timeout(120_000);
});

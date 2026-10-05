// #410 real-WKWebView check for the 설계도 mode: a listed blueprint loads in an
// asset-origin iframe, its inline scripts run (the app CSP does not reach
// it), `?theme=` arrives and follows a live toggle, and the frame can reach
// neither the app document nor Tauri IPC. Chromium e2e cannot prove any of it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {} from "webdriverio";

import { fixtureRootDir } from "../helpers/fixtureWorkspace";

interface Probe {
  theme: string | null;
  ipc: string;
  parent: string;
}

const PROBE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Probe</title></head><body>
<script>
  var parentAccess;
  try { parentAccess = String(window.parent.document.title); } catch (_) { parentAccess = "blocked"; }
  window.parent.postMessage({
    source: "architecture-probe",
    theme: new URLSearchParams(location.search).get("theme"),
    ipc: typeof window.__TAURI_INTERNALS__,
    parent: parentAccess
  }, "*");
</script>
</body></html>
`;

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-c", "user.name=Native Fixture", "-c", "user.email=fixture@example.invalid", "-c", "protocol.file.allow=always", ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

const workspace = () => path.join(fixtureRootDir(), "workspace");

async function probes(): Promise<Probe[]> {
  return browser.execute(() => (window as unknown as { __architectureProbes?: Probe[] }).__architectureProbes ?? []);
}

async function waitForProbe(count: number): Promise<Probe> {
  await browser.waitUntil(async () => (await probes()).length >= count, {
    timeout: 30_000,
    timeoutMsg: `expected blueprint probe message #${count}`,
  });
  return (await probes())[count - 1];
}

async function logHandoffDiagnostics(stage: string): Promise<void> {
  const dom = await browser.execute(() => {
    const copy = document.querySelector<HTMLButtonElement>('[data-testid="architecture-copy-to-diagram"]');
    return {
      diagramFlag: window.localStorage.getItem("maru:diagram:enabled"),
      mode: {
        diagram: Boolean(document.querySelector(".diagram-mode")),
        architecture: Boolean(document.querySelector(".architecture-pane")),
        mainClass: document.querySelector("main")?.className ?? null,
      },
      rail: Array.from(document.querySelectorAll(".activity-rail .activity-button"))
        .map((button) => ({ label: button.getAttribute("aria-label"), selected: button.classList.contains("active") })),
      copyButton: copy ? { disabled: copy.disabled, outerHTML: copy.outerHTML.slice(0, 1000) } : null,
      iframeSrc: document.querySelector<HTMLIFrameElement>(".architecture-frame")?.src ?? null,
      documentPathLabels: Array.from(document.querySelectorAll('[data-tree-target-path], .doc-tab[title], [role="tab"][title]'))
        .slice(0, 5).map((item) => item.getAttribute("data-tree-target-path") ?? item.getAttribute("title")),
      nodeCount: document.querySelectorAll(".maru-diagram-node").length,
      alerts: Array.from(document.querySelectorAll('[role="alert"]'))
        .slice(0, 5).map((alert) => (alert.textContent ?? "").slice(0, 400)),
      bodyText: (document.body.textContent ?? "").slice(0, 1600),
    };
  }).catch((diagnosticError: unknown) => ({ diagnosticError: String(diagnosticError) }));
  const files = await fs.readdir(path.join(workspace(), "diagrams"))
    .catch((diagnosticError: unknown) => ({ diagnosticError: String(diagnosticError) }));
  console.error("native_architecture_handoff_diagnostics", JSON.stringify({ stage, dom, files }));
}

describe("native 설계도 mode", () => {
  // Seeded once for this file's single test: wdio's beforeTest reset wipes
  // the workspace from the second test on, so a new test must seed again.
  before(async () => {
    const source = path.join(fixtureRootDir(), "blueprint-src");
    await fs.mkdir(path.join(source, "docs", "architecture"), { recursive: true });
    await fs.writeFile(path.join(source, "docs", "architecture", "probe-rendered.html"), PROBE_HTML);
    await fs.writeFile(
      path.join(source, "docs", "architecture", "probe.architecture.json"),
      JSON.stringify({
        schema_version: 1,
        diagram_type: "architecture",
        meta: { title: "Probe Blueprint", output: "probe.html" },
        components: [{ id: "app", type: "backend", label: "한글 서버" }],
      }),
    );
    git(source, ["init", "-q"]);
    git(source, ["add", "."]);
    git(source, ["commit", "-qm", "probe"]);
    git(workspace(), ["init", "-q"]);
    git(workspace(), ["submodule", "add", "-q", source, "dev/probe"]);
  });

  after(async () => {
    for (const entry of [".git", ".gitmodules", "dev"]) {
      await fs.rm(path.join(workspace(), entry), { recursive: true, force: true });
    }
  });

  it("runs the viewer sandboxed, themed, and cut off from the app", async () => {
    // Explicit standard WebDriver selection tells the service which window
    // to keep, without its unsupported global-Tauri focus-state probes.
    await browser.switchToWindow(await browser.getWindowHandle());
    await browser.execute(() => {
      const w = window as unknown as { __architectureProbes?: unknown[] };
      w.__architectureProbes = [];
      window.addEventListener("message", (event) => {
        if ((event.data as { source?: string } | null)?.source === "architecture-probe") {
          w.__architectureProbes!.push(event.data);
        }
      });
    });
    const appUrl = await browser.getUrl();

    const button = await browser.$('.activity-rail button[aria-label="설계도"]');
    await button.waitForDisplayed({ timeout: 30_000 });
    await button.click();
    const item = await browser.$(".architecture-item");
    await item.waitForDisplayed({ timeout: 30_000 });
    assert.match(await item.getText(), /Probe Blueprint/);

    const theme = await browser.execute(() => document.documentElement.dataset.theme ?? "light");
    const first = await waitForProbe(1);
    assert.equal(first.theme, theme, "the viewer must receive the app theme");
    assert.equal(first.ipc, "undefined", "the frame must not see Tauri internals");
    assert.equal(first.parent, "blocked", "the frame must not read the app document");

    const toggled = theme === "dark" ? "light" : "dark";
    await browser.execute((next: string) => {
      document.documentElement.dataset.theme = next;
    }, toggled);
    const second = await waitForProbe(2);
    assert.equal(second.theme, toggled, "a live theme toggle must reload the viewer");
    await browser.execute((previous: string) => {
      document.documentElement.dataset.theme = previous;
    }, theme);

    assert.equal(await browser.getUrl(), appUrl, "the app webview must stay on the app");

    // The Diagram surface has never mounted in this session: this exercises
    // the lazy handoff, real guarded schema validation and create-only save.
    const sourceSpec = path.join(workspace(), "dev/probe/docs/architecture/probe.architecture.json");
    const sourceBefore = await fs.readFile(sourceSpec, "utf8");
    const copy = await browser.$('[data-testid="architecture-copy-to-diagram"]');
    await copy.waitForDisplayed({ timeout: 30_000 });
    await copy.click();
    await logHandoffDiagnostics("immediate");
    try {
      await browser.waitUntil(async () => (await browser.$$(".maru-diagram-node").length) === 1, {
        timeout: 30_000, timeoutMsg: "cold gallery handoff must open the saved copy",
      });
    } catch (error) {
      await logHandoffDiagnostics("wait-failed");
      throw error;
    }
    assert.match(await (await browser.$(".maru-diagram-node")).getText(), /한글 서버/);
    const saved = JSON.parse(await fs.readFile(path.join(workspace(), "diagrams/Probe Blueprint.cmd.json"), "utf8"));
    assert.equal(saved.datasets[0].provenance.origin, "gallery-copy");
    assert.equal(saved.datasets[0].provenance.repository, "dev/probe");
    assert.equal(await fs.readFile(sourceSpec, "utf8"), sourceBefore);
    assert.equal(await fs.readFile(path.join(workspace(), "dev/probe/docs/architecture/probe-rendered.html"), "utf8"), PROBE_HTML);

    const fileTab = await browser.$('[role="tab"][aria-label="파일"]');
    // Existing ribbon tabs expose their visible label instead of aria-label.
    if (await fileTab.isExisting()) await fileTab.click();
    else {
      const tab = await browser.$('[role="tab"]*=파일');
      await tab.click();
    }
    const generate = await browser.$('button=다이어그램 생성');
    await generate.click();
    await (await browser.$('[data-testid="gen-type-select"]')).waitForDisplayed({ timeout: 30_000 });
    const mermaid = await browser.$('[data-testid="gen-mermaid"]');
    await mermaid.setValue("flowchart TD\n A[시작] --> B[종료]");
    await (await browser.$('[data-testid="gen-from-mermaid"]')).click();
    await (await browser.$('[data-testid="gen-mermaid-preview"]')).waitForDisplayed({ timeout: 30_000 });
    await (await browser.$('[data-testid="gen-mermaid-apply"]')).click();
    await browser.waitUntil(async () => (await browser.$$(".maru-diagram-node").length) === 2, {
      timeout: 30_000, timeoutMsg: "native Mermaid generation must apply two nodes",
    });

  });
});

// maru#563 and #610 real-app check: a .hwpx opens through the HWP engine,
// takes edits in memory and saves only on an explicit host Save. Chromium cannot
// prove any of it: the preview and the editor both spawn the engine over
// native IPC, and snapshot/conflict assertions concern real filesystem bytes.
//
// The engine is a real dependency, so this spec needs `ahwp` (or the 1.x `hwp`
// compatibility name) on the app's PATH: the macOS CI job installs it before
// the suite runs. A missing engine fails the preview assertion with the
// engine's own `cli_missing` sentence in the detail — it is never skipped,
// because a skipped editor check is not evidence that the editor works.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {} from "webdriverio";
import { readHwpxHostState, type HwpxHostState } from "../helpers/hwpxHostState";

import {
  FIXTURE_DOC_NAME,
  FIXTURE_HWPX_NAME,
  fixtureHwpxPath,
  fixtureHwpxSource,
  fixtureRootDir,
} from "../helpers/fixtureWorkspace";

interface StepReport {
  ok: boolean;
  detail?: string;
}

/** What the painted editor reports about its first page, read straight off the
 *  DOM so it can be compared with the page the sanitizer produced. */
interface PaintedPage {
  pages: number;
  paths: number;
  dTotal: number;
  viewBox: string | null;
  width: string | null;
  height: string | null;
  box: [number, number, number, number];
}

interface HwpedProbe {
  version: string;
  pageCount: number;
  rawBytes: number;
  sanitizedBytes: number;
  wrappedIsSanitizerOutput: boolean;
  firstPage: { paths: number; dTotal: number; viewBox: string | null; width: string | null; height: string | null };
  hostile: { script: boolean; handler: boolean; javascriptHref: boolean; externalHref: boolean; dataRaster: boolean };
}

/** One browser-side polling step. Each call polls for `pollMs` inside its own
 *  script budget (WebDriver caps a script at 30s) and the Node side repeats
 *  the call until `timeoutMs`, so a cold engine spawn or a lazy editor chunk
 *  load is waited out rather than retried blindly. Every step below is
 *  idempotent: it reads the DOM first and acts only on the part that is still
 *  missing, so a repeated call cannot double-click or type twice. */
async function step<A>(
  name: string,
  script: (arg: A, pollMs: number, done: (report: StepReport) => void) => void,
  arg: A,
  timeoutMs = 90_000,
): Promise<StepReport> {
  const deadline = Date.now() + timeoutMs;
  let last: StepReport = { ok: false, detail: "never ran" };
  // The runner's typing wraps each script argument in a DOM element transform,
  // which a plain value argument does not satisfy; the runtime contract here is
  // (arg, pollMs, done).
  const execute = browser.executeAsync.bind(browser) as unknown as (
    script: unknown,
    ...args: unknown[]
  ) => Promise<unknown>;
  while (Date.now() < deadline) {
    last = (await execute(script, arg, 15_000)) as StepReport;
    if (last.ok) return last;
  }
  throw new Error(`${name} stalled: ${last.detail ?? "no detail"}`);
}

/** Queues one replace through the editor's own controls: pick the paragraph at
 *  `from` (advancing past any the replace field refuses), type the marker, press
 *  the replace button. Success is the editor's pending list growing, because
 *  pending operations appear before Apply and are separate from unsaved bytes.
 *
 *  The options arrive as the step's argument, never as a closure: the runner
 *  ships this function's source to the webview, so anything it captures from the
 *  module scope is not there. */
function queueOneEdit(
  options: { marker: string; from: number; requireNote: boolean },
  pollMs: number,
  done: (report: StepReport) => void,
): void {
  const { marker, from, requireNote } = options;
  const deadline = Date.now() + pollMs;
  const text = (node: Element | null | undefined) => (node?.textContent ?? "").trim();
  const field = () => document.querySelector<HTMLInputElement>("#hwped-replace");
  const submit = () => {
    const parent = field()?.closest(".hwped-field");
    return [...(parent?.querySelectorAll<HTMLButtonElement>("button") ?? [])]
      .find((button) => /^(교체|Replace)$/.test(text(button)));
  };
  const note = () => document.querySelector(".hwp-editor-pane-note");
  const pending = () => [...document.querySelectorAll(".hwped-pending-list li")];
  // The selected paragraph's text is shown in its own field above the input;
  // the replace op refuses an empty `find`, so an option without text is not a
  // candidate.
  const quoteText = () => text(document.querySelector(".hwped-side .hwped-quote"));
  let optionIndex = from;
  const tick = () => {
    if (pending().length > 0 && (!requireNote || note())) {
      done({ ok: true, detail: `${text(pending()[0])} | ${text(note())}` });
      return;
    }
    const options = [...document.querySelectorAll<HTMLButtonElement>('.hwped-side [role="listbox"] [role="option"]')];
    const input = field();
    const quote = quoteText();
    const option = options[optionIndex];
    if (option && option.getAttribute("aria-selected") !== "true") {
      option.click();
    } else if (!input || input.disabled || quote === "") {
      if (option) optionIndex += 1;
    } else if (input.value !== marker) {
      // A plain assignment reads as unchanged to React's controlled input;
      // the native setter plus an input event is what a keystroke produces.
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, marker);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      const button = submit();
      if (button && !button.disabled) button.click();
    }
    if (Date.now() > deadline) {
      done({
        ok: false,
        detail: JSON.stringify({
          options: options.length,
          selected: options[optionIndex]?.getAttribute("aria-selected") ?? null,
          field: input ? { disabled: input.disabled, value: input.value } : null,
          quote: quote.slice(0, 80),
          submit: text(submit()).slice(0, 40),
          pending: pending().length,
        }),
      });
      return;
    }
    setTimeout(tick, 250);
  };
  tick();
}

/** Applies queued operations in memory. The button only enables while ops are
 *  pending and disables again once the engine returns; persistence is separate. */
function applyQueuedEdits(_arg: null, pollMs: number, done: (report: StepReport) => void): void {
  const deadline = Date.now() + pollMs;
  const text = (node: Element | null | undefined) => (node?.textContent ?? "").trim();
  const root = () => document.querySelector(".hwped-root");
  let clicked = false;
  const tick = () => {
    const failure = document.querySelector(".hwped-root .hwped-error");
    if (failure) {
      done({ ok: false, detail: text(failure) });
      return;
    }
    const apply = document.querySelector<HTMLButtonElement>(".hwped-toolbar .hwped-btn-primary");
    if (!apply) {
      done({ ok: false, detail: "the editor toolbar has no apply button" });
      return;
    }
    const pending = Boolean(document.querySelector(".hwped-pending-list"));
    // A repeated polling slice can begin after the previous slice's click has
    // finished. The applied state, rather than a slice-local click flag, is
    // what makes this step idempotent for an engine call taking over 15s.
    if (!pending && apply.disabled && root()?.getAttribute("data-status") !== "applying") {
      done({ ok: true });
      return;
    }
    if (!clicked && !apply.disabled && pending) {
      apply.click();
      clicked = true;
    }
    if (Date.now() > deadline) {
      done({
        ok: false,
        detail: JSON.stringify({ clicked, pending, disabled: apply.disabled, status: root()?.getAttribute("data-status") ?? null }),
      });
      return;
    }
    setTimeout(tick, 250);
  };
  tick();
}

async function hostState() {
  // A successful WebDriver reply { value: { error: "..." } } is classified as
  // a protocol error by webdriver@9.31.4, even with HTTP 200. This specifically
  // matters when the expected conflict/refusal UI displays an application error.
  return JSON.parse(await browser.execute(readHwpxHostState)) as HwpxHostState;
}

async function clickHost(testId: string): Promise<void> {
  const clicked = await browser.execute((id) => {
    const button = document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
    if (!button || button.disabled) return false;
    button.click();
    return true;
  }, testId);
  assert.equal(clicked, true, `The ${testId} control is missing or disabled; inspect the host status and retry the spec`);
}

async function waitHost(
  description: string,
  predicate: (state: Awaited<ReturnType<typeof hostState>>) => boolean,
): Promise<void> {
  console.info(`NATIVE_HWPX_WAIT_BEGIN ${description}`);
  await browser.waitUntil(async () => predicate(await hostState()), {
    timeout: 90_000,
    interval: 250,
    timeoutMsg: `${description}; inspect the host save/conflict status and rerun this native spec`,
  });
  console.info(`NATIVE_HWPX_WAIT_PASS ${description}`);
}

interface RevisionEvidence {
  step: string;
  editorBaselineRevision: string;
  captureRevision: string;
  diskRevision: string;
}

/** Observe the real capture command and disk independently, without updating
 * the editor's retained baseline or replacing/mocking any native invocation. */
async function revisionEvidence(step: string, editorBaselineRevision: string): Promise<RevisionEvidence> {
  const diskRevision = createHash("sha256").update(await fs.readFile(fixtureHwpxPath())).digest("hex");
  const workspaceRoot = path.dirname(fixtureHwpxPath());
  const serialized = await browser.execute(async (root, documentPath) => {
    const scope = window as unknown as {
      __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => Promise<{ source: { revision: string } }> };
    };
    const captured = await scope.__TAURI_INTERNALS__.invoke("hwped_read", {
      workspaceRoot: root, document: { name: documentPath, path: documentPath }, captureSource: true,
    });
    return JSON.stringify({ revision: captured.source.revision });
  }, workspaceRoot, FIXTURE_HWPX_NAME);
  const captureRevision = (JSON.parse(serialized) as { revision: string }).revision;
  const evidence = { step, editorBaselineRevision, captureRevision, diskRevision };
  console.info(`NATIVE_HWPX_REVISIONS ${JSON.stringify(evidence)}`);
  assert.equal(captureRevision, diskRevision, `${step}: captureSource revision differs from the exact disk bytes`);
  return evidence;
}

async function selectFile(name: string): Promise<void> {
  await browser.waitUntil(async () => browser.execute((fileName) => {
    const row = [...document.querySelectorAll<HTMLElement>(".files-workbench .files-list-row")]
      .find((node) => (node.textContent ?? "").includes(fileName));
    if (!row) return false;
    row.click();
    return true;
  }, name), { timeout: 30_000, timeoutMsg: `Fixture file ${name} is absent from Files; inspect fixture seeding and the file filter` });
}

async function openEditor(): Promise<void> {
  await browser.waitUntil(async () => browser.execute(() => {
    const toggle = document.querySelector<HTMLButtonElement>(".hwp-editor-pane-toggle");
    if (!toggle) return false;
    if (toggle.getAttribute("aria-pressed") !== "true") toggle.click();
    return true;
  }), { timeout: 30_000, timeoutMsg: "The editor toggle is missing; inspect the selected fixture and retry" });
  await waitHost("The reopened editor did not finish loading its disk snapshot", (state) => state.paragraphs.length > 0);
}

/** Fixed argv against the same non-private fixture, independently of the UI's
 *  in-memory handle. A missing engine is a failure, never a skipped proof. */
function engineRead(file: string): { version: string; envelope: string } {
  const candidates = process.env.MARU_HWP_BIN ? [process.env.MARU_HWP_BIN] : ["ahwp", "hwp"];
  for (const binary of candidates) {
    try {
      const options = { encoding: "utf8" as const, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 };
      const version = execFileSync(binary, ["--version"], options).trim();
      const envelope = execFileSync(binary, ["cat", file, "--format", "markdown", "--with-segments"], options);
      JSON.parse(envelope);
      return { version, envelope };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error("The HWP engine is missing; install ahwp on the native runner PATH and rerun the spec");
}

async function snapshotFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await snapshotFiles(file));
    else if (entry.isFile() && entry.name.endsWith(".hwpx")) result.push(file);
  }
  return result;
}

describe("native hwpx editor", () => {
  it("renders, explicitly saves and reopens edits, and retains edits after conflicts and failed saves", async () => {
    assert.equal(process.platform, "darwin");

    const source = await fs.readFile(fixtureHwpxSource());
    const seeded = await fs.readFile(fixtureHwpxPath());
    assert.deepEqual(seeded, source, "the seeded .hwpx is not the template copy the fixture promises");
    const sourceRevision = createHash("sha256").update(source).digest("hex");
    const revisionChecks: RevisionEvidence[] = [];
    revisionChecks.push(await revisionEvidence("initial-capture", sourceRevision));

    // 1-2. Open the document from Files. The read-only preview is the default
    // view, so the editor must not be mounted yet.
    await step("open the .hwpx preview", (name: string, pollMs: number, done: (report: StepReport) => void) => {
      const deadline = Date.now() + pollMs;
      let clicked = false;
      const tick = () => {
        const rail = [...document.querySelectorAll<HTMLButtonElement>(".activity-rail .activity-button")]
          .find((button) => /^(파일|Files)$/.test((button.getAttribute("aria-label") ?? "").trim()));
        if (rail && !rail.classList.contains("active")) rail.click();
        if (document.querySelector(".files-workbench .binary-viewer--hwpx")) {
          done({ ok: true });
          return;
        }
        const row = [...document.querySelectorAll<HTMLElement>(".files-workbench .files-list-row")]
          .find((node) => (node.textContent ?? "").includes(name));
        if (row && !clicked) {
          row.click();
          clicked = true;
        }
        if (Date.now() > deadline) {
          done({
            ok: false,
            detail: JSON.stringify({
              rail: Boolean(rail),
              workbench: Boolean(document.querySelector(".files-workbench")),
              row: Boolean(row),
              rows: [...document.querySelectorAll(".files-workbench .files-list-row")]
                .slice(0, 6).map((node) => (node.textContent ?? "").slice(0, 40)),
              error: (document.querySelector(".binary-viewer-error, .files-preview-error")?.textContent ?? "").slice(0, 400),
            }),
          });
          return;
        }
        setTimeout(tick, 250);
      };
      tick();
    }, FIXTURE_HWPX_NAME);

    const previewState = await browser.execute(() => ({
      toggle: document.querySelector<HTMLButtonElement>(".hwp-editor-pane-toggle")?.getAttribute("aria-pressed") ?? null,
      editorMounted: Boolean(document.querySelector(".hwp-editor-host")),
      viewer: Boolean(document.querySelector(".binary-viewer--hwpx .binary-viewer-canvas--hwpx")),
    }));
    assert.equal(previewState.viewer, true, "the read-only preview did not render; the engine or the extract path failed");
    assert.equal(previewState.toggle, "false", "the .hwpx surface has no editor toggle, or it starts pressed");
    assert.equal(previewState.editorMounted, false, "the editor mounted before anyone asked to edit");

    // 3. Open the editor and wait for a real page: the engine read, render and
    // validate all run before the first page is painted.
    await step("mount the editor", (_arg: null, pollMs: number, done: (report: StepReport) => void) => {
      const deadline = Date.now() + pollMs;
      let clicked = false;
      const tick = () => {
        const toggle = document.querySelector<HTMLButtonElement>(".hwp-editor-pane-toggle");
        if (toggle && toggle.getAttribute("aria-pressed") !== "true" && !clicked) {
          toggle.click();
          clicked = true;
        }
        const page = document.querySelector('.hwp-editor-host .hwped-page-svg svg, .hwp-editor-host .hwped-page-svg img, .hwp-editor-host img.hwped-page-img[src^="data:image/svg+xml"]');
        if (page) {
          done({ ok: true });
          return;
        }
        if (Date.now() > deadline) {
          done({
            ok: false,
            detail: JSON.stringify({
              toggle: toggle?.getAttribute("aria-pressed") ?? null,
              host: Boolean(document.querySelector(".hwp-editor-host")),
              root: Boolean(document.querySelector(".hwp-editor-host .hwped-root")),
              error: (document.querySelector(".hwped-error, .hwp-editor-host .hwped-notice")?.textContent ?? "").slice(0, 400),
            }),
          });
          return;
        }
        setTimeout(tick, 250);
      };
      tick();
    }, null);

    // The sanitizer ran: the same document is rendered twice, once through the
    // package's own factory and once through the app's wrapped engine, and the
    // probe reports for every page whether the wrapped markup is exactly what
    // sanitizeHwpedPageSvg returns for the raw one. That string equality is the
    // proof; for a benign page the two parse to the same tree, so the painted
    // DOM cannot distinguish them — which is why the equality is measured here
    // and the painted page below is only compared against the sanitized page's
    // own geometry, a shape it shares with the raw page.
    const probe = (await browser.executeAsync((done: (value?: unknown) => void) => {
      const bridge = (window as unknown as {
        __MARU_NATIVE_E2E__?: { hwpedRenderProbe(documentPath: string): Promise<HwpedProbe> };
      }).__MARU_NATIVE_E2E__;
      if (!bridge) {
        done({ error: "the native-e2e bridge is not installed in this build" });
        return;
      }
      bridge.hwpedRenderProbe("hwp-cli-plan-template.hwpx").then(done, (error: unknown) => {
        done({ error: error instanceof Error ? error.message : String(error) });
      });
    })) as HwpedProbe | { error: string };
    assert.equal("error" in probe, false, `the hwped render probe failed: ${"error" in probe ? probe.error : ""}`);
    const rendered = probe as HwpedProbe;
    assert.ok(rendered.pageCount >= 1, `the engine rendered no pages (engine ${rendered.version})`);
    assert.equal(rendered.wrappedIsSanitizerOutput, true, "the page the editor paints is not the sanitizer's output for the engine's page");
    assert.ok(rendered.sanitizedBytes > 0, "the sanitized page is empty");
    assert.equal(rendered.hostile.script, false, "the sanitizer kept a script element");
    assert.equal(rendered.hostile.handler, false, "the sanitizer kept an on* handler");
    assert.equal(rendered.hostile.javascriptHref, false, "the sanitizer kept a javascript: reference");
    assert.equal(rendered.hostile.externalHref, false, "the sanitizer kept an external reference");
    assert.equal(rendered.hostile.dataRaster, true, "the sanitizer dropped a legitimate embedded raster; the scrub is not usable");

    const painted = (await browser.execute(() => {
      const host = document.querySelector(".hwp-editor-host");
      const pages = [...(host?.querySelectorAll('.hwped-page-svg svg, .hwped-page-svg img, img.hwped-page-img[src^="data:image/svg+xml"]') ?? [])];
      const painted = pages[0];
      if (!painted) return null;
      const image = painted instanceof HTMLImageElement ? painted : null;
      if (image && (!image.complete || image.naturalWidth === 0)) return null;
      const first = image
        ? new DOMParser().parseFromString(atob(image.src.split(",")[1] ?? ""), "image/svg+xml").documentElement
        : painted;
      const paths = [...first.querySelectorAll("path")];
      const box = painted.getBoundingClientRect();
      return {
        pages: pages.length,
        paths: paths.length,
        dTotal: paths.reduce((total, path) => total + (path.getAttribute("d")?.length ?? 0), 0),
        viewBox: first.getAttribute("viewBox"),
        width: first.getAttribute("width"),
        height: first.getAttribute("height"),
        box: [box.x, box.y, box.width, box.height] as [number, number, number, number],
      } satisfies PaintedPage;
    })) as PaintedPage | null;
    assert.ok(painted, "the editor painted no SVG page");
    assert.ok(painted.pages >= 1, "the editor painted no page");
    assert.ok(painted.box[2] > 0 && painted.box[3] > 0, `the painted page has no area: ${JSON.stringify(painted.box)}`);
    assert.deepEqual(
      { paths: painted.paths, dTotal: painted.dTotal, viewBox: painted.viewBox, width: painted.width, height: painted.height },
      rendered.firstPage,
      "the painted page is not the page the sanitized render describes for this document",
    );

    // One edit through the editor's own UI: select a paragraph the replace
    // field accepts, type a replacement and queue it. Pending operations must
    // disable Save until Apply finishes; Save cannot implicitly apply them.
    const edited = await step(
      "queue one edit",
      queueOneEdit,
      { marker: "네이티브 Native edit", from: 0, requireNote: false },
    );
    assert.ok(edited.ok, "the editor did not queue the replacement");
    assert.equal((await hostState()).saveEnabled, false, "Save is enabled with unapplied operations");

    // The engine performs the queued operations on the memory bytes.
    await step("apply the edit", applyQueuedEdits, null);

    // The edit has to reach the page. An apply that re-reads the file on disk
    // clears the pending list just as happily and paints the same glyphs again,
    // so the shape of the first page is what says the document changed.
    await step("paint the applied edit", (baseline: { paths: number; dTotal: number }, pollMs: number, done: (report: StepReport) => void) => {
      const deadline = Date.now() + pollMs;
      const read = () => {
        const painted = document.querySelector('.hwp-editor-host .hwped-page-svg svg, .hwp-editor-host .hwped-page-svg img, .hwp-editor-host img.hwped-page-img[src^="data:image/svg+xml"]');
        if (!painted) return null;
        const image = painted instanceof HTMLImageElement ? painted : null;
        if (image && (!image.complete || image.naturalWidth === 0)) return null;
        const first = image
          ? new DOMParser().parseFromString(atob(image.src.split(",")[1] ?? ""), "image/svg+xml").documentElement
          : painted;
        const paths = [...first.querySelectorAll("path")];
        return {
          paths: paths.length,
          dTotal: paths.reduce((total, path) => total + (path.getAttribute("d")?.length ?? 0), 0),
        };
      };
      const tick = () => {
        const now = read();
        if (now !== null && (now.paths !== baseline.paths || now.dTotal !== baseline.dTotal)) {
          done({ ok: true, detail: JSON.stringify(now) });
          return;
        }
        if (Date.now() > deadline) {
          done({ ok: false, detail: JSON.stringify({ baseline, now }) });
          return;
        }
        setTimeout(tick, 250);
      };
      tick();
    }, { paths: painted.paths, dTotal: painted.dTotal });

    // The paragraph list is text the reader reads, and it is rendered from the
    // document the editor holds, so it shows the replacement only if the engine
    // handed back the edited document rather than the file it started from.
    await step("show the edited paragraph", (marker: string, pollMs: number, done: (report: StepReport) => void) => {
      const deadline = Date.now() + pollMs;
      const firstOption = () =>
        (document.querySelector('.hwped-side [role="listbox"] [role="option"]')?.textContent ?? "");
      const tick = () => {
        const label = firstOption();
        if (label.includes(marker)) {
          done({ ok: true, detail: label.slice(0, 120) });
          return;
        }
        if (Date.now() > deadline) {
          done({ ok: false, detail: label.slice(0, 200) });
          return;
        }
        setTimeout(tick, 250);
      };
      tick();
    }, "네이티브 Native edit");

    // A second edit and a second apply. The engine hands an edit back as a new
    // handle carrying the edited bytes; sent back as a path it would be re-read
    // from disk, so this apply would start from the original file and the first
    // edit would be gone.
    await step("queue a second edit", queueOneEdit, { marker: "Native second", from: 1, requireNote: false });
    await step("apply the second edit", applyQueuedEdits, null);
    await step("keep the first edit", (markers: string[], pollMs: number, done: (report: StepReport) => void) => {
      const deadline = Date.now() + pollMs;
      const options = () =>
        [...document.querySelectorAll('.hwped-side [role="listbox"] [role="option"]')]
          .map((node) => (node.textContent ?? ""));
      const tick = () => {
        const texts = options();
        if (markers.every((marker, index) => (texts[index] ?? "").includes(marker))) {
          done({ ok: true, detail: JSON.stringify(texts.slice(0, 3)) });
          return;
        }
        if (Date.now() > deadline) {
          done({ ok: false, detail: JSON.stringify(texts.slice(0, 4)) });
          return;
        }
        setTimeout(tick, 250);
      };
      tick();
    }, ["네이티브 Native edit", "Native second"]);

    // 5. N1: back to the preview keeps the editor mounted, hidden, because its
    // edit lives in that component's memory and an unmount would drop it.
    await step("return to the preview", (_arg: null, pollMs: number, done: (report: StepReport) => void) => {
      const deadline = Date.now() + pollMs;
      let clicked = false;
      const tick = () => {
        const toggle = document.querySelector<HTMLButtonElement>(".hwp-editor-pane-toggle");
        if (toggle && toggle.getAttribute("aria-pressed") === "true" && !clicked) {
          toggle.click();
          clicked = true;
        }
        const host = document.querySelector<HTMLElement>(".hwp-editor-host");
        const hidden = host !== null && (host.hidden || host.getBoundingClientRect().height === 0);
        const viewer = Boolean(document.querySelector(".binary-viewer--hwpx .binary-viewer-canvas--hwpx"));
        if (viewer && hidden) {
          done({ ok: true, detail: host && host.querySelector(".hwped-root") ? "editor mounted and hidden" : "editor unmounted" });
          return;
        }
        if (Date.now() > deadline) {
          done({
            ok: false,
            detail: JSON.stringify({
              pressed: toggle?.getAttribute("aria-pressed") ?? null,
              host: Boolean(host),
              hidden,
              root: Boolean(document.querySelector(".hwp-editor-host .hwped-root")),
              viewer,
            }),
          });
          return;
        }
        setTimeout(tick, 250);
      };
      tick();
    }, null);

    const remount = await browser.execute(() => {
      const host = document.querySelector<HTMLElement>(".hwp-editor-host");
      return {
        mounted: Boolean(host?.querySelector(".hwped-root")),
        hidden: host?.hidden ?? false,
        height: host?.getBoundingClientRect().height ?? -1,
      };
    });
    assert.equal(remount.hidden, true, "the editor host is visible again after going back to the preview");
    assert.equal(remount.height, 0, "the hidden editor host still occupies layout");
    assert.equal(remount.mounted, true, "the editor was unmounted on the way back to the preview, dropping its edit");

    // Apply and Back to preview cannot silently persist or forget edits.
    const afterEdit = await fs.readFile(fixtureHwpxPath());
    assert.deepEqual(afterEdit, source, "Apply wrote the .hwpx before an explicit host Save");
    const unsaved = await hostState();
    assert.match(unsaved.status, /저장하지 않은 변경 사항|Unsaved changes/, "Apply/back to preview lost the unsaved state (T66-N3)");
    await openEditor();
    await waitHost("Save did not enable after Apply completed", (state) => state.saveEnabled);
    revisionChecks.push(await revisionEvidence("save-applied-cumulative-edits", sourceRevision));
    await clickHost("hwpx-save");
    await waitHost("The explicit save did not finish", (state) => /저장됨|Saved/.test(state.status) && !state.saveEnabled);

    const saved = await fs.readFile(fixtureHwpxPath());
    const savedRevision = createHash("sha256").update(saved).digest("hex");
    revisionChecks.push(await revisionEvidence("saved-cumulative-edits", savedRevision));
    assert.notDeepEqual(saved, source, "Save reported success without changing the fixture bytes");
    const versions = path.join(path.dirname(fixtureHwpxPath()), ".maru", "versions");
    const snapshots = await snapshotFiles(versions);
    const originals = await Promise.all(snapshots.map(async (file) => ({ file, bytes: await fs.readFile(file) })));
    const originalSnapshot = originals.find(({ bytes }) => bytes.equals(source));
    assert.ok(originalSnapshot, "No byte-identical .hwpx recovery snapshot exists after Save");
    assert.equal((await fs.stat(originalSnapshot.file)).mode & 0o077, 0, "The binary snapshot is not private to its owner");
    const reread = engineRead(fixtureHwpxPath());
    assert.ok(reread.envelope.includes("네이티브 Native edit"), "The saved disk file lost the Korean/English first edit");
    assert.ok(reread.envelope.includes("Native second"), "The second edit did not operate on the first edited bytes");

    // Selecting another file destroys the old surface. Opening this file again
    // must capture disk bytes; showing a still-mounted handle is insufficient.
    await selectFile(`${FIXTURE_DOC_NAME}.md`);
    await browser.waitUntil(async () => browser.execute(() => !document.querySelector(".hwp-editor-host")), {
      timeout: 30_000, timeoutMsg: "The saved editor did not unmount when another file was selected; inspect Files selection",
    });
    await selectFile(FIXTURE_HWPX_NAME);
    await openEditor();
    await waitHost("Reopening lost the two saved edits", (state) =>
      state.paragraphs.some((text) => text.includes("네이티브 Native edit"))
      && state.paragraphs.some((text) => text.includes("Native second")));
    assert.equal((await hostState()).saveEnabled, false, "Reopening persisted bytes starts dirty");
    revisionChecks.push(await revisionEvidence("reopened-saved-file", savedRevision));

    await step("queue the conflict edit", queueOneEdit, { marker: "충돌 Conflict retained", from: 0, requireNote: false });
    await step("apply the conflict edit", applyQueuedEdits, null);
    await waitHost("Save is unavailable after the conflict edit", (state) => state.saveEnabled);
    // Replace with a different known-valid HWPX, as a non-cooperating external
    // writer would. This must conflict rather than update the revision/retry.
    await fs.writeFile(fixtureHwpxPath(), source);
    const conflictRevisions = await revisionEvidence("external-replacement-conflict", savedRevision);
    revisionChecks.push(conflictRevisions);
    assert.notEqual(conflictRevisions.editorBaselineRevision, conflictRevisions.diskRevision,
      "The external-replacement case must exercise a genuinely stale editor baseline");
    await clickHost("hwpx-save");
    await waitHost("An externally replaced file did not produce conflict recovery", (state) => state.conflict);
    assert.match((await hostState()).error, /document_conflict/, "The expected conflict notice lost its refusal cause");
    assert.deepEqual(await fs.readFile(fixtureHwpxPath()), source, "The conflict path overwrote the external revision");
    assert.ok((await hostState()).paragraphs.some((text) => text.includes("충돌 Conflict retained")), "The conflict discarded the in-memory edit");
    await clickHost("hwpx-keep-editing");
    await waitHost("Keep editing did not retain the current document", (state) =>
      !state.conflict && state.paragraphs.some((text) => text.includes("충돌 Conflict retained")));
    revisionChecks.push(await revisionEvidence("retry-retains-stale-baseline", savedRevision));
    await clickHost("hwpx-save");
    await waitHost("Retry silently refreshed the expected disk revision", (state) => state.conflict);
    await clickHost("hwpx-reload");
    await waitHost("Reload did not request explicit discard confirmation", (state) => state.discard);
    await clickHost("hwpx-discard-cancel");
    await waitHost("Cancel did not preserve the conflict edit", (state) =>
      !state.discard && state.paragraphs.some((text) => text.includes("충돌 Conflict retained")));
    await clickHost("hwpx-reload");
    await waitHost("The second reload did not ask to discard", (state) => state.discard);
    await clickHost("hwpx-discard");
    await waitHost("Explicit disk reload did not clear the old edit", (state) =>
      !state.discard && !state.conflict && state.paragraphs.length > 0
      && !state.paragraphs.some((text) => text.includes("충돌 Conflict retained")));
    revisionChecks.push(await revisionEvidence("confirmed-disk-reload", sourceRevision));

    await step("queue the failed-save edit", queueOneEdit, { marker: "실패 Failed save retained", from: 0, requireNote: false });
    await step("apply the failed-save edit", applyQueuedEdits, null);
    await waitHost("Save did not enable for the failed-save case", (state) => state.saveEnabled);
    // Force a real snapshot-directory failure inside this disposable fixture.
    // Preserve the successful snapshot directory and restore it in all cases.
    const parkedVersions = path.join(path.dirname(versions), "native-save-versions-backup");
    await fs.rename(versions, parkedVersions);
    try {
      await fs.writeFile(versions, "Native fixture obstructs the snapshot directory\n", { flag: "wx", mode: 0o600 });
      revisionChecks.push(await revisionEvidence("snapshot-directory-failure", sourceRevision));
      await clickHost("hwpx-save");
      await waitHost("A snapshot-directory failure did not surface an error", (state) => state.error.length > 0 && state.saveEnabled);
      const failed = await hostState();
      assert.equal(failed.conflict, false, "A filesystem failure entered revision-conflict recovery");
      assert.match(failed.status, /저장하지 않은 변경 사항|Unsaved changes/, "A failed save cleared unsaved state");
      assert.ok(failed.paragraphs.some((text) => text.includes("실패 Failed save retained")), "A failed save discarded its edits");
      assert.deepEqual(await fs.readFile(fixtureHwpxPath()), source, "The failed save changed the original file");
    } finally {
      await fs.rm(versions, { force: true });
      await fs.rename(parkedVersions, versions);
    }

    // This receipt exists only after the native assertions above have passed.
    // It records versions and scope, never upgrades Chromium or compile-only
    // results into native proof. Text replacement exercises Korean bytes; it
    // does not establish interactive Korean IME composition.
    const manifest = JSON.parse(await fs.readFile(new URL("../../package.json", import.meta.url), "utf8")) as {
      version: string; dependencies: Record<string, string>;
    };
    const artifactDir = path.join(process.cwd(), "artifacts", "native-hwpx-save");
    await fs.mkdir(artifactDir, { recursive: true });
    await fs.writeFile(path.join(artifactDir, "result.json"), `${JSON.stringify({
      appVersion: manifest.version,
      revisionChecks,
      packages: { core: manifest.dependencies["@hwp-editor/core"], react: manifest.dependencies["@hwp-editor/react"] },
      appEngineVersion: rendered.version,
      rereadEngineVersion: reread.version,
      platform: process.platform,
      fixtureRoot: path.relative(fixtureRootDir(), path.dirname(fixtureHwpxPath())),
      assertions: ["explicit-save", "korean-english-reopen", "second-edit-memory-bytes", "exact-private-snapshot", "external-conflict", "keep-editing", "reload-cancel", "confirmed-reload", "snapshot-failure-retains-edits"],
      unverified: ["interactive Korean IME composition"],
    }, null, 2)}\n`);
  }).timeout(600_000);
});

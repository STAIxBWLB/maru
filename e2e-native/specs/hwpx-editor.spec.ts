// maru#563 real-app check: a .hwpx opens, renders through the HWP engine,
// takes one edit and never writes that edit back to the file. Chromium cannot
// prove any of it: the preview and the editor both spawn the engine over
// native IPC, and decision B (an edit stays in the window) is a claim about
// the bytes on disk.
//
// The engine is a real dependency, so this spec needs `ahwp` (or the 1.x `hwp`
// compatibility name) on the app's PATH: the macOS CI job installs it before
// the suite runs. A missing engine fails the preview assertion with the
// engine's own `cli_missing` sentence in the detail — it is never skipped,
// because a skipped editor check is not evidence that the editor works.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type {} from "webdriverio";

import {
  FIXTURE_HWPX_NAME,
  fixtureHwpxPath,
  fixtureHwpxSource,
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
 *  maru's not-saved note is on screen from the moment the editor opens.
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
    if (!input || input.disabled || quote === "") {
      const option = options[optionIndex];
      if (option && option.getAttribute("aria-selected") !== "true") option.click();
      else if (option) optionIndex += 1;
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

/** Applies whatever is queued: the engine performs the ops in memory, which is
 *  the path decision B leaves without a writer. The button only enables while
 *  ops are pending and disables again once the engine returns. */
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
    if (clicked && !pending && apply.disabled && root()?.getAttribute("data-status") !== "applying") {
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

describe("native hwpx editor", () => {
  it("renders a sanitized page, takes an edit, and leaves the file on disk untouched", async () => {
    assert.equal(process.platform, "darwin");

    const source = await fs.readFile(fixtureHwpxSource());
    const seeded = await fs.readFile(fixtureHwpxPath());
    assert.deepEqual(seeded, source, "the seeded .hwpx is not the template copy the fixture promises");

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
        const page = document.querySelector(".hwp-editor-host .hwped-page-svg svg");
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
      const pages = [...(host?.querySelectorAll(".hwped-page-svg svg") ?? [])];
      const first = pages[0];
      if (!first) return null;
      const paths = [...first.querySelectorAll("path")];
      const box = first.getBoundingClientRect();
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

    // 4. One edit through the editor's own UI: select a paragraph the replace
    // field accepts, type a replacement and queue the op. maru's note is on
    // screen from the moment the editor opens (it says edits stay in the
    // window, whether or not anything is queued yet), so the observable that
    // an edit really happened is the editor's own pending list.
    const edited = await step(
      "queue one edit",
      queueOneEdit,
      { marker: "Native edit", from: 0, requireNote: true },
    );
    assert.match(edited.detail ?? "", /저장하지 않습니다|does not write them back/, "the queued edit did not show maru's not-saved note");

    // The engine performs the queued ops in memory, which is the path decision B
    // leaves without a writer.
    await step("apply the edit", applyQueuedEdits, null);

    // The edit has to reach the page. An apply that re-reads the file on disk
    // clears the pending list just as happily and paints the same glyphs again,
    // so the shape of the first page is what says the document changed.
    await step("paint the applied edit", (baseline: { paths: number; dTotal: number }, pollMs: number, done: (report: StepReport) => void) => {
      const deadline = Date.now() + pollMs;
      const read = () => {
        const first = document.querySelector(".hwp-editor-host .hwped-page-svg svg");
        if (!first) return null;
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
    }, "Native edit");

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
    }, ["Native edit", "Native second"]);

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

    // 6. Decision B: the edit existed only in the window. The file on disk is
    // still the template byte for byte.
    const afterEdit = await fs.readFile(fixtureHwpxPath());
    assert.deepEqual(afterEdit, source, "the .hwpx on disk changed; maru has no write path and must not gain one by accident");
  }).timeout(300_000);
});

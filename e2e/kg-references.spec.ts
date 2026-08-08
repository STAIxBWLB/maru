import { expect, test, type Page } from "@playwright/test";

// KG reference visualization e2e (kg_refs Phase 4). Seeds a fake
// `kg_document_refs` backend through the browser e2e seam
// (`window.__MARU_E2E_INVOKE__`, see src/lib/e2eInvoke.ts) with spans whose
// UTF-8 byte offsets are computed here against the same mock document the
// web-mode fixtures serve (src/lib/fixtures.ts — maru-weekly-meeting.md).
//
// Feature A: the "참조 시각화" trigger opens the doc↔graph split in
// reference-focus mode (DOM signal: graph-ref-focus-bar with the referenced
// node count). Feature B: the "참조 하이라이트" toggle decorates the source
// backdrop and the preview with .kg-ref-mark elements; toggle off clears.

// Preview marks are applied by an effect that unwraps and re-wraps the ranges
// whenever it re-runs (EditorPane.tsx, the applyKgPreviewHighlights effect), so
// the click target in "mark click focuses the graph" can be replaced underneath
// Playwright: the observed failure alternated "element is not stable" and
// "element was detached from the DOM, retrying" until the 30s timeout.
//
// Seen once on a CI push (2 workers) and not reproduced in 5+ single-worker
// local runs of this spec, the full 118-test local suite, or the PR run; the
// rerun of that same commit passed. The final DOM is correct either way, so this
// is a click-stability race in the test rather than a product defect. Retrying
// only this spec follows the same reasoning as e2e/graph.spec.ts: unrelated E2E
// regressions stay hard failures, and Playwright still reports a retried pass as
// flaky so it does not go unnoticed. Remove this once the effect stops
// re-wrapping on every re-run.
test.describe.configure({ retries: process.env.CI ? 2 : 0 });

// Mirrors `sampleContent` in src/lib/fixtures.ts (now = 2026-04-27T09:00:00+09:00).
const MOCK_DOC_CONTENT = `---
type: meeting
status: active
project: "[[Maru Project]]"
tags:
  - 회의록
people:
  - "[[김하린]]"
created_at: 2026-04-20T09:00:00+09:00
updated_at: 2026-04-27T09:00:00+09:00
---
# Maru 사업 주간 점검 회의

## 메모
참석자들은 사업 KPI 산식과 예산 집행률 보고 기준을 다음 회의 전까지 정리하기로 했다.
`;

const encoder = new TextEncoder();
const byteLen = (text: string) => encoder.encode(text).length;

function spanFor(text: string, paragraph: number) {
  const charStart = MOCK_DOC_CONTENT.indexOf(text);
  if (charStart < 0) throw new Error(`fixture drift: "${text}" not in mock doc`);
  const start = byteLen(MOCK_DOC_CONTENT.slice(0, charStart));
  return { start, end: start + byteLen(text), paragraph };
}

// [[Maru Project]] sits in the frontmatter (paragraph 0) — the preview
// strips frontmatter, so only the body entity "KPI" maps there. "KPI" is in
// the third blank-line-separated block (frontmatter, title, memo).
const SEEDED_REFS = [
  {
    nodePath: "maru-project.md",
    nodeTitle: "Maru Project",
    matchKind: "wikilink",
    spans: [spanFor("[[Maru Project]]", 0)],
  },
  {
    nodePath: "references/maru-glossary.md",
    nodeTitle: "Maru 용어집",
    matchKind: "entity",
    spans: [spanFor("KPI", 2)],
  },
];

function seedBackend(page: Page) {
  const refs = SEEDED_REFS;
  return page.addInitScript((seededRefs) => {
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
      kg_document_refs: (args) => {
        calls.push({ command: "kg_document_refs", args });
        return {
          docPath: args.docPath,
          docHash: "e2e-hash",
          vaultStamp: "e2e-stamp",
          refs: seededRefs,
          computedAt: "2026-07-30T00:00:00Z",
        };
      },
      kg_refs_clear: () => 0,
    };
    (
      window as unknown as {
        __MARU_E2E_INVOKE__: typeof handlers;
        __MARU_KG_CALLS__: typeof calls;
      }
    ).__MARU_E2E_INVOKE__ = handlers;
    (window as unknown as { __MARU_KG_CALLS__: typeof calls }).__MARU_KG_CALLS__ = calls;
  }, refs);
}

const kgCallCount = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __MARU_KG_CALLS__: unknown[] }).__MARU_KG_CALLS__
        .length,
  );

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem("maru:kgref-e2e:storage-cleared") === "true") return;
    window.localStorage.clear();
    window.sessionStorage.setItem("maru:kgref-e2e:storage-cleared", "true");
  });
  await seedBackend(page);
});

async function openMeetingDoc(page: Page) {
  await page.goto("/");
  const documentList = page.locator(".document-list");
  const docButton = documentList.getByRole("button", {
    name: /Maru 사업 주간 점검 회의/,
  });
  await expect(docButton).toBeVisible();
  await docButton.click();
  await expect(page.getByTestId("kg-visualize-refs")).toBeVisible();
}

test("visualize trigger opens the graph split in reference-focus mode", async ({
  page,
}) => {
  await openMeetingDoc(page);

  // Strictly on-demand: nothing computed before the explicit trigger.
  expect(await kgCallCount(page)).toBe(0);
  await expect(page.getByTestId("graph-ref-focus-bar")).toHaveCount(0);

  await page.getByTestId("kg-visualize-refs").click();

  // The doc↔graph split opens (graph in the tool panel)…
  await expect(page.getByTestId("panel-graph-surface")).toBeVisible();
  // …in reference-focus mode. Only the glossary note resolves to a real graph
  // node (Maru Project is an unresolved ghost), so the count is 1.
  const bar = page.getByTestId("graph-ref-focus-bar");
  await expect(bar).toBeVisible();
  await expect(bar).toContainText("참조 노드 1개 강조 중");
  expect(await kgCallCount(page)).toBe(1);

  // Exit restores the normal graph.
  await page.getByTestId("graph-ref-focus-exit").click();
  await expect(page.getByTestId("graph-ref-focus-bar")).toHaveCount(0);
});

test("highlight toggle decorates source mode and clears on toggle off", async ({
  page,
}) => {
  await openMeetingDoc(page);
  await page.locator(".tab-trigger", { hasText: "원문" }).click();
  await expect(page.locator("textarea.source-editor")).toHaveValue(/# Maru 사업 주간 점검 회의/);

  await page.getByTestId("kg-highlight-toggle").click();
  const marks = page.locator(".kg-source-backdrop .kg-ref-mark");
  await expect(marks).toHaveCount(2);
  await expect(
    page.locator(".kg-source-backdrop .kg-ref-wikilink"),
  ).toHaveText("[[Maru Project]]");
  await expect(page.locator(".kg-source-backdrop .kg-ref-entity")).toHaveText("KPI");

  await page.getByTestId("kg-highlight-toggle").click();
  await expect(page.locator(".kg-source-backdrop .kg-ref-mark")).toHaveCount(0);
});

test("highlight toggle decorates preview and mark click focuses the graph", async ({
  page,
}) => {
  await openMeetingDoc(page);
  await page.locator(".tab-trigger", { hasText: "미리보기" }).click();
  await expect(page.locator(".preview-surface")).toContainText("Maru 사업 주간 점검 회의");

  const toggle = page.getByTestId("kg-highlight-toggle");
  await toggle.click();
  // The request is asynchronous; synchronize on the app state that owns the
  // preview effect before asserting its derived mark DOM.
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  // Frontmatter is stripped from the preview, so only the body entity maps.
  const marks = page.locator(".preview-surface mark.kg-ref-mark");
  await expect(marks).toHaveCount(1);
  await expect(marks.first()).toHaveText("KPI");

  // Mark click → "그래프에서 보기": the panel graph opens focused on the node.
  await marks.first().click();
  await expect(page.getByTestId("panel-graph-surface")).toBeVisible();
  await expect(page.getByTestId("graph-focus-bar")).toContainText("Maru 용어집");
});

test("highlight toggle decorates rich mode and mark click focuses the graph", async ({
  page,
}) => {
  await openMeetingDoc(page);
  await page.locator(".tab-trigger", { hasText: "리치" }).click();
  const surface = page.locator(".rich-editor-surface");
  await expect(surface).toContainText("KPI");

  // The toggle is no longer gated off in rich mode.
  const toggle = page.getByTestId("kg-highlight-toggle");
  await expect(toggle).toBeEnabled();
  await toggle.click();

  // Frontmatter is stripped by BlockNote too, so only the body entity maps.
  // The mark is a BlockNote style span carrying the node path.
  const marks = surface.locator(".kg-ref-mark");
  await expect(marks).toHaveCount(1);
  await expect(marks.first()).toHaveText("KPI");
  await expect(marks.first()).toHaveAttribute("data-kg-node", "references/maru-glossary.md");
  // Same match-kind class and tooltip as the preview/source marks.
  await expect(marks.first()).toHaveClass(/kg-ref-entity/);
  await expect(marks.first()).toHaveAttribute("title", /Maru 용어집/);

  // Mark click → same graph-focus path as the preview mark.
  await marks.first().click();
  await expect(page.getByTestId("panel-graph-surface")).toBeVisible();
  await expect(page.getByTestId("graph-focus-bar")).toContainText("Maru 용어집");
});

test("source mode mark click focuses the graph", async ({ page }) => {
  await openMeetingDoc(page);
  await page.locator(".tab-trigger", { hasText: "원문" }).click();
  await expect(page.locator("textarea.source-editor")).toHaveValue(/# Maru 사업 주간 점검 회의/);

  await page.getByTestId("kg-highlight-toggle").click();
  const mark = page.locator(".kg-source-backdrop .kg-ref-entity");
  await expect(mark).toHaveText("KPI");

  // A click outside any span must not focus a node. (panel-graph-surface is
  // always mounted in this layout, so the absence signal is the focus bar.)
  const textarea = page.locator("textarea.source-editor");
  const taBox = await textarea.boundingBox();
  if (!taBox) throw new Error("source textarea not laid out");
  await page.mouse.click(taBox.x + taBox.width / 2, taBox.y + taBox.height - 4);
  await expect(page.getByTestId("graph-focus-bar")).toHaveCount(0);

  // The backdrop is pointer-events:none, so the click lands on the textarea;
  // the caret offset hit-tests against the span.
  const box = await mark.boundingBox();
  if (!box) throw new Error("backdrop mark not laid out");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.getByTestId("panel-graph-surface")).toBeVisible();
  await expect(page.getByTestId("graph-focus-bar")).toContainText("Maru 용어집");
});

// --- Feature A: the converge animation actually moves nodes ------------------
// This exists because the animation shipped as a visual no-op: the tick called
// renderer.refresh() with no arguments, which takes sigma's full-refresh path
// and re-reads x/y from the graphology attributes, discarding the reducer's
// animated coordinates. Nothing on screen moved while the loop paid for ~90 full
// re-index passes. Asserting on nodeViewportPoint would NOT have caught it
// either — that projects the graphology attributes, which the animation
// deliberately never touches. Only the rendered display data can prove motion.

interface KgBridge {
  frames(): number;
  layoutRunning(): boolean;
  nodeScreenState(id: string): { x: number | null; y: number | null };
}

/** Two refs that resolve to REAL graph nodes. The centroid is computed from the
 *  referenced set, so a single resolved node sits on its own centroid and cannot
 *  move by construction — the default SEEDED_REFS (one ghost, one real) can never
 *  show motion. The web-mode fixtures expose exactly two markdown documents
 *  (src/lib/fixtures.ts mockDocuments; the html ones need ?mockHtml), so both of
 *  them have to be referenced to get a centroid the nodes can travel toward. */
const TWO_REAL_REFS = [
  {
    nodePath: "references/maru-glossary.md",
    nodeTitle: "Maru 용어집",
    matchKind: "entity",
    spans: [spanFor("KPI", 2)],
  },
  {
    nodePath: "maru-weekly-meeting.md",
    nodeTitle: "Maru 사업 주간 점검 회의",
    matchKind: "entity",
    spans: [spanFor("예산", 2)],
  },
];

/** Separation between the two referenced nodes in rendered space. Camera panning
 *  moves both equally, so a distance is immune to the 320ms camera framing that
 *  runs alongside the converge animation. */
const separation = (page: Page) =>
  page.evaluate(() => {
    const bridge = (window as unknown as { __maruGraph: KgBridge }).__maruGraph;
    const a = bridge.nodeScreenState("maru-glossary");
    const b = bridge.nodeScreenState("maru-weekly-meeting");
    if (a.x == null || a.y == null || b.x == null || b.y == null) return null;
    return Math.hypot(a.x - b.x, a.y - b.y);
  });

test("reference-focus converge animation moves the referenced nodes", async ({ page }) => {
  await page.addInitScript((seededRefs) => {
    window.localStorage.setItem("maru:e2e:graph-bridge", "1");
    const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
      kg_document_refs: (args) => ({
        docPath: args.docPath,
        docHash: "e2e-hash",
        vaultStamp: "e2e-stamp",
        refs: seededRefs,
        computedAt: "2026-07-30T00:00:00Z",
      }),
      kg_refs_clear: () => 0,
    };
    (window as unknown as { __MARU_E2E_INVOKE__: typeof handlers }).__MARU_E2E_INVOKE__ =
      handlers;
  }, TWO_REAL_REFS);

  await page.setViewportSize({ width: 1600, height: 900 });
  await openMeetingDoc(page);
  await page.getByTestId("kg-visualize-refs").click();
  await expect(page.getByTestId("panel-graph-surface")).toBeVisible();
  await expect(page.getByTestId("graph-ref-focus-bar")).toContainText("2개");

  await page.waitForFunction(
    () => {
      const bridge = (window as unknown as { __maruGraph?: KgBridge }).__maruGraph;
      return bridge != null && bridge.frames() > 0;
    },
    undefined,
    { timeout: 15_000 },
  );

  // Opening the reference-focus split rescans the workspace, which rebuilds the
  // renderer and restarts FA2 — node positions drift until it settles. The
  // animation deliberately waits for a ready renderer, so sampling only after
  // layout stops isolates it from that drift: from here the ONLY thing that can
  // move a node is the converge animation.
  await page.waitForFunction(
    () => {
      const bridge = (window as unknown as { __maruGraph?: KgBridge }).__maruGraph;
      return bridge != null && !bridge.layoutRunning();
    },
    undefined,
    { timeout: 20_000 },
  );

  // Sampled from the Node side, one evaluate per read: headless chromium throttles
  // in-page timers hard (a 25ms setInterval fired twice in 1.9s; rAF ~8 times in
  // 1.8s), so an in-page sampling loop misses the peak entirely.
  const samples: number[] = [];
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const value = await separation(page);
    if (value != null) samples.push(value);
  }
  expect(samples.length).toBeGreaterThan(50);

  // The baseline is the TAIL of the window, not the maximum: layoutRunning() can
  // read false in the gap before FA2 starts, when seed positions are still wild
  // (an 18x outlier was observed), and the animation ends back on the layout
  // positions anyway. A flat tail also proves the run actually finished.
  const tail = samples.slice(Math.floor(samples.length * 0.8));
  const rest = tail[tail.length - 1];
  expect(Math.max(...tail) - Math.min(...tail)).toBeLessThan(rest * 0.02);

  // Converge pulls each node 35% of the way to the shared centroid, so the
  // separation bottoms out at 0.65x the layout separation. Before the fix nothing
  // moved once layout had settled, so the minimum equals the resting value.
  expect(Math.min(...samples)).toBeLessThan(rest * 0.8);
});

/** Same two real nodes, but cited from DIFFERENT paragraphs, so the reference
 *  walk has two legs. TWO_REAL_REFS above puts both in paragraph 2, which is a
 *  single leg and deliberately shows no walk controls. */
const REFS_IN_TWO_PARAGRAPHS = [
  {
    nodePath: "references/maru-glossary.md",
    nodeTitle: "Maru 용어집",
    matchKind: "entity",
    spans: [spanFor("KPI", 1)],
  },
  {
    nodePath: "maru-weekly-meeting.md",
    nodeTitle: "Maru 사업 주간 점검 회의",
    matchKind: "entity",
    spans: [spanFor("예산", 2)],
  },
];

async function seedRefs(page: Page, refs: unknown) {
  await page.addInitScript((seededRefs) => {
    window.localStorage.setItem("maru:e2e:graph-bridge", "1");
    const handlers: Record<string, (args: Record<string, unknown>) => unknown> = {
      kg_document_refs: (args) => ({
        docPath: args.docPath,
        docHash: "e2e-hash",
        vaultStamp: "e2e-stamp",
        refs: seededRefs,
        computedAt: "2026-07-30T00:00:00Z",
      }),
      kg_refs_clear: () => 0,
    };
    (window as unknown as { __MARU_E2E_INVOKE__: typeof handlers }).__MARU_E2E_INVOKE__ =
      handlers;
  }, refs);
}

test("reference walk steps through the citing paragraphs", async ({ page }) => {
  await seedRefs(page, REFS_IN_TWO_PARAGRAPHS);
  await page.setViewportSize({ width: 1600, height: 900 });
  await openMeetingDoc(page);
  await page.getByTestId("kg-visualize-refs").click();
  await expect(page.getByTestId("panel-graph-surface")).toBeVisible();
  await expect(page.getByTestId("graph-ref-focus-bar")).toContainText("2개");

  // Two citing paragraphs, so the walk is worth showing and starts at the first.
  const label = page.getByTestId("graph-ref-walk-label");
  await expect(label).toHaveText("문단 1/2", { timeout: 25_000 });
  // It advances on its own: one leg per paragraph, in document order.
  await expect(label).toHaveText("문단 2/2", { timeout: 20_000 });

  // The walk parks at the end paused, so it can be stepped through by hand.
  await expect(page.getByTestId("graph-ref-walk-next")).toBeDisabled();
  await page.getByTestId("graph-ref-walk-prev").click();
  await expect(label).toHaveText("문단 1/2");
  await expect(page.getByTestId("graph-ref-walk-prev")).toBeDisabled();
  await page.getByTestId("graph-ref-walk-next").click();
  await expect(label).toHaveText("문단 2/2");

  // Exiting reference focus takes the controls with it.
  await page.getByTestId("graph-ref-focus-exit").click();
  await expect(page.getByTestId("graph-ref-walk")).toHaveCount(0);
});

test("a document citing everything from one paragraph shows no walk controls", async ({ page }) => {
  await seedRefs(page, TWO_REAL_REFS);
  await page.setViewportSize({ width: 1600, height: 900 });
  await openMeetingDoc(page);
  await page.getByTestId("kg-visualize-refs").click();
  await expect(page.getByTestId("graph-ref-focus-bar")).toContainText("2개");
  // One leg is the old single-burst animation; a "1/1" control bar would be noise.
  await expect(page.getByTestId("graph-ref-walk")).toHaveCount(0);
});

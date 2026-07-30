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

  await page.getByTestId("kg-highlight-toggle").click();
  // Frontmatter is stripped from the preview, so only the body entity maps.
  const marks = page.locator(".preview-surface mark.kg-ref-mark");
  await expect(marks).toHaveCount(1);
  await expect(marks.first()).toHaveText("KPI");

  // Mark click → "그래프에서 보기": the panel graph opens focused on the node.
  await marks.first().click();
  await expect(page.getByTestId("panel-graph-surface")).toBeVisible();
  await expect(page.getByTestId("graph-focus-bar")).toContainText("Maru 용어집");
});

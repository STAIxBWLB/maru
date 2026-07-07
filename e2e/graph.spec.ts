import { expect, test, type Page } from "@playwright/test";

// Graph mode e2e (maru-vault-graph-spec §6). Runs in web mode (isTauri=false →
// mockEntries fixture: 2 markdown notes + 1 unresolved frontmatter wikilink).
// Enrichment (vault_graph_read) is Tauri-only, so this suite verifies the
// degraded live-layer path; the enriched path is covered by vitest
// (enrichGraph) + cargo (vault_graph) fixtures.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem("anchor:graph-e2e:storage-cleared") === "true") return;
    window.localStorage.clear();
    window.sessionStorage.setItem("anchor:graph-e2e:storage-cleared", "true");
  });
});

function watchForbiddenRequests(page: Page): string[] {
  const forbidden: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (
      url.includes("localhost:5500")
      || url.includes("fonts.googleapis.com")
      || url.includes("fonts.gstatic.com")
    ) {
      forbidden.push(url);
    }
  });
  return forbidden;
}

test("enters graph mode, shows degraded hint, and renders the live graph", async ({ page }) => {
  const forbidden = watchForbiddenRequests(page);
  await page.goto("/");

  await expect(page.getByRole("button", { name: "그래프" })).toBeVisible();
  await page.getByRole("button", { name: "그래프", exact: true }).click();
  await expect(page.getByTestId("graph-mode")).toBeVisible();

  // Web mode has no vault-graph.json → degraded hint, no communities badge.
  await expect(page.getByTestId("graph-degraded-hint")).toBeVisible();
  await expect(page.getByTestId("graph-filter-panel")).toBeVisible();

  // 2 resolved mock notes render as circles; the unresolved "[[Anchor
  // Project]]" ghost is hidden by default.
  await expect(page.getByTestId("graph-canvas")).toBeVisible();
  await expect(page.locator(".graph-node circle")).toHaveCount(2);

  // Show ghosts → the unresolved target appears.
  await page.getByLabel("미해소 링크 표시").check();
  await expect(page.locator(".graph-node circle")).toHaveCount(3);
  await expect(page.locator(".graph-node.ghost circle")).toHaveCount(1);

  expect(forbidden).toEqual([]);
});

test("type filter narrows nodes and node click opens the note in pkm", async ({ page }) => {
  const forbidden = watchForbiddenRequests(page);
  await page.goto("/");
  await page.getByRole("button", { name: "그래프", exact: true }).click();
  await expect(page.getByTestId("graph-mode")).toBeVisible();
  await expect(page.locator(".graph-node circle")).toHaveCount(2);

  // Type chip filter (mock notes: meeting + reference).
  const panel = page.getByTestId("graph-filter-panel");
  await panel.getByRole("button", { name: "reference", exact: true }).click();
  await expect(page.locator(".graph-node circle")).toHaveCount(1);
  await panel.getByRole("button", { name: "reference", exact: true }).click();
  await expect(page.locator(".graph-node circle")).toHaveCount(2);

  // Search focuses the matching node.
  await panel.getByRole("searchbox").fill("용어집");
  await expect(page.locator(".graph-node.focus circle")).toHaveCount(1);

  // Node click → pkm opens the note.
  await page.locator('.graph-node circle[data-node-id="anchor-glossary"]').click();
  await expect(page.getByTestId("graph-mode")).toHaveCount(0);
  await expect(page.getByText("Anchor 용어집").first()).toBeVisible();

  expect(forbidden).toEqual([]);
});

test("ghost node click seeds the note-creation dialog (F3b) and chain view toggles (F3c)", async ({
  page,
}) => {
  const forbidden = watchForbiddenRequests(page);
  await page.goto("/");
  await page.getByRole("button", { name: "그래프", exact: true }).click();
  await expect(page.getByTestId("graph-mode")).toBeVisible();

  // Decision-chain view — mock vault has no decisions → empty lanes message.
  await page.getByTestId("graph-chain-toggle").click();
  await expect(page.getByTestId("decision-chains")).toBeVisible();
  await expect(page.getByText("supersedes 연결이 있는 결정이 없습니다")).toBeVisible();
  await page.getByTestId("graph-chain-toggle").click();

  // Ghost click → NewDocumentDialog opens seeded with the unresolved target.
  await page.getByLabel("미해소 링크 표시").check();
  await expect(page.locator(".graph-node.ghost circle")).toHaveCount(1);
  await page.locator(".graph-node.ghost circle").click();
  const dialog = page.locator(".dialog-content", { hasText: "새 Anchor 문서" });
  await expect(dialog).toBeVisible();
  // Seeded with the unresolved wikilink target as the title prefill.
  await expect(dialog.getByRole("textbox").first()).toHaveValue(/Anchor Project/i);

  expect(forbidden).toEqual([]);
});

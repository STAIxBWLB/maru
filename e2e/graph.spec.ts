import { expect, test, type Page } from "@playwright/test";

// Graph mode e2e (maru-vault-graph-spec §6). Runs in web mode (isTauri=false →
// mockEntries fixture: 2 markdown notes + 1 unresolved frontmatter wikilink).
// Enrichment (vault_graph_read) is Tauri-only, so this suite verifies the
// degraded live-layer path; the enriched path is covered by vitest
// (enrichGraph) + cargo (vault_graph) fixtures.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem("maru:graph-e2e:storage-cleared") === "true") return;
    window.localStorage.clear();
    window.sessionStorage.setItem("maru:graph-e2e:storage-cleared", "true");
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

  // 2 resolved mock notes render as circles; the unresolved "[[Maru
  // Project]]" ghost is hidden by default.
  await expect(page.getByTestId("graph-canvas")).toBeVisible();
  await expect(page.locator(".graph-node circle")).toHaveCount(2);

  // Show ghosts → the unresolved target appears.
  await page.getByLabel("미해소 링크 표시").check();
  await expect(page.locator(".graph-node circle")).toHaveCount(3);
  await expect(page.locator(".graph-node.ghost circle")).toHaveCount(1);

  expect(forbidden).toEqual([]);
});

test("type filter narrows nodes; click selects, double-click opens the note", async ({ page }) => {
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

  // Search (in the toolbar) focuses the matching node.
  await page.getByTestId("graph-search").fill("용어집");
  await expect(page.locator(".graph-node.focus circle")).toHaveCount(1);

  // Single click selects (stays in graph, inspector shows the node).
  await page.locator('.graph-node circle[data-node-id="maru-glossary"]').click();
  await expect(page.getByTestId("graph-mode")).toBeVisible();
  await expect(page.locator(".graph-node.selected circle")).toHaveCount(1);

  // Double click opens the note in pkm.
  await page.locator('.graph-node circle[data-node-id="maru-glossary"]').dblclick();
  await expect(page.getByTestId("graph-mode")).toHaveCount(0);
  await expect(page.getByText("Maru 용어집").first()).toBeVisible();

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
  await page.getByTestId("graph-view-graph").click();

  // Ghost double-click → NewDocumentDialog opens seeded with the unresolved target.
  await page.getByLabel("미해소 링크 표시").check();
  await expect(page.locator(".graph-node.ghost circle")).toHaveCount(1);
  await page.locator(".graph-node.ghost circle").dblclick();
  const dialog = page.locator(".dialog-content", { hasText: "새 Maru 문서" });
  await expect(dialog).toBeVisible();
  // Seeded with the unresolved wikilink target as the title prefill.
  await expect(dialog.getByRole("textbox").first()).toHaveValue(/Maru Project/i);

  expect(forbidden).toEqual([]);
});

test("hover highlights the 1-hop neighborhood and dims the rest (imperative path)", async ({
  page,
}) => {
  const forbidden = watchForbiddenRequests(page);
  await page.goto("/");
  await page.getByRole("button", { name: "그래프", exact: true }).click();
  await expect(page.getByTestId("graph-mode")).toBeVisible();

  // The only edge in the mock vault runs meeting → ghost, so show ghosts to
  // give the meeting note a visible neighbor to highlight.
  await page.getByLabel("미해소 링크 표시").check();
  await expect(page.locator(".graph-node circle")).toHaveCount(3);

  // Hover the meeting node: it gets .hovered, its ghost neighbor gets .hl, and
  // the container gets .has-hover; the unrelated glossary node dims to 0.12.
  await page.locator('.graph-node circle[data-node-id="maru-weekly-meeting"]').hover();
  await expect(page.locator("svg.graph-canvas")).toHaveClass(/has-hover/);
  await expect(page.locator(".graph-node.hovered")).toHaveCount(1);
  await expect(page.locator(".graph-node.hl")).toHaveCount(1);
  await expect(
    page.locator('.graph-node:has(circle[data-node-id="maru-glossary"])'),
  ).toHaveCSS("opacity", "0.12");

  // Leaving the canvas clears the highlight (no lingering classes).
  await page.getByTestId("graph-filter-panel").hover();
  await expect(page.locator("svg.graph-canvas")).not.toHaveClass(/has-hover/);
  await expect(page.locator(".graph-node.hl")).toHaveCount(0);
  await expect(page.locator(".graph-node.hovered")).toHaveCount(0);

  expect(forbidden).toEqual([]);
});

test("dragging a node moves it (pin) without selecting; alt-click unpins", async ({ page }) => {
  const forbidden = watchForbiddenRequests(page);
  await page.goto("/");
  await page.getByRole("button", { name: "그래프", exact: true }).click();
  await expect(page.getByTestId("graph-mode")).toBeVisible();
  await expect(page.locator(".graph-node circle")).toHaveCount(2);

  const circle = page.locator('.graph-node circle[data-node-id="maru-glossary"]');
  const group = page.locator('.graph-node:has(circle[data-node-id="maru-glossary"])');
  // Wait for the worker's first frame to position the node.
  await expect(group).toHaveAttribute("transform", /translate/);
  const before = await group.getAttribute("transform");

  const box = await circle.boundingBox();
  if (!box) throw new Error("node has no bounding box");
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 90, cy + 40, { steps: 6 });
  await page.mouse.up();

  // Moved > 3px ⇒ a drag, not a click: the node relocates and is not selected.
  await expect(group).not.toHaveAttribute("transform", before ?? "");
  await expect(page.locator(".graph-node.selected")).toHaveCount(0);

  // Alt-click unpins (releases fx/fy) — smoke: it stays interactive, no crash.
  await page.keyboard.down("Alt");
  await circle.click();
  await page.keyboard.up("Alt");
  await expect(page.locator(".graph-node.selected")).toHaveCount(0);

  expect(forbidden).toEqual([]);
});

test("toolbar, insights panel, and inspector surfaces render and respond", async ({ page }) => {
  const forbidden = watchForbiddenRequests(page);
  await page.goto("/");
  await page.getByRole("button", { name: "그래프", exact: true }).click();
  await expect(page.getByTestId("graph-mode")).toBeVisible();

  // Toolbar + zoom cluster.
  await expect(page.getByTestId("graph-toolbar")).toBeVisible();
  const zoom = page.getByTestId("graph-zoom-value");
  await expect(zoom).toBeVisible();
  await page.getByRole("button", { name: "확대" }).click();
  await expect(zoom).toBeVisible();

  // Insights panel is the default right-pane tab.
  await expect(page.getByTestId("graph-insights")).toBeVisible();

  // Selecting a node flips the right pane to the inspector.
  await page.locator('.graph-node circle[data-node-id="maru-glossary"]').click();
  await expect(page.getByTestId("graph-inspector")).toBeVisible();
  await expect(page.getByTestId("graph-inspector")).toContainText("Maru 용어집");

  // Switch back to insights.
  await page.getByRole("tab", { name: "인사이트" }).click();
  await expect(page.getByTestId("graph-insights")).toBeVisible();

  expect(forbidden).toEqual([]);
});

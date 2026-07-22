import { expect, test, type Page } from "@playwright/test";

// Graph mode e2e (V5) — real-Sigma edition. Interactions are driven against
// the actual WebGL renderer via the dev-only window.__maruGraph bridge
// (localStorage "maru:e2e:graph-bridge" = "1", see graphBridge.ts): viewport
// points for mouse interactions, screen state for visual assertions, and
// freezeLayout() for determinism. Runs in web mode (isTauri=false →
// mockEntries fixture: 2 markdown notes + 1 unresolved frontmatter wikilink).

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem("maru:graph-e2e:storage-cleared") === "true") return;
    window.localStorage.clear();
    window.localStorage.setItem("maru:e2e:graph-bridge", "1");
    // readMaruSettings namespaces the web-mode fallback key by workPath
    // (mock://maru-sample-workspace in web mode — see fixtures.MOCK_WORKSPACE_PATH).
    window.localStorage.setItem(
      "maru:settings:fallback:v1:mock://maru-sample-workspace",
      // minVisibleNeighbors 0: the mock glossary note has no links, and the
      // default threshold of 1 would hide it, shifting every count below.
      JSON.stringify({
        graph: {
          schemaVersion: 2,
          source: "workspace",
          profiles: { workspace: { minVisibleNeighbors: 0 } },
        },
      }),
    );
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

interface Bridge {
  state(): string;
  containerSize(): { width: number; height: number };
  containerRect(): { x: number; y: number; width: number; height: number };
  frames(): number;
  camera(): { x: number; y: number; ratio: number };
  cameraAnimating(): boolean;
  nodeViewportPoint(id: string): { x: number; y: number } | null;
  nodeScreenState(id: string): {
    visible: boolean;
    size: number | null;
    color: string | null;
    borderColor: string | null;
    favorite: boolean;
  };
  hoveredId(): string | null;
  layoutRunning(): boolean;
  freezeLayout(): void;
  resumeLayout(): void;
  fitView(): void;
  simulateContextLost(): void;
  graphStats(): { nodes: number; edges: number; visibleNodes: number; visibleEdges: number };
}

// NOTE: page.evaluate serializes its return value — the bridge's methods do
// not survive the trip. Every helper must invoke bridge methods INSIDE
// evaluate; never return the bridge object itself.
const stats = (page: Page) =>
  page.evaluate(() => (window as unknown as { __maruGraph: Bridge }).__maruGraph.graphStats());
const cameraState = (page: Page) =>
  page.evaluate(() => (window as unknown as { __maruGraph: Bridge }).__maruGraph.camera());
const containerRect = (page: Page) =>
  page.evaluate(() => (window as unknown as { __maruGraph: Bridge }).__maruGraph.containerRect());
const hoveredId = (page: Page) =>
  page.evaluate(() => (window as unknown as { __maruGraph: Bridge }).__maruGraph.hoveredId());

/** Enter graph mode at the wide tier (filter panel + workbench docked), wait
 *  for the real renderer's first frame, then freeze FA2 for determinism. */
async function enterGraph(page: Page) {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/");
  await page.getByRole("button", { name: "그래프", exact: true }).click();
  await expect(page.getByTestId("graph-mode")).toBeVisible();
  await page.waitForFunction(
    () => {
      const bridge = (window as unknown as { __maruGraph?: Bridge }).__maruGraph;
      return bridge != null && bridge.frames() > 0;
    },
    undefined,
    { timeout: 15_000 },
  );
  await page.evaluate(() => {
    const bridge = (window as unknown as { __maruGraph: Bridge }).__maruGraph;
    // Freeze before FA2 scatters the seed positions, then re-fit the camera
    // to the now-static graph so viewport points are onscreen and stable.
    bridge.freezeLayout();
    bridge.fitView();
  });
}

async function nodePoint(page: Page, id: string): Promise<{ x: number; y: number }> {
  const point = await page.evaluate(
    (nodeId) => (window as unknown as { __maruGraph: Bridge }).__maruGraph.nodeViewportPoint(nodeId),
    id,
  );
  if (!point) throw new Error(`node "${id}" has no viewport point (missing or hidden)`);
  return point;
}

async function clickNode(page: Page, id: string, options?: { button?: "left" | "right"; modifiers?: ("Alt" | "Shift")[] }) {
  const point = await nodePoint(page, id);
  if (options?.modifiers) {
    for (const modifier of options.modifiers) await page.keyboard.down(modifier);
  }
  await page.mouse.click(point.x, point.y, { button: options?.button ?? "left" });
  if (options?.modifiers) {
    for (const modifier of options.modifiers) await page.keyboard.up(modifier);
  }
}

async function dblclickNode(page: Page, id: string, options?: { fit?: boolean }) {
  // Wait for the current camera transition and its render before resolving a
  // pixel coordinate. Only fit when the caller revealed a potentially
  // offscreen node; otherwise preserve the interaction being tested.
  const cameraStart = await page.evaluate((fit) => {
    const bridge = (window as unknown as { __maruGraph: Bridge }).__maruGraph;
    const frame = bridge.frames();
    if (fit) bridge.fitView();
    return { frame, animated: fit || bridge.cameraAnimating() };
  }, options?.fit === true);
  if (cameraStart.animated) {
    // Wait for the animation flag only. Node coordinates come from
    // graphToViewport (synchronous camera state), so no post-settle frame is
    // required — and demanding frames() > frame races the final animation
    // render: captured after it, no further frame ever comes and the wait
    // hangs (reproducible under heavy host load on a pristine checkout).
    await page.waitForFunction(
      () => !(window as unknown as { __maruGraph: Bridge }).__maruGraph.cameraAnimating(),
    );
  }
  const point = await nodePoint(page, id);
  // Real users move the pointer onto a node before double-clicking. Warming
  // Sigma's picking pass avoids Playwright's instantaneous pointer teleport
  // racing the hover/hit buffer.
  await page.mouse.move(point.x, point.y, { steps: 3 });
  await expect.poll(() => hoveredId(page)).toBe(id);
  await page.mouse.dblclick(point.x, point.y);
}

async function hoverNode(page: Page, id: string) {
  const point = await nodePoint(page, id);
  await page.mouse.move(point.x, point.y, { steps: 5 });
}

const screenState = (page: Page, id: string) =>
  page.evaluate(
    (nodeId) => (window as unknown as { __maruGraph: Bridge }).__maruGraph.nodeScreenState(nodeId),
    id,
  );

// Radix Tabs forceMount keeps BOTH workbench panels in the DOM — visibility
// assertions must scope to the non-hidden tab content.
const activeInspector = (page: Page) =>
  page.locator('.graph-right-content:not([hidden]) [data-testid="graph-inspector"]');

test("enters graph mode, shows degraded hint, and renders the live graph", async ({ page }) => {
  const forbidden = watchForbiddenRequests(page);
  await enterGraph(page);

  // Web mode has no vault-graph.json → degraded hint, no communities badge.
  await expect(page.getByTestId("graph-degraded-hint")).toBeVisible();
  await expect(page.getByTestId("graph-filter-panel")).toBeVisible();
  await expect(page.getByTestId("graph-canvas")).toBeVisible();

  // 2 resolved mock notes are visible; the unresolved "[[Maru Project]]"
  // ghost is hidden by default.
  expect((await stats(page)).visibleNodes).toBe(2);
  await expect.poll(() => screenState(page, "maru-glossary").then((s) => s.visible)).toBe(true);
  expect(await screenState(page, "maru-project")).toMatchObject({ visible: false });

  // Show ghosts → the unresolved target appears.
  await page.getByLabel("미해소 링크 표시").check();
  await expect.poll(async () => (await stats(page)).visibleNodes).toBe(3);
  await expect.poll(() => screenState(page, "maru-project").then((s) => s.visible)).toBe(true);

  expect(forbidden).toEqual([]);
});

test("type filter narrows nodes; click selects, double-click opens the note", async ({ page }) => {
  const forbidden = watchForbiddenRequests(page);
  await enterGraph(page);
  expect((await stats(page)).visibleNodes).toBe(2);

  // Type chip filter (mock notes: meeting + reference).
  const panel = page.getByTestId("graph-filter-panel");
  await panel.getByRole("button", { name: "reference", exact: true }).click();
  await expect.poll(async () => (await stats(page)).visibleNodes).toBe(1);
  await panel.getByRole("button", { name: "reference", exact: true }).click();
  await expect.poll(async () => (await stats(page)).visibleNodes).toBe(2);

  // Search combobox lists the match; Enter selects + centers it.
  await page.getByTestId("graph-search").fill("용어집");
  const results = page.getByTestId("graph-search-results");
  await expect(results).toBeVisible();
  await expect(results.getByRole("option")).toHaveCount(1);
  await page.getByTestId("graph-search").press("Enter");
  await expect(activeInspector(page)).toBeVisible();
  await expect(activeInspector(page)).toContainText("Maru 용어집");
  // Centered: the camera animation settles with the node near the viewport
  // center (page coordinates).
  await expect
    .poll(async () => {
      const [point, rect] = await Promise.all([nodePoint(page, "maru-glossary"), containerRect(page)]);
      return Math.max(
        Math.abs(point.x - (rect.x + rect.width / 2)) / rect.width,
        Math.abs(point.y - (rect.y + rect.height / 2)) / rect.height,
      );
    })
    .toBeLessThan(0.25);

  // Double click opens the note in pkm.
  await dblclickNode(page, "maru-glossary");
  await expect(page.getByTestId("graph-mode")).toHaveCount(0);
  await expect(page.getByText("Maru 용어집").first()).toBeVisible();

  expect(forbidden).toEqual([]);
});

test("ghost node click seeds the note-creation dialog (F3b) and chain view toggles (F3c)", async ({
  page,
}) => {
  const forbidden = watchForbiddenRequests(page);
  await enterGraph(page);

  // Decision-chain view — mock vault has no decisions → empty lanes message.
  await page.getByTestId("graph-chain-toggle").click();
  await expect(page.getByTestId("decision-chains")).toBeVisible();
  await expect(page.getByText("supersedes 연결이 있는 결정이 없습니다")).toBeVisible();
  await page.getByTestId("graph-view-graph").click();

  // Ghost double-click → NewDocumentDialog opens seeded with the unresolved target.
  await page.getByLabel("미해소 링크 표시").check();
  await expect.poll(() => screenState(page, "maru-project").then((s) => s.visible)).toBe(true);
  await dblclickNode(page, "maru-project", { fit: true });
  const dialog = page.locator(".dialog-content", { hasText: "새 Maru 문서" });
  await expect(dialog).toBeVisible();
  // Seeded with the unresolved wikilink target as the title prefill.
  await expect(dialog.getByRole("textbox").first()).toHaveValue(/Maru Project/i);

  expect(forbidden).toEqual([]);
});

test("hover highlights the 1-hop neighborhood and dims the rest", async ({ page }) => {
  const forbidden = watchForbiddenRequests(page);
  await enterGraph(page);

  // The only edge in the mock vault runs meeting → ghost, so show ghosts to
  // give the meeting note a visible neighbor to highlight.
  await page.getByLabel("미해소 링크 표시").check();
  await expect.poll(async () => (await stats(page)).visibleNodes).toBe(3);

  const glossaryBefore = await screenState(page, "maru-glossary");
  const ghostBefore = await screenState(page, "maru-project");

  // Hover the meeting node: the unrelated glossary dims, the ghost neighbor
  // keeps its color.
  await hoverNode(page, "maru-weekly-meeting");
  await expect
    .poll(() => hoveredId(page))
    .toBe("maru-weekly-meeting");
  const glossaryDimmed = await screenState(page, "maru-glossary");
  expect(glossaryDimmed.color).toBeTruthy();
  expect(glossaryDimmed.color).not.toBe(glossaryBefore.color);
  const ghostNeighbor = await screenState(page, "maru-project");
  expect(ghostNeighbor.color).toBe(ghostBefore.color);

  // Leaving the canvas clears the highlight.
  await page.getByTestId("graph-filter-panel").hover();
  await expect.poll(() => hoveredId(page)).toBe(null);
  const glossaryRestored = await screenState(page, "maru-glossary");
  expect(glossaryRestored.color).toBe(glossaryBefore.color);

  expect(forbidden).toEqual([]);
});

test("dragging a node moves it (pin) without selecting; alt-click unpins", async ({ page }) => {
  const forbidden = watchForbiddenRequests(page);
  await enterGraph(page);

  const before = await nodePoint(page, "maru-glossary");
  await page.mouse.move(before.x, before.y);
  await page.mouse.down();
  await page.mouse.move(before.x + 90, before.y + 40, { steps: 6 });
  await page.mouse.up();

  // Moved > 3px ⇒ a drag, not a click: the node relocates, camera untouched,
  // and nothing gets selected (inspector stays in the hidden tab).
  const after = await nodePoint(page, "maru-glossary");
  expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeGreaterThan(20);
  await expect(activeInspector(page)).toHaveCount(0);

  // Alt-click unpins (releases the fixed flag) — smoke: no crash, no select.
  await clickNode(page, "maru-glossary", { modifiers: ["Alt"] });
  await expect(activeInspector(page)).toHaveCount(0);

  expect(forbidden).toEqual([]);
});

test("search-as-filter narrows the graph to matches", async ({ page }) => {
  const forbidden = watchForbiddenRequests(page);
  await enterGraph(page);
  expect((await stats(page)).visibleNodes).toBe(2);

  // Off: search only highlights, count unchanged.
  await page.getByTestId("graph-search").fill("용어집");
  await expect.poll(async () => (await stats(page)).visibleNodes).toBe(2);

  // On: the graph narrows to the match (glossary is an orphan, so no neighbors).
  await page.getByTestId("graph-search-filter-toggle").click();
  await expect(page.getByTestId("graph-search-filter-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await stats(page)).visibleNodes).toBe(1);
  await expect.poll(() => screenState(page, "maru-glossary").then((s) => s.visible)).toBe(true);

  expect(forbidden).toEqual([]);
});

test("graph view/filter settings persist across a mode switch", async ({ page }) => {
  const forbidden = watchForbiddenRequests(page);
  await enterGraph(page);

  await page.getByTestId("graph-search-filter-toggle").click();
  await page.getByLabel("미해소 링크 표시").check();

  // Leave graph (open a note), then return via the activity rail.
  await dblclickNode(page, "maru-glossary");
  await expect(page.getByTestId("graph-mode")).toHaveCount(0);
  await page.getByRole("button", { name: "그래프", exact: true }).click();
  await expect(page.getByTestId("graph-mode")).toBeVisible();

  // Both settings survived (seeded from persisted MaruSettings).
  await expect(page.getByTestId("graph-search-filter-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("미해소 링크 표시")).toBeChecked();

  expect(forbidden).toEqual([]);
});

test("saved views restore the current profile and can be deleted", async ({ page }) => {
  const forbidden = watchForbiddenRequests(page);
  await enterGraph(page);

  await page.getByLabel("미해소 링크 표시").check();
  await expect.poll(async () => (await stats(page)).visibleEdges).toBe(1);

  await page.getByTestId("graph-saved-views").click();
  await page.getByLabel("보기 이름").fill("Ghost review");
  await page.getByTitle("현재 보기 저장").click();
  await expect(page.getByText("Ghost review", { exact: true })).toBeVisible();
  await page.getByTestId("graph-saved-views").click();

  await page.getByLabel("미해소 링크 표시").uncheck();
  await expect.poll(async () => (await stats(page)).visibleEdges).toBe(0);

  await page.getByTestId("graph-saved-views").click();
  await page.getByText("Ghost review", { exact: true }).click();
  await expect(page.getByLabel("미해소 링크 표시")).toBeChecked();
  await expect.poll(async () => (await stats(page)).visibleEdges).toBe(1);

  await page.getByTestId("graph-saved-views").click();
  await page.getByLabel("저장된 보기 삭제").click();
  await expect(page.getByText("저장된 보기가 없습니다")).toBeVisible();

  expect(forbidden).toEqual([]);
});

test("Neighborhood opens the exact note as a Local graph target", async ({ page }) => {
  const forbidden = watchForbiddenRequests(page);
  await enterGraph(page);

  await dblclickNode(page, "maru-glossary");
  await expect(page.getByTestId("graph-mode")).toHaveCount(0);
  const showOutline = page.getByRole("button", { name: "오른쪽 패널 보이기" });
  if (await showOutline.count()) await showOutline.click();
  await page.getByRole("tab", { name: "개요", exact: true }).click();
  const openLocal = page.getByRole("button", { name: "그래프에서 보기" });
  await expect(openLocal).toBeVisible();
  await openLocal.click();

  await expect(page.getByTestId("graph-mode")).toBeVisible();
  await expect(page.getByTestId("graph-focus-bar")).toContainText("Maru 용어집");
  await expect(page.getByTestId("graph-view-local")).toHaveAttribute("aria-selected", "true");

  expect(forbidden).toEqual([]);
});

test("right-click opens the node context menu; Escape closes it", async ({ page }) => {
  const forbidden = watchForbiddenRequests(page);
  await enterGraph(page);

  await clickNode(page, "maru-glossary", { button: "right" });
  const menu = page.getByTestId("graph-node-context-menu");
  await expect(menu).toBeVisible();
  await expect(menu).toContainText("Maru 용어집");

  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  expect(forbidden).toEqual([]);
});

test("favoriting a node from the inspector marks it on the canvas", async ({ page }) => {
  const forbidden = watchForbiddenRequests(page);
  await enterGraph(page);

  await clickNode(page, "maru-glossary");
  await expect(activeInspector(page)).toBeVisible();
  expect((await screenState(page, "maru-glossary")).favorite).toBe(false);

  // Favorite → the nodeReducer flags the node (the ★ label is canvas text;
  // the flag is the bridge-observable cue — border color is dominated by the
  // selection emphasis while the node stays selected).
  await page.getByTestId("graph-inspector-favorite").click();
  await expect
    .poll(() => screenState(page, "maru-glossary").then((s) => s.favorite))
    .toBe(true);

  await page.getByTestId("graph-inspector-favorite").click();
  await expect
    .poll(() => screenState(page, "maru-glossary").then((s) => s.favorite))
    .toBe(false);

  expect(forbidden).toEqual([]);
});

test("exports the current graph view as an SVG download", async ({ page }) => {
  const forbidden = watchForbiddenRequests(page);
  await enterGraph(page);
  await expect(page.getByTestId("graph-canvas")).toBeVisible();

  // Web mode → chooseSaveFile returns null → direct blob download. The export
  // action lives in the More menu since V5.
  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("graph-more-menu").click();
  await page.getByTestId("graph-export-svg").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^graph-\d{4}-\d{2}-\d{2}\.svg$/);

  expect(forbidden).toEqual([]);
});

test("GPU loss falls back to an interactive, exportable static graph", async ({ page }) => {
  const forbidden = watchForbiddenRequests(page);
  await enterGraph(page);

  await page.evaluate(() =>
    (window as unknown as { __maruGraph: Bridge }).__maruGraph.simulateContextLost(),
  );
  await expect(page.getByTestId("graph-gpu-recovery")).toBeVisible();
  await expect(page.locator("svg.graph-static-fallback")).toBeVisible({ timeout: 5_000 });

  const downloadPromise = page.waitForEvent("download");
  await page.getByTestId("graph-more-menu").click();
  await page.getByTestId("graph-export-svg").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^graph-\d{4}-\d{2}-\d{2}\.svg$/);

  expect(forbidden).toEqual([]);
});

test("enriched overlay renders the communities badge, legend, and color groups", async ({ page }) => {
  const forbidden = watchForbiddenRequests(page);
  // Opt into the mock community overlay (web mode has no vault-graph.json).
  // Registered after the beforeEach localStorage clear, so the flag survives.
  await page.addInitScript(() => {
    window.localStorage.setItem("maru:e2e:graph-overlay", "1");
  });
  await enterGraph(page);

  // Enriched → communities badge shown, no degraded hint.
  await expect(page.getByTestId("graph-enriched-badge")).toBeVisible();
  await expect(page.getByTestId("graph-degraded-hint")).toHaveCount(0);

  // Legend lists the two mock communities.
  const legend = page.getByTestId("graph-legend");
  await expect(legend).toBeVisible();
  await expect(legend.locator(".graph-legend-item")).toHaveCount(2);

  // Communities are color groups: the two mock notes sit in different
  // communities and must render with different node fills.
  const meeting = await screenState(page, "maru-weekly-meeting");
  const glossary = await screenState(page, "maru-glossary");
  expect(meeting.color).toBeTruthy();
  expect(glossary.color).toBeTruthy();
  expect(meeting.color).not.toBe(glossary.color);

  expect(forbidden).toEqual([]);
});

test("toolbar, insights panel, and inspector surfaces render and respond", async ({ page }) => {
  const forbidden = watchForbiddenRequests(page);
  await enterGraph(page);

  await expect(page.getByTestId("graph-toolbar")).toBeVisible();

  // Insights panel is the default workbench tab.
  await expect(page.getByTestId("graph-insights")).toBeVisible();

  // Selecting a node flips the workbench to the inspector. (Node clicks run
  // BEFORE the zoom check: zooming repositions nodes under the floating
  // overlays, which makes hit targets viewport-luck.)
  await clickNode(page, "maru-glossary");
  await expect(activeInspector(page)).toBeVisible();
  await expect(activeInspector(page)).toContainText("Maru 용어집");

  // Switch back to insights (Radix tabs keep role=tab).
  await page.getByRole("tab", { name: "인사이트" }).click();
  await expect(page.getByTestId("graph-insights")).toBeVisible();

  // Floating zoom cluster (zoom-in decreases the camera ratio).
  const zoom = page.getByTestId("graph-zoom-value");
  await expect(zoom).toBeVisible();
  const ratioBefore = (await cameraState(page)).ratio;
  await page.getByRole("button", { name: "확대" }).click();
  await expect.poll(async () => (await cameraState(page)).ratio).toBeLessThan(ratioBefore);

  expect(forbidden).toEqual([]);
});

test("dense vault (1,200 nodes) reaches first meaningful render within budget", async ({ page }) => {
  const forbidden = watchForbiddenRequests(page);
  await page.addInitScript(() => {
    window.localStorage.setItem("maru:e2e:graph-dense", "1");
  });
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/");
  const startedAt = Date.now();
  await page.getByRole("button", { name: "그래프", exact: true }).click();
  await expect(page.getByTestId("graph-mode")).toBeVisible();
  await page.waitForFunction(
    () => {
      const bridge = (window as unknown as { __maruGraph?: Bridge }).__maruGraph;
      return bridge != null && bridge.frames() > 0 && bridge.graphStats().visibleNodes > 0;
    },
    undefined,
    { timeout: 15_000 },
  );
  const elapsed = Date.now() - startedAt;
  const dense = await stats(page);
  expect(dense.nodes).toBe(1_200);
  expect(dense.visibleNodes).toBeGreaterThan(0);
  // Budget: 5s CI tolerance (SwiftShader software GL on shared runners; a
  // hardware-accelerated dev machine does this in ~1.5s).
  expect(elapsed).toBeLessThan(5_000);

  expect(forbidden).toEqual([]);
});

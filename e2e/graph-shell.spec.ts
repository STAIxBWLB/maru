import { expect, test, type Page } from "@playwright/test";

// Graph shell geometry regression (V5). The original bug: with a RIGHT-DOCKED
// terminal open, entering graph mode collapsed the shell grid (implicit
// column) and the sigma canvas mounted at zero size. These specs pin the
// geometry at several viewports and across terminal dock/resize/maximize.

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem("maru:graph-shell-e2e:cleared") === "true") return;
    window.localStorage.clear();
    window.localStorage.setItem("maru:e2e:graph-bridge", "1");
    window.sessionStorage.setItem("maru:graph-shell-e2e:cleared", "true");
  });
});

async function enterGraph(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "그래프", exact: true }).click();
  await expect(page.getByTestId("graph-mode")).toBeVisible();
}

async function expectShellGeometry(page: Page) {
  const view = page.locator(".graph-view");
  const viewBox = await view.boundingBox();
  expect(viewBox).not.toBeNull();
  if (!viewBox) return;
  expect(viewBox.width).toBeGreaterThan(420);
  expect(viewBox.height).toBeGreaterThan(0);

  // The sigma container (or the static fallback svg) fills the view.
  const canvasBox = await page.getByTestId("graph-canvas").boundingBox();
  expect(canvasBox).not.toBeNull();
  if (canvasBox) {
    expect(canvasBox.width).toBeGreaterThan(0);
    expect(canvasBox.height).toBeGreaterThan(0);
  }

  // No horizontal page overflow.
  const overflow = await page.evaluate(
    () => (document.scrollingElement?.scrollWidth ?? 0) > window.innerWidth,
  );
  expect(overflow).toBe(false);

  // Toolbar stays contained within .graph-view.
  const toolbarBox = await page.getByTestId("graph-toolbar").boundingBox();
  expect(toolbarBox).not.toBeNull();
  if (toolbarBox) {
    expect(toolbarBox.x).toBeGreaterThanOrEqual(viewBox.x - 1);
    expect(toolbarBox.x + toolbarBox.width).toBeLessThanOrEqual(viewBox.x + viewBox.width + 1);
  }
  const toolbarOverflow = await page.getByTestId("graph-toolbar").evaluate(
    (toolbar) => toolbar.scrollWidth > toolbar.clientWidth + 1,
  );
  expect(toolbarOverflow).toBe(false);

  // Legend (expanded or icon form, depending on tier) stays contained too.
  const legend = page.getByTestId("graph-legend");
  if (await legend.count()) {
    const legendBox = await legend.boundingBox();
    if (legendBox) {
      expect(legendBox.x).toBeGreaterThanOrEqual(viewBox.x - 1);
      expect(legendBox.x + legendBox.width).toBeLessThanOrEqual(viewBox.x + viewBox.width + 1);
      expect(legendBox.y + legendBox.height).toBeLessThanOrEqual(viewBox.y + viewBox.height + 1);
    }
  }
}

const VIEWPORTS = [
  { width: 1920, height: 1200 },
  { width: 1440, height: 920 },
  { width: 1280, height: 720 },
  { width: 1024, height: 720 },
];

for (const viewport of VIEWPORTS) {
  test(`graph shell holds geometry at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await enterGraph(page);
    await expectShellGeometry(page);
  });
}

async function runCommandPaletteAction(page: Page, label: string) {
  await page.locator(".topbar-command-action").click();
  const input = page.locator(".cmdk-input input");
  await expect(input).toBeVisible();
  await input.fill(label);
  await page.locator(".cmdk-item", { hasText: label }).click();
}

test("bottom-docked terminal keeps graph geometry", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.goto("/");
  await page.locator(".terminal-title").click();
  await expect(page.locator(".terminal-panel")).not.toHaveClass(/collapsed/);
  await expect(page.locator(".app-shell")).toHaveClass(/terminal-dock-bottom/);
  await page.getByRole("button", { name: "그래프", exact: true }).click();
  await expect(page.getByTestId("graph-mode")).toBeVisible();
  await expectShellGeometry(page);
});

test("right-docked terminal keeps the graph canvas alive (original bug)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.goto("/");
  await runCommandPaletteAction(page, "터미널을 오른쪽에 배치");
  await expect(page.locator(".app-shell")).toHaveClass(/terminal-dock-right/);

  await page.getByRole("button", { name: "그래프", exact: true }).click();
  await expect(page.getByTestId("graph-mode")).toBeVisible();

  const viewBox = await page.locator(".graph-view").boundingBox();
  expect(viewBox).not.toBeNull();
  if (!viewBox) return;
  // No implicit-column collapse: the graph view sits immediately after the
  // 48px activity rail and keeps the >= 420px canvas guarantee.
  expect(viewBox.x).toBeLessThan(60);
  expect(viewBox.width).toBeGreaterThanOrEqual(420);
  await expectShellGeometry(page);

  // Real renderer (when the bridge is up): container reports nonzero size.
  const bridgeSize = await page.evaluate(() => {
    const bridge = (window as unknown as {
      __maruGraph?: { containerSize(): { width: number; height: number } };
    }).__maruGraph;
    return bridge ? bridge.containerSize() : null;
  });
  if (bridgeSize) {
    expect(bridgeSize.width).toBeGreaterThan(0);
    expect(bridgeSize.height).toBeGreaterThan(0);
  }
});

test("right-docked terminal resize keeps the graph canvas minimum", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/");
  await runCommandPaletteAction(page, "터미널을 오른쪽에 배치");
  await expect(page.locator(".app-shell")).toHaveClass(/terminal-dock-right/);
  await page.getByRole("button", { name: "그래프", exact: true }).click();
  await expect(page.getByTestId("graph-mode")).toBeVisible();

  // Drag the terminal resize handle 200px wider (to the left).
  const handle = page.locator(".terminal-resize-handle").first();
  const handleBox = await handle.boundingBox();
  expect(handleBox).not.toBeNull();
  if (!handleBox) return;
  const cx = handleBox.x + handleBox.width / 2;
  const cy = handleBox.y + handleBox.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx - 200, cy, { steps: 8 });
  await page.mouse.up();

  // The shell clamps: graph view never drops below the 420px canvas minimum.
  const viewBox = await page.locator(".graph-view").boundingBox();
  expect(viewBox).not.toBeNull();
  if (viewBox) expect(viewBox.width).toBeGreaterThanOrEqual(420);
  await expectShellGeometry(page);
});

test("terminal maximize hides and restore revives the graph canvas", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 920 });
  await page.goto("/");
  await runCommandPaletteAction(page, "터미널을 오른쪽에 배치");
  await page.getByRole("button", { name: "그래프", exact: true }).click();
  await expect(page.getByTestId("graph-mode")).toBeVisible();

  await page.getByRole("button", { name: "터미널 최대화" }).click();
  await expect(page.locator(".app-shell")).toHaveClass(/terminal-maximized/);

  await page.getByRole("button", { name: "터미널 원래 크기로" }).click();
  await expect(page.locator(".app-shell")).not.toHaveClass(/terminal-maximized/);
  await expect(page.getByTestId("graph-mode")).toBeVisible();
  await expectShellGeometry(page);
});

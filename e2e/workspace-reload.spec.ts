import { expect, test } from "@playwright/test";

test("Cmd+R in a focused control reloads workspace without navigating the page", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  });
  await page.goto("/");
  await page.locator(".topbar-command-action").click();
  const input = page.locator(".cmdk-input input");
  await expect(input).toBeVisible();
  await input.fill("keep this query");
  await page.evaluate(() => {
    (window as Window & { workspaceReloadMarker?: object }).workspaceReloadMarker = { alive: true };
  });
  let navigations = 0;
  page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations++; });
  await input.press("Meta+r");
  await expect(input).toHaveValue("keep this query");
  expect(await page.evaluate(() => Boolean(
    (window as Window & { workspaceReloadMarker?: object }).workspaceReloadMarker,
  ))).toBe(true);
  expect(navigations).toBe(0);
});

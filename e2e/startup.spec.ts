import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
});

test("keeps the full terminal renderer out of the collapsed startup path", async ({
  page,
}) => {
  await page.goto("/?startupProfile=1");

  await expect(page.getByRole("button", { name: "Sample Workspace" })).toBeVisible();
  await expect(page.locator(".terminal-panel.collapsed")).toBeVisible();
  await expect(page.locator(".native-terminal-view")).toHaveCount(0);

  const marks = await page.evaluate(() =>
    (
      (window as Window & {
        __ANCHOR_STARTUP_PROFILE__?: { marks?: Array<{ name: string }> };
      }).__ANCHOR_STARTUP_PROFILE__?.marks ?? []
    ).map((mark) => mark.name),
  );
  expect(marks).toContain("workspace:first-usable");
  expect(marks).not.toContain("terminal:full-mount-request");
});

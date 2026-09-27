import { expect, test } from "@playwright/test";

test("adaptive policy remains opt-in and persists workload and automatic review", async ({ page }) => {
  await page.addInitScript(() => {
    if (!window.sessionStorage.getItem("adaptive-policy-test-initialized")) {
      window.localStorage.clear();
      window.sessionStorage.setItem("adaptive-policy-test-initialized", "true");
    }
  });
  await page.goto("/?window=settings&workPath=mock%3A%2F%2Fmaru-sample-workspace&tab=ai");
  const policy = page.getByRole("switch", { name: "작업별 실행 정책" });
  await expect(policy).not.toBeChecked();
  await policy.click();
  await page.locator("#ai-policy-workload").selectOption("independent-review");
  await page.locator("#ai-permission-mode").selectOption("auto-review");
  await expect.poll(() => page.evaluate(() => {
    const settings = JSON.parse(window.localStorage.getItem("maru:settings:fallback:v1:mock://maru-sample-workspace") ?? "{}");
    return { policy: settings.ai?.adaptivePolicy, permission: settings.ai?.permissionMode };
  })).toEqual({ policy: { enabled: true, workload: "independent-review" }, permission: "auto-review" });
  await page.reload();
  await expect(policy).toBeChecked();
  await expect(page.locator("#ai-policy-workload")).toHaveValue("independent-review");
  await expect(page.locator("#ai-permission-mode")).toHaveValue("auto-review");
});

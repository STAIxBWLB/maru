import { expect, test } from "@playwright/test";

const SETTINGS_URL = "/?window=settings&workPath=mock%3A%2F%2Fmaru-sample-workspace&tab=agents";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (window.sessionStorage.getItem("maru:e2e:storage-cleared") === "true") return;
    window.localStorage.clear();
    window.sessionStorage.setItem("maru:e2e:storage-cleared", "true");
  });
});

test("deep link selects the agents tab and shows the four agent sub-tabs", async ({
  page,
}) => {
  await page.goto(SETTINGS_URL);

  await expect(page.getByRole("tab", { name: "에이전트" })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  const subtabs = page.locator(".agents-subtabs");
  await expect(subtabs).toBeVisible();
  await expect(subtabs.getByRole("tab")).toHaveCount(4);
  await expect(subtabs.getByRole("tab", { name: "Claude Code" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(subtabs.getByRole("tab", { name: "Codex" })).toBeVisible();
  await expect(subtabs.getByRole("tab", { name: "Kimi" })).toBeVisible();
  await expect(subtabs.getByRole("tab", { name: "Kiro" })).toBeVisible();
});

test("claude sub-tab shows the connected badge and account details from the mock", async ({
  page,
}) => {
  await page.goto(SETTINGS_URL);

  const authSection = page.locator(".agents-section", { hasText: "인증" }).first();
  await expect(authSection.locator(".agents-badge.connected")).toHaveText("연결됨");

  const accountTable = authSection.locator(".agents-account-table");
  await expect(accountTable).toContainText("버전");
  await expect(accountTable).toContainText("2.1.220");
  await expect(accountTable).toContainText("Anthropic");
  await expect(accountTable).toContainText("jeju.ai");
  await expect(accountTable).toContainText("hello@jeju.ai");

  await expect(
    page.getByRole("button", { name: "claude auth login 실행" }),
  ).toBeVisible();

  const usageSection = page.locator(".agents-section", { hasText: "사용량" }).first();
  await expect(usageSection).toContainText("19% 사용");
  await expect(usageSection).toContainText("89% 사용");
});

test("kiro sub-tab shows the unauthenticated state", async ({ page }) => {
  await page.goto(SETTINGS_URL);

  await page.locator(".agents-subtabs").getByRole("tab", { name: "Kiro" }).click();

  const authSection = page.locator(".agents-section", { hasText: "인증" }).first();
  await expect(authSection.locator(".agents-badge")).toHaveText("연결 안 됨");
  await expect(authSection.locator(".agents-badge.connected")).toHaveCount(0);
  await expect(authSection).toContainText("Not logged in.");

  const usageSection = page.locator(".agents-section", { hasText: "사용량" }).first();
  await expect(usageSection).toContainText("이 에이전트는 사용량 조회를 지원하지 않습니다.");
});

test("launch command override persists across reload via the settings fallback", async ({
  page,
}) => {
  await page.goto(SETTINGS_URL);

  const overrideField = page.locator("label.field", { hasText: "명령 재정의" });
  const overrideInput = overrideField.locator("input");
  await expect(overrideInput).toBeVisible();
  await expect(page.locator("label.field", { hasText: "추가 인자" })).toBeVisible();

  await overrideInput.fill("/opt/claude/bin/claude");
  await overrideInput.blur();

  await expect
    .poll(() =>
      page.evaluate(() => {
        const raw = window.localStorage.getItem(
          "maru:settings:fallback:v1:mock://maru-sample-workspace",
        );
        if (!raw) return null;
        const settings = JSON.parse(raw) as {
          ai?: { commandOverrides?: Record<string, string | null> };
          terminal?: {
            launchers?: Record<string, { command?: string | null }>;
          };
        };
        return {
          ai: settings.ai?.commandOverrides?.claude ?? null,
          terminal: settings.terminal?.launchers?.claude?.command ?? null,
        };
      }),
    )
    .toEqual({
      ai: "/opt/claude/bin/claude",
      terminal: "/opt/claude/bin/claude",
    });

  await page.reload();
  await expect(page.getByRole("tab", { name: "에이전트" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.locator("label.field", { hasText: "명령 재정의" }).locator("input"),
  ).toHaveValue("/opt/claude/bin/claude");
});

test("main window footer renders agent usage chips from the mock", async ({ page }) => {
  await page.goto("/");

  const bar = page.locator(".agent-usage-bar");
  await expect(bar).toBeVisible();

  const claudeChip = bar.locator(".agent-usage-chip", { hasText: "Claude Code" });
  await expect(claudeChip).toContainText("19%");
  await expect(claudeChip).toContainText("89%");

  const codexChip = bar.locator(".agent-usage-chip", { hasText: "Codex" });
  await expect(codexChip).toContainText("5%");

  await expect(
    bar.getByRole("button", { name: "사용량 새로고침" }),
  ).toBeVisible();
});

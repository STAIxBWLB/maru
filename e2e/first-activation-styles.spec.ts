import { expect, test, type Page } from "@playwright/test";

/**
 * PERF-05 first-activation FOUC guard.
 *
 * One Playwright test = one browser context = one genuine first activation.
 * Each test starts on the default `문서` (pkm) mode, switches to the target
 * mode exactly once, and polls the mode's root surface until its lazy CSS has
 * landed (Vite cssCodeSplit ships mode CSS inside the lazy JS chunk that
 * `scheduleModePreload()` fetched during idle time).
 *
 * A regression where a mode's stylesheet is missing at first activation
 * fails here: the root surface renders unpainted (body background only) or
 * with a non-Pretendard fallback font.
 */

const MODES = [
  { label: "스크래치패드", root: ".scratchpad-workspace" },
  { label: "파일", root: ".files-workbench" },
  { label: "인박스", root: ".inbox-pane" },
  { label: "메시지", root: ".comms-pane" },
  { label: "회의록", root: ".meetings-pane" },
  { label: "오늘", root: ".today-pane" },
  { label: "태스크", root: ".tasks-pane" },
  { label: "대시보드", root: ".dashboard-pane" },
  { label: "아이디어", root: ".drafts-pane" },
  { label: "갭 분석", root: ".gap-pane" },
  { label: "에이전트", root: ".agents-pane" },
  { label: "카탈로그", root: ".catalog-pane" },
  { label: "스튜디오", root: ".studio-pane" },
  { label: "사이트", root: ".sites-pane" },
  { label: "그래프", root: ".graph-view" },
  { label: "다이어그램", root: ".maru-diagram" },
] as const;

/** Toggle one non-default mode on from a fresh first activation. */
async function activateMode(page: Page, label: string) {
  await page.locator(".activity-rail").getByRole("button", { name: label, exact: true }).click();
}

/** Poll a root surface until its mode stylesheet has painted. */
async function expectModeSurfaceStyled(page: Page, root: string) {
  await expect
    .poll(
      async () => {
        const style = await page.locator(root).first().evaluate((element) => {
          const computed = getComputedStyle(element);
          return {
            display: computed.display,
            backgroundColor: computed.backgroundColor,
            backgroundImage: computed.backgroundImage,
            fontFamily: computed.fontFamily,
          };
        });
        // Gradient panes (today/meetings/tasks/dashboard/e2e) keep a
        // transparent computed background-color; their paint is background-image.
        const painted =
          style.backgroundColor !== "rgba(0, 0, 0, 0)" || style.backgroundImage !== "none";
        if (
          style.display !== "none" &&
          painted &&
          style.fontFamily.includes("Pretendard Variable")
        ) {
          return "styled";
        }
        return JSON.stringify(style);
      },
      { timeout: 8_000 },
    )
    .toBe("styled");
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
});

test.describe("colorScheme: light", () => {
  test.use({ colorScheme: "light" });

  test("default 문서 workbench paints on first activation", async ({ page }) => {
    await page.goto("/");

    await expectModeSurfaceStyled(page, ".editor-pane");
    await expect(page.locator(".document-list").first()).toBeVisible();
  });

  for (const mode of MODES) {
    test(`${mode.label} (${mode.root}) paints on first activation`, async ({ page }) => {
      await page.goto("/");
      await activateMode(page, mode.label);
      await expect(page.locator(mode.root).first()).toBeAttached();
      await expectModeSurfaceStyled(page, mode.root);
    });
  }

  test("e2e 플로우 paints on first activation via its enablement hook", async ({ page }) => {
    await page.goto("/?maru-e2e=1");
    await activateMode(page, "E2E 플로우");
    await expect(page.locator(".e2e-pane").first()).toBeAttached();
    await expectModeSurfaceStyled(page, ".e2e-pane");
  });

  test("first activation ships the .mode-loading fallback rule", async ({ page }) => {
    await page.goto("/");

    const hasModeLoadingRule = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        let rules: CSSRuleList;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        for (const rule of rules) {
          if (rule instanceof CSSStyleRule && rule.selectorText?.includes("mode-loading")) {
            return true;
          }
        }
      }
      return false;
    });
    expect(hasModeLoadingRule).toBe(true);
  });

  test("empty-state stays single-homed in styles.css on first activation", async ({ page }) => {
    await page.goto("/");
    await activateMode(page, "갭 분석");

    await expect
      .poll(
        async () =>
          page
            .locator(".gap-pane .empty-state")
            .first()
            .evaluate((element) => {
              const style = getComputedStyle(element);
              return {
                display: style.display,
                minHeight: style.minHeight,
                padding: style.padding,
                gap: style.gap,
              };
            }),
        { timeout: 8_000 },
      )
      .toEqual({
        display: "grid",
        minHeight: "104px",
        padding: "20px",
        gap: "6px",
      });
  });
});

test.describe("colorScheme: dark", () => {
  test.use({ colorScheme: "dark" });

  test("default 문서 workbench paints on first activation in dark", async ({ page }) => {
    await page.goto("/");

    await expectModeSurfaceStyled(page, ".editor-pane");
  });

  for (const mode of MODES) {
    test(`${mode.label} (${mode.root}) paints on first activation in dark`, async ({ page }) => {
      await page.goto("/");
      await activateMode(page, mode.label);
      await expect(page.locator(mode.root).first()).toBeAttached();
      await expectModeSurfaceStyled(page, mode.root);
    });
  }

  test("first activation ships the .mode-loading fallback rule in dark", async ({ page }) => {
    await page.goto("/");

    const hasModeLoadingRule = await page.evaluate(() => {
      for (const sheet of document.styleSheets) {
        let rules: CSSRuleList;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        for (const rule of rules) {
          if (rule instanceof CSSStyleRule && rule.selectorText?.includes("mode-loading")) {
            return true;
          }
        }
      }
      return false;
    });
    expect(hasModeLoadingRule).toBe(true);
  });
});

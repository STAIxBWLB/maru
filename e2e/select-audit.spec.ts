// Guards the shared <select> base style in src/styles.css. It is easy to undo
// by accident: any scoped rule that sets the `background` shorthand resets the
// chevron image away while the reserved padding stays, which is the exact bug
// this style was added to fix.
import { expect, test, type Page } from "@playwright/test";

interface SelectAudit {
  cls: string;
  appearance: string;
  hasImage: boolean;
  paddingRight: number;
}

async function auditSelects(page: Page): Promise<SelectAudit[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("select")).map((el) => {
      const cs = getComputedStyle(el);
      return {
        cls: el.className || el.getAttribute("aria-label") || "(unnamed)",
        appearance: cs.appearance,
        hasImage: cs.backgroundImage !== "none",
        paddingRight: parseFloat(cs.paddingRight),
      };
    }),
  );
}

// Audit every rail entry across independent pages: lazy-loading all modes in
// one test couples the style guard to the total cold-start time of the app.
for (let batch = 0; batch < 4; batch += 1) {
  test(`every select shares the base chrome (batch ${batch + 1})`, async ({ page }) => {
    const rows: SelectAudit[] = [];
    await page.goto("/");
    await expect(page.locator(".activity-rail")).toBeVisible();
    await expect(page.locator(".mode-loading")).toHaveCount(0);
    rows.push(...(await auditSelects(page)));

    const rail = page.locator(".activity-bar, .activity-rail");
    // Contextual rail buttons change position across modes. Preserve identity
    // rather than reusing nth locators against a changing button collection.
    const labels = await rail.locator(".activity-button").evaluateAll((buttons) =>
      buttons.map((button) => button.getAttribute("aria-label")).filter(Boolean),
    );
    for (const label of labels.filter((_, index) => index % 4 === batch)) {
      if (!label) continue;
      try {
        await rail.getByRole("button", { name: label, exact: true }).click({ timeout: 2000 });
        await expect(page.locator(".mode-loading")).toHaveCount(0);
        rows.push(...(await auditSelects(page)));
      } catch {
        /* mode unavailable in browser mode */
      } finally {
        // A command palette must not block the remaining style samples.
        await page.keyboard.press("Escape");
      }
    }

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.appearance, `${row.cls} must drop the native popup chrome`).toBe("none");
      expect(row.hasImage, `${row.cls} lost its chevron to a background shorthand`).toBe(true);
      // 12px glyph inset 9px from the right edge.
      expect(row.paddingRight, `${row.cls} has no room for the chevron`).toBeGreaterThanOrEqual(21);
    }
  });
}

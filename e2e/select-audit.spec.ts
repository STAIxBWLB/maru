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

test("every select shares the base chrome", async ({ page }) => {
  const rows: SelectAudit[] = [];
  await page.goto("/");
  await page.waitForTimeout(2500);
  rows.push(...(await auditSelects(page)));

  const buttons = await page.locator(".activity-bar button, .activity-rail button").all();
  for (let i = 0; i < buttons.length; i += 1) {
    try {
      await buttons[i].click({ timeout: 2000 });
      await page.waitForTimeout(800);
      rows.push(...(await auditSelects(page)));
    } catch {
      /* mode unavailable in browser mode */
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

import type { Page } from "@playwright/test";

export async function rightWorkbenchLabel(page: Page, label: string): Promise<string> {
  const modifier = await page.evaluate(() =>
    navigator.platform.toLowerCase().includes("mac") ? "Option" : "Alt",
  );
  return `${label} 오른쪽에 열기 (${modifier}-click)`;
}

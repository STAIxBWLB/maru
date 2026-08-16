import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outputDirectory = resolve(here, "renders");

await mkdir(outputDirectory, { recursive: true });

const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({
    viewport: { width: 1800, height: 1400 },
    deviceScaleFactor: 1,
  });

  await page.goto(pathToFileURL(resolve(here, "preview.html")).href);
  await page.evaluate(() => document.fonts.ready);

  await page.screenshot({
    path: resolve(outputDirectory, "maru-seal-options.png"),
    fullPage: true,
  });

  for (const option of ["a", "b", "c"]) {
    await page.locator(`#option-${option}`).screenshot({
      path: resolve(outputDirectory, `maru-seal-${option}-context.png`),
    });

    for (const variant of ["full", "micro"]) {
      const iconPage = await browser.newPage({
        viewport: { width: variant === "full" ? 512 : 128, height: variant === "full" ? 512 : 128 },
        deviceScaleFactor: 1,
      });
      const source = {
        a: `a-traditional-${variant}.svg`,
        b: `b-refined-${variant}.svg`,
        c: `c-modern-${variant}.svg`,
      }[option];

      await iconPage.setContent(
        `<style>html,body{margin:0;background:transparent}img{display:block;width:100vw;height:100vh}</style>` +
          `<img src="${pathToFileURL(resolve(here, source)).href}" alt="">`,
      );
      await iconPage.locator("img").waitFor();
      await iconPage.screenshot({
        path: resolve(outputDirectory, `maru-seal-${option}-${variant}.png`),
        omitBackground: true,
      });
      await iconPage.close();
    }
  }
} finally {
  await browser.close();
}

console.log(`Rendered Maru seal alternatives to ${outputDirectory}`);

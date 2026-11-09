import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

const S1_ARCHITECTURE_SVG_SHA256 = "3317383217e8f59e8099685cdf53926a7de5e31f201b7c04b4b53fa2e5313f5f";
const S1_ARCHITECTURE_SPEC_SHA256 = "ae9c9e83ca21229ed77c250e246a7d49d1f05b0899b05ca12db7e7e378a5edc3";
const SVG_FIXTURE = resolve("src/lib/diagram/viewer/__fixtures__/architecture-light.svg");
const SPEC_FIXTURE = resolve("src/lib/diagram/viewer/__fixtures__/architecture-light.spec.json");
const hostileLabel = "<!--<script>globalThis.__offlineViewerPwned=1</script><img src=x onerror=alert(1)>";

function viewBoxNumbers(value: string | null): number[] {
  return (value ?? "").trim().split(/[ ,]+/).map(Number);
}

test.describe("standalone engine diagram viewer", () => {
  test.describe.configure({ retries: 0 });

  test("opens a file:// artifact offline and supports pointer, wheel and keyboard controls", async ({ page }) => {
    const svg = readFileSync(SVG_FIXTURE, "utf8");
    expect(createHash("sha256").update(svg).digest("hex")).toBe(S1_ARCHITECTURE_SVG_SHA256);
    expect(createHash("sha256").update(readFileSync(SPEC_FIXTURE)).digest("hex")).toBe(S1_ARCHITECTURE_SPEC_SHA256);
    const temp = mkdtempSync(join(tmpdir(), "maru-offline-viewer-"));
    const filePath = join(temp, "viewer.html");
    const buildOutput = execFileSync(process.execPath, [
      join(process.cwd(), "scripts/build-diagram-viewer.mjs"),
      SVG_FIXTURE,
      SPEC_FIXTURE,
      filePath,
    ], { encoding: "utf8" });
    expect(buildOutput).toContain("OFFLINE_DIAGRAM_VIEWER");
    const fileUrl = pathToFileURL(filePath).href;
    const attempts: string[] = [];
    try {
      await page.route("**/*", async (route) => {
        const url = route.request().url();
        if (url === fileUrl) {
          await route.continue();
          return;
        }
        attempts.push(url);
        await route.abort();
      });
      page.on("request", (request) => {
        if (request.url() !== fileUrl) attempts.push(request.url());
      });
      await page.setViewportSize({ width: 1200, height: 800 });
      await page.goto(fileUrl);
      const viewport = page.locator("#viewport");
      const svgRoot = page.locator("#stage > svg");
      const status = page.locator("#selection");
      await expect(svgRoot).toBeVisible();
      await expect(page.locator("#offline-viewer-source")).toHaveAttribute("type", "application/json");
      await expect(page.locator("script")).toHaveCount(2);
      await expect(page.locator("img")).toHaveCount(0);

      const embedded = await page.locator("#offline-viewer-source").evaluate((script) => JSON.parse(script.textContent ?? "{}"));
      expect(embedded.components[0].label).toBe("입력");
      expect(await page.evaluate(() => (window as Window & { __offlineViewerPwned?: number }).__offlineViewerPwned)).toBeUndefined();

      const node = page.locator('svg [data-kind="node"][data-source-id="a"]');
      await node.click({ force: true });
      await expect(status).toContainText("node a - 입력");
      await expect(node).toHaveAttribute("data-viewer-selected", "true");
      await expect(page.locator("img")).toHaveCount(0);

      const route = page.locator('svg [data-kind="route"]').first();
      await route.click({ force: true });
      await expect(status).toContainText("edge connection:0");
      await expect(status).toContainText("Call");
      await page.locator('svg [data-kind="label"][data-target-id="a"] text[data-kind="label-text"]').click({ force: true });
      await expect(status).toContainText("node a - 입력");

      await page.getByRole("button", { name: "Fit diagram" }).click();
      const initialViewBox = await svgRoot.getAttribute("viewBox");
      const area = await viewport.boundingBox();
      expect(area).not.toBeNull();
      await page.mouse.move(area!.x + area!.width - 12, area!.y + area!.height - 12);
      await page.mouse.down();
      await page.mouse.move(area!.x + area!.width - 42, area!.y + area!.height - 42, { steps: 4 });
      await page.mouse.up();
      const pannedViewBox = await svgRoot.getAttribute("viewBox");
      expect(pannedViewBox).not.toBe(initialViewBox);

      await page.getByRole("button", { name: "Fit diagram" }).click();
      const beforeWheel = viewBoxNumbers(await svgRoot.getAttribute("viewBox"));
      await page.mouse.move(area!.x + area!.width / 2, area!.y + area!.height / 2);
      await page.mouse.wheel(0, -240);
      const afterWheel = viewBoxNumbers(await svgRoot.getAttribute("viewBox"));
      expect(afterWheel[2]).toBeLessThan(beforeWheel[2]!);
      await expect(page.locator("#zoom-level")).toHaveText(/\d+%/);

      await viewport.focus();
      const beforeKeyPan = viewBoxNumbers(await svgRoot.getAttribute("viewBox"));
      await page.keyboard.press("ArrowRight");
      const afterKeyPan = viewBoxNumbers(await svgRoot.getAttribute("viewBox"));
      expect(afterKeyPan[0]).toBeGreaterThan(beforeKeyPan[0]!);
      await page.keyboard.press("Home");
      expect(await svgRoot.getAttribute("viewBox")).toBe(initialViewBox);
      const beforeKeyZoom = viewBoxNumbers(await svgRoot.getAttribute("viewBox"));
      await page.keyboard.press("+");
      const afterKeyZoom = viewBoxNumbers(await svgRoot.getAttribute("viewBox"));
      expect(afterKeyZoom[2]).toBeLessThan(beforeKeyZoom[2]!);
      await page.keyboard.press("Home");
      await node.focus();
      await page.keyboard.press("Enter");
      await expect(status).toContainText("node a - 입력");
      await page.keyboard.press("Escape");
      await expect(status).toContainText("Click a node or route");
      expect(attempts).toEqual([]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test("keeps a hostile source label inert and displays the label from the engine SVG", async ({ page }) => {
    const source = JSON.parse(readFileSync(SPEC_FIXTURE, "utf8"));
    source.components[0].label = hostileLabel;
    const temp = mkdtempSync(join(tmpdir(), "maru-offline-hostile-spec-"));
    const specPath = join(temp, "hostile.json");
    const filePath = join(temp, "viewer.html");
    writeFileSync(specPath, JSON.stringify(source), "utf8");
    const buildOutput = execFileSync(process.execPath, [
      join(process.cwd(), "scripts/build-diagram-viewer.mjs"), SVG_FIXTURE, specPath, filePath,
    ], { encoding: "utf8" });
    expect(buildOutput).toContain("OFFLINE_DIAGRAM_VIEWER");
    const fileUrl = pathToFileURL(filePath).href;
    const attempts: string[] = [];
    try {
      await page.route("**/*", async (route) => {
        const url = route.request().url();
        if (url === fileUrl) {
          await route.continue();
          return;
        }
        attempts.push(url);
        await route.abort();
      });
      page.on("request", (request) => {
        if (request.url() !== fileUrl) attempts.push(request.url());
      });
      await page.goto(fileUrl);
      await page.locator('svg [data-kind="node"][data-source-id="a"]').click({ force: true });
      await expect(page.locator("#selection")).toContainText("node a - 입력");
      const embedded = await page.locator("#offline-viewer-source").evaluate((script) => JSON.parse(script.textContent ?? "{}"));
      expect(embedded.components[0].label).toBe(hostileLabel);
      await expect(page.locator("img")).toHaveCount(0);
      await expect(page.locator("script")).toHaveCount(2);
      expect(await page.evaluate(() => (window as Window & { __offlineViewerPwned?: number }).__offlineViewerPwned)).toBeUndefined();
      expect(attempts).toEqual([]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test("refuses a non-engine SVG before writing an offline viewer file", () => {
    const realSvg = readFileSync(SVG_FIXTURE, "utf8");
    const hostileSvg = realSvg.replace("</svg>", "<a href=\"https://example.invalid\">open</a></svg>");
    const temp = mkdtempSync(join(tmpdir(), "maru-offline-hostile-svg-"));
    const svgPath = join(temp, "hostile.svg");
    const outputPath = join(temp, "viewer.html");
    writeFileSync(svgPath, hostileSvg, "utf8");
    try {
      expect(() => execFileSync(process.execPath, [
        join(process.cwd(), "scripts/build-diagram-viewer.mjs"), svgPath, SPEC_FIXTURE, outputPath,
      ], { encoding: "utf8" })).toThrow(/refused the source SVG/i);
      expect(existsSync(outputPath)).toBe(false);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

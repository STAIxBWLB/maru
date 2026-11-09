import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";

const S1_ARCHITECTURE_SVG_SHA256 = "3317383217e8f59e8099685cdf53926a7de5e31f201b7c04b4bfa2e5313f5f";
const SVG_FIXTURE = new URL("../src/lib/diagram/viewer/__fixtures__/architecture-light.svg", import.meta.url);
const hostileLabel = "</script><script>globalThis.__offlineViewerPwned=1</script><img src=x onerror=alert(1)>";

function matchingSpec(): string {
  // Mirrors the screenshot fixture's architecture seed and its CJK label edits.
  return JSON.stringify({
    schema_version: 1,
    diagram_type: "architecture",
    meta: {
      title: "Maru offline viewer fixture",
      subtitle: "S1 engine SVG fixture",
      output: "fixture.html",
    },
    layout: { mode: "grid", cols: 4 },
    components: [
      { id: "a", type: "frontend", label: hostileLabel, row: 0, col: 0 },
      { id: "b", type: "backend", label: "처리", row: 0, col: 1 },
    ],
    connections: [{ from: "a", to: "b", label: "Call" }],
  });
}

function viewBoxNumbers(value: string | null): number[] {
  return (value ?? "").trim().split(/[ ,]+/).map(Number);
}

test.describe("standalone engine diagram viewer", () => {
  test.describe.configure({ retries: 0 });

  test("opens a file:// artifact offline and supports pointer, wheel and keyboard controls", async ({ page }) => {
    const svg = readFileSync(SVG_FIXTURE, "utf8");
    expect(createHash("sha256").update(svg).digest("hex")).toBe(S1_ARCHITECTURE_SVG_SHA256);
    const temp = mkdtempSync(join(tmpdir(), "maru-offline-viewer-"));
    const specPath = join(temp, "diagram.json");
    const filePath = join(temp, "viewer.html");
    writeFileSync(specPath, matchingSpec(), "utf8");
    const buildOutput = execFileSync(process.execPath, [
      join(process.cwd(), "scripts/build-diagram-viewer.mjs"),
      fileURLToPath(SVG_FIXTURE),
      specPath,
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
      expect(embedded.components[0].label).toBe(hostileLabel);
      expect(await page.evaluate(() => (window as Window & { __offlineViewerPwned?: number }).__offlineViewerPwned)).toBeUndefined();

      const node = page.locator('svg [data-kind="node"][data-source-id="a"]');
      await node.click({ force: true });
      await expect(status).toContainText("node a");
      await expect(status).toContainText(hostileLabel);
      await expect(node).toHaveAttribute("data-viewer-selected", "true");
      await expect(page.locator("img")).toHaveCount(0);

      const route = page.locator('svg [data-kind="route"]').first();
      await route.click({ force: true });
      await expect(status).toContainText("edge connection:0");
      await expect(status).toContainText("Call");

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
      await expect(status).toContainText("node a");
      await page.keyboard.press("Escape");
      await expect(status).toContainText("Click a node or route");
      expect(attempts).toEqual([]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});

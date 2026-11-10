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

  test("clicks colliding node and edge labels using their source identity in a synthetic S1-derived file", async ({ page }) => {
    // Synthetic collision derived from the pinned S1 SVG: retain its geometry
    // and replace only node/edge identity metadata and the matching source IDs.
    const svg = readFileSync(SVG_FIXTURE, "utf8")
      .replace('data-source-id="a" role="group" aria-label="입력 (frontend)"', 'data-source-id="shared" role="group" aria-label="입력 (frontend)"')
      .replace('data-source-id="id:connection:0" role="group" aria-label="a → b"', 'data-source-id="id:shared" role="group" aria-label="a → b"')
      .replace('data-source-id="id:node:a:label" data-target-id="a"', 'data-source-id="id:node:shared:label" data-target-id="shared"')
      .replace('data-source-id="id:edge:connection:0:label" data-target-id="connection:0"', 'data-source-id="id:edge:shared:label" data-target-id="shared"');
    const spec = JSON.parse(readFileSync(SPEC_FIXTURE, "utf8"));
    spec.components[0].id = "shared";
    spec.connections[0].id = "shared";
    spec.connections[0].from = "shared";
    const temp = mkdtempSync(join(tmpdir(), "maru-offline-viewer-shared-id-"));
    const svgPath = join(temp, "synthetic-s1.svg");
    const specPath = join(temp, "synthetic-s1.json");
    const filePath = join(temp, "viewer.html");
    writeFileSync(svgPath, svg, "utf8");
    writeFileSync(specPath, JSON.stringify(spec), "utf8");
    const buildOutput = execFileSync(process.execPath, [
      join(process.cwd(), "scripts/build-diagram-viewer.mjs"), svgPath, specPath, filePath,
    ], { encoding: "utf8" });
    expect(buildOutput).toContain("OFFLINE_DIAGRAM_VIEWER");
    const fileUrl = pathToFileURL(filePath).href;
    const attempts: string[] = [];
    try {
      await page.route("**/*", async (route) => {
        if (route.request().url() === fileUrl) await route.continue();
        else { attempts.push(route.request().url()); await route.abort(); }
      });
      await page.goto(fileUrl);
      const status = page.locator("#selection");
      await page.locator('svg [data-kind="label"][data-source-id="id:node:shared:label"] text[data-kind="label-text"]').click({ force: true });
      await expect(status).toHaveText("node shared - 입력");
      await page.locator('svg [data-kind="label"][data-source-id="id:edge:shared:label"] text[data-kind="label-text"]').click({ force: true });
      await expect(status).toHaveText("edge shared - Call");
      expect(attempts).toEqual([]);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

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

  // The outlined fixture is engine output ("svg_viewer_fixture" keeps it exact),
  // and this measures it where a recipient would open it: a browser with no
  // Korean face installed. A text-mode artifact resolves whatever fallback the
  // platform offers; a path cannot. The fixture lives in the engine crate because
  // the app may read the SDK, never the reverse.
  test("draws an outlined export inside its measured label frames with no CJK font available", async ({ page }) => {
    const outlineFixture = resolve("src-tauri/crates/maru-diagram-engine/testdata/architecture-light-outlines.svg");
    await page.goto(pathToFileURL(outlineFixture).href);
    // A standalone SVG document has no head for an injected stylesheet, so the
    // override goes in as an SVG style element before anything is measured.
    // `document.fonts.check` cannot report a missing family (an unknown family
    // still "renders" through fallback), so the proof is geometric: the same
    // artifact drawn under an absent family and under `serif` must not move.
    const override = (family: string) => page.evaluate((value) => {
      const svg = document.querySelector("svg");
      if (!svg) throw new Error("the fixture rendered no svg root");
      let style = svg.querySelector("style[data-maru-font-probe]");
      if (!style) {
        style = document.createElementNS("http://www.w3.org/2000/svg", "style");
        style.setAttribute("data-maru-font-probe", "1");
        svg.insertBefore(style, svg.firstChild);
      }
      style.textContent = `* { font-family: ${value} !important; }`;
    }, family);
    const measure = () => page.evaluate(() => {
      const svg = document.querySelector("svg");
      if (!svg) throw new Error("the fixture rendered no svg root");
      const viewportBox = (element: SVGGraphicsElement) => {
        const bounds = element.getBBox();
        const matrix = element.getCTM();
        if (!matrix) throw new Error("a glyph has no transform to the viewport");
        const corners = [
          [bounds.x, bounds.y],
          [bounds.x + bounds.width, bounds.y],
          [bounds.x, bounds.y + bounds.height],
          [bounds.x + bounds.width, bounds.y + bounds.height],
        ].map(([x, y]) => ({ x: matrix.a * x + matrix.c * y + matrix.e, y: matrix.b * x + matrix.d * y + matrix.f }));
        const xs = corners.map((point) => point.x);
        const ys = corners.map((point) => point.y);
        return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
      };
      const labels = [...svg.querySelectorAll('g[data-kind="label"]')].map((label) => {
        const frame = label.querySelector(':scope > rect[data-kind="label-bounds"]');
        const glyphs = [...label.querySelectorAll('path[data-kind="glyph"]')];
        if (!frame || !glyphs.length) throw new Error("a label lost its measured frame or its glyph paths");
        const boxes = glyphs.map((glyph) => viewportBox(glyph as SVGGraphicsElement));
        const ink = {
          left: Math.min(...boxes.map((box) => box.left)),
          top: Math.min(...boxes.map((box) => box.top)),
          right: Math.max(...boxes.map((box) => box.right)),
          bottom: Math.max(...boxes.map((box) => box.bottom)),
        };
        const bounds = viewportBox(frame as SVGGraphicsElement);
        return {
          label: label.getAttribute("aria-label"),
          ink,
          overflow: Math.max(
            bounds.left - ink.left,
            ink.right - bounds.right,
            bounds.top - ink.top,
            ink.bottom - bounds.bottom,
          ),
        };
      });
      return {
        labelCount: labels.length,
        textNodes: svg.querySelectorAll("text").length,
        overflowing: labels.filter((entry) => entry.overflow > 0.5).map((entry) => entry.label),
        worstOverflow: Math.max(...labels.map((entry) => entry.overflow)),
        ink: labels.map((entry) => ({ label: entry.label, ink: entry.ink })),
      };
    });
    await override('"Maru Absent CJK Face", monospace');
    const measured = await measure();
    expect(measured.textNodes).toBe(0);
    expect(measured.labelCount).toBeGreaterThan(0);
    // Ink may touch its own frame; anything outside it is a label the artifact
    // would have to rewrap, which is what a missing face used to cause.
    expect(measured.overflowing).toEqual([]);
    expect(measured.worstOverflow).toBeLessThanOrEqual(0.5);
    await override("serif")
    expect((await measure()).ink).toEqual(measured.ink);
  });
});

import { expect, test, type Page } from "@playwright/test";

import { SEMANTIC_FIXTURES } from "../src/lib/diagram/__fixtures__/semantic";
import type { EngineDiagramType } from "../src/lib/diagram/reportTypes";

/**
 * The canvas must draw the engine's own scene (issue #552 E4 T3).
 *
 * Each family imports a spec whose first entity carries a short Korean/English
 * label, then compares what the canvas paints with a fresh layout of the exact
 * bytes the export path sends: node boxes, label lines and route points. The
 * canvas publishes the SHA-256 of the source it laid out, and the probe
 * rebuilds those bytes through the same codec, so the comparison cannot pass
 * against a different document.
 *
 * Chromium only: this says nothing about WKWebView, the native PTY or Korean
 * IME, which the native suite and a real-app check cover.
 */

const TYPES: EngineDiagramType[] = ["architecture", "workflow", "sequence", "dataflow", "lifecycle"];
const ENTITY_FIELD: Record<EngineDiagramType, string> = {
  architecture: "components",
  workflow: "nodes",
  sequence: "participants",
  dataflow: "nodes",
  lifecycle: "states",
};
/** One short mixed label per family, kept close to the fixture's own width so
 * the real engine keeps fitting it instead of refusing the layout. */
const MIXED_LABEL: Record<EngineDiagramType, string> = {
  architecture: "웹 Web",
  workflow: "초안 Draft",
  sequence: "웹 Web",
  dataflow: "앱 App",
  lifecycle: "대기 Queued",
};
/** Authored containers the projection draws for each family (lanes only). */
const MIN_CONTAINERS: Record<EngineDiagramType, number> = {
  architecture: 0,
  workflow: 1,
  sequence: 0,
  dataflow: 0,
  lifecycle: 1,
};

function mixedSpec(type: EngineDiagramType): Record<string, unknown> {
  const spec = structuredClone(SEMANTIC_FIXTURES[type]);
  const entries = spec[ENTITY_FIELD[type]] as Array<Record<string, unknown>>;
  entries[0]!.label = MIXED_LABEL[type];
  return spec;
}

async function importSpec(page: Page, type: EngineDiagramType, spec: Record<string, unknown>): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "다이어그램", exact: true }).click();
  await page.getByRole("tab", { name: "파일" }).click();
  await page.getByRole("button", { name: "가져오기" }).click();
  const dialog = page.locator(".dialog-content", { hasText: "가져오기" });
  await dialog.getByTestId("ie-file-input").setInputFiles({
    name: `fixture.${type}.json`,
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(spec)),
  });
  await expect(dialog.getByTestId("ie-import-confirm")).toBeEnabled();
  await dialog.getByTestId("ie-import-confirm").click();
  await expect(dialog).toBeHidden();
  // A refused layout keeps the projected source positions and says so; this
  // probe is about engine geometry, so it waits for the engine's own scene.
  await expect(page.locator('.maru-diagram-canvas[data-engine-geometry-status="ready"]')).toHaveCount(1);
  await expect(page.locator("[data-engine-geometry-notice]")).toHaveCount(0);
}

/** Zoom the canvas out so culling cannot hide a member from the comparison. */
async function showWholePage(page: Page): Promise<void> {
  const canvas = page.locator(".maru-diagram-canvas");
  for (let step = 0; step < 3; step += 1) {
    await canvas.dispatchEvent("wheel", { ctrlKey: true, deltaY: 400, clientX: 240, clientY: 240 });
  }
}

interface CanvasProof {
  specSha256: string;
  nodes: number;
  containers: number;
  labels: number;
  koreanLines: string[];
  routes: number;
}

for (const type of TYPES) {
  test(`the canvas draws the ${type} export geometry`, async ({ page }) => {
    const spec = mixedSpec(type);
    await importSpec(page, type, spec);
    await showWholePage(page);

    const proof: CanvasProof = await page.evaluate(async (input) => {
      type Bounds = { x: number; y: number; width: number; height: number };
      type Scene = {
        nodes: Array<{ id: string; bounds: Bounds }>;
        containers: Array<{ id: string; bounds: Bounds }>;
        routes: Array<{ id?: string | null; points: Array<{ x: number; y: number }> }>;
        labels: Array<{ id?: string | null; targetId: string; text: string }>;
      };
      type Report = { ok: boolean; geometry?: Scene | null; diagnostics: unknown[] };

      const load = (specifier: string) => import(specifier);
      const codec = (await load("/src/lib/diagram/archifyCodec.ts")) as {
        archifySpecToDataset(
          diagramType: string,
          spec: Record<string, unknown>,
          opts?: { id?: string },
        ): { dataset: { spec: unknown } };
      };
      const geometryModule = (await load("/src/lib/diagram/engineGeometry.ts")) as {
        loadGeometryEngine(): Promise<{ layout(input: { specJson: string }): Report }>;
      };

      // The bytes the export path sends, rebuilt through the same codec the
      // import used. If these are not the canvas's bytes the probe is void.
      const specJson = JSON.stringify(
        codec.archifySpecToDataset(input.type, input.spec, { id: `ds-${input.type}` }).dataset.spec,
      );
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(specJson));
      const specSha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

      const surface = document.querySelector<SVGSVGElement>(".maru-diagram-canvas");
      if (!surface) throw new Error("The diagram canvas is not mounted; open diagram mode before the geometry probe.");
      const painted = surface.getAttribute("data-engine-spec-sha256");
      if (painted !== specSha256) {
        throw new Error(`The canvas laid out ${painted ?? "nothing"} while the import stores ${specSha256}; compare the same bytes before trusting a match.`);
      }
      const engine = await geometryModule.loadGeometryEngine();
      const report = engine.layout({ specJson });
      const scene = report.ok ? report.geometry : null;
      if (!scene) throw new Error(`The engine refused the export request: ${JSON.stringify(report.diagnostics)}; repair the fixture before comparing.`);

      // Fixed-point becomes pixels here, exactly once, as the canvas does.
      const px = (value: number) => value / 64;
      const pixelBox = (bounds: Bounds) => [px(bounds.x), px(bounds.y), px(bounds.width), px(bounds.height)];
      const failures: string[] = [];
      // What the canvas actually painted, so a mismatch names the mismatch.
      const inventory = () => ({
        dataset: surface.getAttribute("data-engine-dataset-id"),
        status: surface.getAttribute("data-engine-geometry-status"),
        canvasIds: [...surface.querySelectorAll("[data-node-id]")].map((node) => node.getAttribute("data-node-id")).slice(0, 10),
        sourceIds: [...surface.querySelectorAll("[data-engine-source-id]")].map((node) => node.getAttribute("data-engine-source-id")).slice(0, 10),
      });
      const groupOf = (sourceId: string) => surface.querySelector(`[data-engine-source-id="${sourceId}"]`);
      const boxDiff = (group: Element, expected: number[]) => {
        const actual = (group.getAttribute("data-engine-box") ?? "").split(" ").map(Number);
        return actual.length === 4 && actual.every((value, index) => value === expected[index])
          ? null
          : `${group.getAttribute("data-engine-box") ?? "no box"} != ${expected.join(" ")}`;
      };

      for (const node of scene.nodes) {
        const group = groupOf(node.id);
        if (!group) {
          failures.push(`node ${node.id} is not on the canvas`);
          continue;
        }
        const expected = pixelBox(node.bounds);
        const diff = boxDiff(group, expected);
        if (diff) failures.push(`node ${node.id} box ${diff}`);
        // The painted origin is the same box: the canvas places nothing itself.
        const transform =
          group.querySelector("[data-node-id]")?.getAttribute("transform") ?? group.getAttribute("transform");
        if (transform !== `translate(${expected[0]},${expected[1]})`) {
          failures.push(`node ${node.id} is painted at ${transform ?? "no transform"}`);
        }
      }

      let containers = 0;
      for (const container of scene.containers) {
        const group = groupOf(container.id);
        if (!group) continue;
        containers += 1;
        const diff = boxDiff(group, pixelBox(container.bounds));
        if (diff) failures.push(`container ${container.id} box ${diff}`);
      }

      // Every label the engine aimed at a placed member must be painted with
      // the engine's own line breaks, never re-wrapped here.
      const paintedIds = new Set(
        [...surface.querySelectorAll("[data-engine-label]")].map((element) => element.getAttribute("data-engine-label")),
      );
      const placed = new Set<string>([
        ...scene.nodes.map((node) => node.id),
        ...scene.containers.map((container) => container.id),
        ...scene.routes.flatMap((route) => (route.id ? [route.id] : [])),
      ]);
      for (const label of scene.labels) {
        if (!label.id || !placed.has(label.targetId) || paintedIds.has(label.id)) continue;
        failures.push(`label ${label.id} targets ${label.targetId} but the canvas does not paint it`);
      }
      const engineLabels = new Map(
        scene.labels.filter((label) => typeof label.id === "string").map((label) => [label.id as string, label]),
      );
      let labels = 0;
      let koreanLines: string[] = [];
      for (const element of surface.querySelectorAll("[data-engine-label]")) {
        const id = element.getAttribute("data-engine-label") ?? "";
        const expected = engineLabels.get(id);
        if (!expected) {
          failures.push(`label ${id} is not in the engine scene`);
          continue;
        }
        labels += 1;
        const lines = expected.text.split("\n");
        const paintedLines = [...element.querySelectorAll("tspan")].map((line) => line.textContent ?? "");
        if (paintedLines.length > 0 && JSON.stringify(paintedLines) !== JSON.stringify(lines)) {
          failures.push(`label ${id} lines ${JSON.stringify(paintedLines)} != ${JSON.stringify(lines)}`);
        }
        if (/[\uAC00-\uD7A3]/.test(expected.text)) koreanLines = lines;
      }

      let routes = 0;
      for (const route of scene.routes) {
        if (!route.id) continue;
        const edge = surface.querySelector(`[data-engine-route="${route.id}"]`);
        if (!edge) {
          failures.push(`route ${route.id} is not on the canvas`);
          continue;
        }
        routes += 1;
        const path = route.points
          .map((point, index) => `${index === 0 ? "M" : "L"} ${px(point.x)} ${px(point.y)}`)
          .join(" ");
        const drawn = edge.querySelector("path")?.getAttribute("d");
        if (drawn !== path) failures.push(`route ${route.id} path ${drawn ?? "no path"} != ${path}`);
      }

      if (failures.length > 0) {
        throw new Error(
          `canvas geometry mismatches: ${failures.join("; ")}; the canvas painted ${JSON.stringify(inventory())}; fix the canvas mapper instead of the fixture.`,
        );
      }
      return { specSha256, nodes: scene.nodes.length, containers, labels, koreanLines, routes };
    }, { type, spec });

    expect(proof.nodes).toBeGreaterThan(0);
    expect(proof.containers).toBeGreaterThanOrEqual(MIN_CONTAINERS[type]);
    expect(proof.labels).toBeGreaterThanOrEqual(1);
    expect(proof.koreanLines.join(" ")).toContain(MIXED_LABEL[type]);
    expect(proof.routes).toBeGreaterThan(0);

    console.log(`CANVAS_GEOMETRY ${JSON.stringify({ scope: "canvas draws the engine scene, chromium only", type, ...proof })}`);
    await test.info().attach(`canvas-geometry-${type}.json`, {
      body: JSON.stringify(proof, null, 2),
      contentType: "application/json",
    });
  });
}

import { readFile } from "node:fs/promises";
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

/**
 * Zoom the canvas out with the ribbon's own control so culling cannot hide a
 * member from the comparison. Returns the zoom percent the ribbon shows, which
 * the caller asserts so a no-op click cannot weaken the probe.
 */
async function showWholePage(page: Page): Promise<number> {
  // The zoom group lives on the view tab, not on the file tab the import used.
  await page.getByRole("tab", { name: "보기" }).click();
  const zoomOut = page.getByRole("button", { name: "축소" });
  for (let step = 0; step < 6; step += 1) await zoomOut.click();
  const label = (await page.locator(".maru-diagram-zoom-label").textContent()) ?? "";
  return Number(label.replace("%", "").trim());
}

interface CanvasProof {
  specSha256: string;
  nodes: number;
  containers: number;
  labels: number;
  koreanLines: string[];
  routes: number;
}

/**
 * The member whose doc slot and engine box disagree most, in spec order: the
 * slab the canvas must not act on, and the box it must. Without a member the
 * engine placed away from its slot, comparing the two proves nothing.
 */
async function widestSlotGap(
  page: Page,
  type: EngineDiagramType,
  spec: Record<string, unknown>,
): Promise<{ sourceId: string; gap: number }> {
  return page.evaluate(async (input) => {
    // Runtime specifiers: the browser resolves them against the dev server.
    const load = (specifier: string) => import(specifier);
    const codec = (await load("/src/lib/diagram/archifyCodec.ts")) as {
      archifySpecToDataset(diagramType: string, spec: Record<string, unknown>, opts?: { id?: string }): {
        dataset: { id: string };
      };
    };
    const semantic = (await load("/src/lib/diagram/semantic.ts")) as {
      projectSemanticDocument(dataset: unknown): {
        doc: { nodes: Array<{ x: number; y: number; meta?: { memberId?: string } }> };
      };
    };
    const dataset = codec.archifySpecToDataset(input.type, input.spec, { id: "ds-vacuity" }).dataset;
    const slots = new Map<string, { x: number; y: number }>();
    for (const node of semantic.projectSemanticDocument(dataset).doc.nodes) {
      if (node.meta?.memberId) slots.set(node.meta.memberId, { x: node.x, y: node.y });
    }
    const entries = (input.spec[input.field] ?? []) as Array<{ id?: string }>;
    const surface = document.querySelector<SVGSVGElement>(".maru-diagram-canvas");
    if (!surface) throw new Error("The diagram canvas is not mounted.");
    let best = { sourceId: "", gap: 0 };
    entries.forEach((entry, index) => {
      const slot = slots.get(`${dataset.id}:m${index}`);
      const sourceId = entry.id ?? "";
      if (!slot || !sourceId) return;
      const group = surface.querySelector(`[data-engine-source-id="${sourceId}"]`);
      const box = (group?.getAttribute("data-engine-box") ?? "").split(" ").map(Number);
      if (box.length !== 4) return;
      const gap = Math.hypot(box[0]! - slot.x, box[1]! - slot.y);
      if (gap > best.gap) best = { sourceId, gap };
    });
    return best;
  }, { type, spec, field: ENTITY_FIELD[type] });
}

for (const type of TYPES) {
  test(`the canvas draws the ${type} export geometry`, async ({ page }) => {
    const spec = mixedSpec(type);
    await importSpec(page, type, spec);
    const zoomPercent = await showWholePage(page);
    // At this zoom the whole page is inside the surface, so a member missing
    // from the DOM is a mapping bug rather than culling.
    expect(zoomPercent).toBeLessThanOrEqual(40);

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
      const inventory = () => {
        const rect = surface.getBoundingClientRect();
        return {
          dataset: surface.getAttribute("data-engine-dataset-id"),
          status: surface.getAttribute("data-engine-geometry-status"),
          surface: [rect.width, rect.height],
          transform: surface.querySelector("[data-engine-source-id]")?.parentElement?.getAttribute("transform"),
          painted: [...surface.querySelectorAll("[data-engine-source-id]")].map((node) => [
            node.getAttribute("data-engine-source-id"),
            node.getAttribute("data-engine-box"),
          ]),
          engine: scene.nodes.map((node) => [node.id, pixelBox(node.bounds)]),
        };
      };
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

/**
 * The chrome that acts on a member uses the same coordinates as the painting.
 * Both cases below select a member the engine placed away from its slot, so a
 * pass cannot come from the two happening to agree.
 */
test("the inline editor opens over the engine box, not the doc slot", async ({ page }) => {
  const spec = mixedSpec("workflow");
  await importSpec(page, "workflow", spec);
  await showWholePage(page);
  const target = await widestSlotGap(page, "workflow", spec);
  // Non-vacuity: a slot that coincides with the box would make this probe mute.
  expect(target.sourceId).not.toBe("");
  expect(target.gap).toBeGreaterThan(20);

  await page.locator(`[data-engine-source-id="${target.sourceId}"] [data-node-id]`).click();
  await page.keyboard.press("F2");

  const proof = await page.evaluate((sourceId) => {
    const surface = document.querySelector<SVGSVGElement>(".maru-diagram-canvas");
    if (!surface) throw new Error("The diagram canvas is not mounted.");
    const group = surface.querySelector(`[data-engine-source-id="${sourceId}"]`);
    const inner = group?.querySelector("[data-node-id]") as SVGGElement | null;
    const ctm = inner?.getScreenCTM();
    const box = (group?.getAttribute("data-engine-box") ?? "").split(" ").map(Number);
    const editor = document.querySelector<HTMLTextAreaElement>("textarea.maru-diagram-inline-editor");
    if (!group || !ctm || box.length !== 4) throw new Error(`Member ${sourceId} is not painted; F2 has nothing to sit on.`);
    if (!editor) throw new Error("Pressing F2 did not open the inline editor.");
    const rect = editor.getBoundingClientRect();
    return {
      box,
      painted: { left: ctm.e, top: ctm.f, width: box[2]! * ctm.a, height: box[3]! * ctm.d },
      editor: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    };
  }, target.sourceId);

  const near = (actual: number, expected: number) => Math.abs(actual - expected) <= 1.5;
  const report = JSON.stringify(proof);
  expect(near(proof.editor.left, proof.painted.left), `editor left ${report}`).toBe(true);
  expect(near(proof.editor.top, proof.painted.top), `editor top ${report}`).toBe(true);
  // The overlay clamps a small box to a usable size; that clamp is the last word.
  expect(near(proof.editor.width, Math.max(proof.painted.width, 40)), `editor width ${report}`).toBe(true);
  expect(near(proof.editor.height, Math.max(proof.painted.height, 24)), `editor height ${report}`).toBe(true);

  await page.keyboard.press("Escape");
  await expect(page.locator("textarea.maru-diagram-inline-editor")).toHaveCount(0);
  console.log(`CANVAS_CHROME ${JSON.stringify({ scope: "inline editor sits on the engine box, chromium only", ...proof })}`);
});

test("an arrow-key nudge moves the painted box and pins it", async ({ page }) => {
  const spec = mixedSpec("workflow");
  await importSpec(page, "workflow", spec);
  await showWholePage(page);
  const target = await widestSlotGap(page, "workflow", spec);
  expect(target.sourceId).not.toBe("");

  const painted = async () =>
    page.evaluate((sourceId) => {
      const group = document.querySelector(`.maru-diagram-canvas [data-engine-source-id="${sourceId}"]`);
      const transform = group?.querySelector("[data-node-id]")?.getAttribute("transform") ?? "";
      const match = /^translate\((-?[0-9.]+),(-?[0-9.]+)\)$/.exec(transform);
      const box = (group?.getAttribute("data-engine-box") ?? "").split(" ").map(Number);
      return { x: match ? Number(match[1]) : NaN, y: match ? Number(match[2]) : NaN, box, transform };
    }, target.sourceId);

  const before = await painted();
  expect(Number.isFinite(before.x), `member ${target.sourceId} is not painted: ${before.transform}`).toBe(true);
  // What the canvas laid out, so a later check can tell a pin from a new source.
  const specSha = await page.locator(".maru-diagram-canvas").getAttribute("data-engine-spec-sha256");

  await page.locator(`[data-engine-source-id="${target.sourceId}"] [data-node-id]`).click();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");

  // The pin has to survive a layout round trip: the box moves by exactly the
  // three nudges, not by nothing (a hidden doc edit) or by six (a double add).
  await expect.poll(async () => (await painted()).x, { timeout: 15_000 }).toBeCloseTo(before.x + 3, 1);
  const after = await painted();
  expect(after.y, `box moved from ${before.transform} to ${after.transform}`).toBeCloseTo(before.y, 1);
  // The source is untouched, so only an authored pin can have moved the box.
  expect(after.box[0], `engine box ${JSON.stringify(before.box)} -> ${JSON.stringify(after.box)}`).toBeCloseTo(
    before.box[0]! + 3,
    1,
  );
  expect(await page.locator(".maru-diagram-canvas").getAttribute("data-engine-spec-sha256")).toBe(specSha);
  console.log(`CANVAS_CHROME ${JSON.stringify({ scope: "arrow nudge pins the painted box, chromium only", target, before, after })}`);
});


test("ArrowRight on a derived dataflow stage changes neither doc nor history", async ({ page }) => {
  await importSpec(page, "dataflow", mixedSpec("dataflow"));
  await showWholePage(page);
  const readDoc = async () => {
    await page.getByRole("tab", { name: "파일", exact: true }).click();
    await page.getByRole("button", { name: "내보내기", exact: true }).click();
    const dialog = page.locator(".dialog-content", { hasText: "내보내기" });
    await dialog.getByTestId("ie-format-select").selectOption("maru-json");
    const downloadPromise = page.waitForEvent("download");
    await dialog.getByTestId("ie-export-confirm").click();
    const download = await downloadPromise;
    const filePath = await download.path();
    if (!filePath) throw new Error("The JSON export did not produce a readable download");
    const doc = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    await dialog.getByRole("button", { name: "취소", exact: true }).click();
    await expect(dialog).toBeHidden();
    return doc;
  };
  const before = await readDoc() as { nodes: Array<{ id: string; locked?: boolean }> };
  const stageId = await page.locator('[data-engine-source-id="stage:0"] .maru-diagram-node[data-node-id]').getAttribute("data-node-id");
  const storedStage = before.nodes.find((node) => node.id === stageId);
  expect(storedStage).toBeDefined();
  expect(storedStage!.locked).not.toBe(true);
  await page.getByRole("tab", { name: "편집", exact: true }).click();
  const undo = page.getByRole("button", { name: /되돌리기/ });
  await expect(undo).toBeDisabled();
  const stage = page.locator('[data-engine-source-id="stage:0"] .maru-diagram-node[data-node-id]');
  await stage.click({ position: { x: 20, y: 10 }, force: true });
  await expect(stage).toHaveClass(/is-selected/);
  await page.keyboard.press("ArrowRight");
  await expect(undo).toBeDisabled();
  expect(await readDoc()).toEqual(before);
});

// A held layout makes the optimistic display interval observable in Chromium.
test("inline edit and find use the shared dropped position before layout publishes", async ({ page }) => {
  await importSpec(page, "workflow", mixedSpec("workflow"));
  await showWholePage(page);
  await page.evaluate(async () => {
    const load = (specifier: string) => import(specifier);
    const geometry = await load("/src/lib/diagram/engineGeometry.ts");
    const canvas = await load("/src/lib/diagram/engineCanvasGeometry.ts");
    const engine = await geometry.loadGeometryEngine();
    let release!: () => void;
    const held = new Promise((resolve) => { release = () => resolve(engine); });
    canvas._setCanvasEngineLoaderForTests(() => held);
    (window as unknown as { releaseCanvasLayout: () => void }).releaseCanvasLayout = () => {
      canvas._setCanvasEngineLoaderForTests(null);
      release();
    };
  });
  try {
    const member = page.locator('[data-engine-source-id="draft"] .maru-diagram-node[data-node-id]');
    const sourceBox = await member.locator("..").getAttribute("data-engine-box");
    const rect = await member.boundingBox();
    if (!rect) throw new Error("The workflow member is not visible");
    await page.mouse.move(rect.x + 8, rect.y + 8);
    await page.mouse.down();
    await page.mouse.move(rect.x + 108, rect.y + 48, { steps: 4 });
    await page.mouse.up();
    const moved = await member.boundingBox();
    expect(moved!.x - rect.x).toBeGreaterThan(40);
    // No new engine box has landed; the drop is shared optimistic geometry.
    expect(await member.locator("..").getAttribute("data-engine-box")).toBe(sourceBox);
    await page.keyboard.press("F2");
    const editor = page.locator("textarea.maru-diagram-inline-editor");
    await expect(editor).toBeVisible();
    const editorRect = await editor.boundingBox();
    const current = await member.boundingBox();
    expect(Math.abs(editorRect!.x - current!.x)).toBeLessThan(2);
    expect(Math.abs(editorRect!.y - current!.y)).toBeLessThan(2);
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+f");
    const query = page.locator('.maru-diagram-find-bar input[type="search"]');
    await query.fill("초안 Draft");
    await query.press("Enter");
    const centered = await member.boundingBox();
    const surface = await page.locator(".maru-diagram-canvas").boundingBox();
    expect(Math.abs(centered!.x + centered!.width / 2 - surface!.x - surface!.width / 2)).toBeLessThan(2);
    expect(Math.abs(centered!.y + centered!.height / 2 - surface!.y - surface!.height / 2)).toBeLessThan(2);
    await query.press("Escape");
    await page.getByRole("button", { name: "맞춤", exact: true }).click();
    const fitted = await member.boundingBox();
    expect(fitted!.x).toBeGreaterThanOrEqual(surface!.x - 2);
    expect(fitted!.x + fitted!.width).toBeLessThanOrEqual(surface!.x + surface!.width + 2);
  } finally {
    await page.evaluate(() => { (window as unknown as { releaseCanvasLayout: () => void }).releaseCanvasLayout(); });
  }
});

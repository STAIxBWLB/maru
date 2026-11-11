// T4: the real macOS app (WKWebView, debug native-e2e build) draws the engine's
// own scene. The fixture reports what a fresh engine layout expects for a
// document saved and reopened through the app's IPC path; this spec compares
// that with what the canvas actually painted, then exercises apply/undo/redo,
// export receipts, pan/zoom/selection, the refusal diagnostic and the two UI
// languages.
//
// Two harness limits, both recorded rather than papered over:
//  - WebDriver cannot drive real IME composition, so Korean IME stays a pending
//    human check even though Korean labels render here.
//  - The embedded driver injects synthetic mouse events only, never a pointer
//    sequence, and this WKWebView reports itself unfocused, so the terminal's
//    first-mouse guard eats pointerdown until the window is marked focused.
//    Pan/zoom/selection therefore dispatch PointerEvents at the app's own
//    handlers; the canvas state they produce is what is asserted.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type {} from "webdriverio";

import { fixtureRootDir } from "../helpers/fixtureWorkspace";

const EVIDENCE_DIR = path.join(process.cwd(), "e2e-native", "evidence", "diagram-engine-e4");

/** Mirrors NativeE2eDiagramE4Result; declared here like the export spec's own
 *  bridge types, so this project does not pull src/lib into its typecheck. */
interface NativeE2eDiagramE4Family {
  type: string;
  datasetId: string;
  documentName: string;
  documentTitle: string;
  specSha256: string;
  mixedLabel: string;
  nodes: Array<{ id: string; box: [number, number, number, number] }>;
  containers: Array<{ id: string; box: [number, number, number, number] }>;
  routes: Array<{ id: string; path: string }>;
  labels: Array<{ id: string; targetId: string; lines: string[]; box: [number, number, number, number] }>;
}

interface NativeE2eDiagramE4Version {
  v: number;
  documentName: string;
  documentTitle: string;
  sourceVersion: number | null;
  migratedVersion: number;
  nodeCount: number;
  datasets: number;
  reopenEqual: boolean;
}

interface NativeE2eDiagramE4Refusal {
  documentName: string;
  documentTitle: string;
  specSha256: string;
  code: string;
  path: string;
  category: string;
  targetKind: string;
  targetId: string;
  targetX: number;
  targetY: number;
}

interface NativeE2eDiagramE4Result {
  families: NativeE2eDiagramE4Family[];
  versions: NativeE2eDiagramE4Version[];
  refusal: NativeE2eDiagramE4Refusal;
  apply: {
    refused: boolean;
    refusalKeys: string[];
    historyAfterRefusal: number;
    applied: boolean;
    historyAfterApply: number;
    undoRestored: boolean;
    redoRestored: boolean;
    reopenedWithoutLoss: boolean;
    addedFields: string[];
  };
}

type FixtureState =
  | { status: "pending" }
  | { status: "complete"; result: NativeE2eDiagramE4Result }
  | { status: "failed"; error: string };

interface BridgeApi {
  readAppState(): { booting: boolean; settingsLoaded: boolean; workspacePath: string | null } | null;
  diagramEngineE4Fixture?: () => Promise<NativeE2eDiagramE4Result>;
  diagramStaticExportFixture?: () => Promise<{
    svgPath: string;
    pngPath: string;
    svgReceipt: { outputSha256?: string; readback?: { status?: string } };
    pngReceipt: { outputSha256?: string; readback?: { status?: string } };
  }>;
}

async function waitForBridge(): Promise<void> {
  await browser.waitUntil(async () => browser.execute(() => {
    const bridge = (window as unknown as { __MARU_NATIVE_E2E__?: BridgeApi }).__MARU_NATIVE_E2E__;
    const state = bridge?.readAppState();
    const workspace = state?.workspacePath?.replace(/\\/g, "/").replace(/\/+$/, "") ?? "";
    return Boolean(
      state?.booting === false && state.settingsLoaded === true
      && /(?:^|\/)maru-native-e2e-[^/]+\/workspace$/.test(workspace)
      && typeof bridge?.diagramEngineE4Fixture === "function",
    );
  }), {
    timeout: 60_000,
    interval: 250,
    timeoutMsg: "The T4 canvas fixture is unavailable; rebuild with make test-e2e-native (VITE_NATIVE_E2E=1) and rerun.",
  });
}

async function runFixture(): Promise<NativeE2eDiagramE4Result> {
  const started = await browser.execute(() => {
    const target = window as unknown as {
      __MARU_NATIVE_E2E__?: BridgeApi;
      __MARU_DIAGRAM_E4_RESULT__?: FixtureState;
    };
    const fixture = target.__MARU_NATIVE_E2E__?.diagramEngineE4Fixture;
    if (typeof fixture !== "function") return false;
    target.__MARU_DIAGRAM_E4_RESULT__ = { status: "pending" };
    void fixture().then(
      (result) => { target.__MARU_DIAGRAM_E4_RESULT__ = { status: "complete", result }; },
      (error) => { target.__MARU_DIAGRAM_E4_RESULT__ = { status: "failed", error: String(error) }; },
    );
    return true;
  });
  assert.equal(started, true, "The T4 fixture method is missing; rebuild with VITE_NATIVE_E2E=1.");
  await browser.waitUntil(async () => browser.execute(() => {
    const state = (window as unknown as { __MARU_DIAGRAM_E4_RESULT__?: FixtureState }).__MARU_DIAGRAM_E4_RESULT__;
    return state?.status === "complete" || state?.status === "failed";
  }), {
    timeout: 180_000,
    interval: 500,
    timeoutMsg: "The T4 canvas fixture exceeded 180 s; inspect the engine log and rerun.",
  });
  const state = await browser.execute(() => (window as unknown as {
    __MARU_DIAGRAM_E4_RESULT__?: FixtureState;
  }).__MARU_DIAGRAM_E4_RESULT__ ?? null);
  assert.ok(state, "The T4 canvas fixture produced no result.");
  if (state.status !== "complete") {
    assert.fail(state.status === "failed" ? state.error : "the T4 canvas fixture is still pending");
  }
  return state.result;
}

/** Click the first element whose trimmed text is exactly `label`. */
async function clickByText(label: string): Promise<boolean> {
  return browser.execute((wanted: string) => {
    const nodes = [...document.querySelectorAll<HTMLElement>("button, [role='button'], [role='tab']")];
    const hit = nodes.find((node) => (node.textContent ?? "").trim() === wanted && !node.hasAttribute("disabled"));
    if (!hit) return false;
    hit.click();
    return true;
  }, label);
}

async function screenshot(name: string): Promise<string> {
  await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  const file = path.join(EVIDENCE_DIR, `${name}.png`);
  await browser.saveScreenshot(file);
  const { size } = await fs.stat(file);
  assert.ok(size > 5_000, `screenshot ${name}.png is only ${size} bytes; the app window may not have been visible`);
  return path.relative(process.cwd(), file).split(path.sep).join("/");
}

/** Open one saved diagram document through the app's own file list. A legacy
 *  document carries no semantic dataset, so only an engine document is awaited
 *  for a settled engine scene. `specSha256` ties the wait to the document being
 *  opened: the previous document's `ready` attributes survive until the next
 *  layout lands, so a plain status check can return on the old scene. */
async function openDocument(
  title: string,
  options: { engine?: boolean; specSha256?: string } = {},
): Promise<void> {
  const expectEngine = options.engine !== false;
  // Later cases stay inside diagram mode; only the first one has to enter it.
  const mounted = await browser.execute(() => Boolean(document.querySelector(".maru-diagram-canvas")));
  if (!mounted) {
    // The rail's mode buttons are icon-only; their accessible name is the
    // aria-label the app sets from `mode.diagram`.
    const entered = await browser.execute(() => {
      const labels = ["다이어그램", "Diagram"];
      const button = [...document.querySelectorAll<HTMLElement>("button[aria-label]")]
        .find((node) => labels.includes((node.getAttribute("aria-label") ?? "").trim()));
      if (!button) return false;
      button.click();
      return true;
    });
    assert.equal(entered, true, "The diagram activity button is missing on the home screen");
    await browser.waitUntil(async () => browser.execute(() => Boolean(document.querySelector(".maru-diagram-canvas"))), {
      timeout: 30_000,
      interval: 250,
      timeoutMsg: "Diagram mode did not mount a canvas",
    });
  }
  // The file ribbon owns the open list; its own tab has to be selected first.
  assert.equal(await clickByText("파일") || await clickByText("File"), true, "The diagram file ribbon tab is missing");
  const opened = await browser.execute(() => {
    const listToggle = [...document.querySelectorAll<HTMLElement>("button")].find((button) =>
      (button.textContent ?? "").trim() === "열기" || (button.textContent ?? "").trim() === "Open");
    if (!listToggle) return "no-open-button";
    if (!document.querySelector(".maru-diagram-list-name")) listToggle.click();
    return "clicked";
  });
  assert.equal(opened, "clicked", "The diagram file list toggle is missing");
  await browser.waitUntil(async () => browser.execute((wanted: string) =>
    [...document.querySelectorAll<HTMLElement>(".maru-diagram-list-name")].some((node) => (node.textContent ?? "").trim() === wanted),
  title), {
    timeout: 20_000,
    interval: 250,
    timeoutMsg: `The saved document "${title}" never appeared in the diagram file list`,
  });
  // The canvas keeps the previous document's attributes until the next load
  // renders, so the wait below compares against what was on screen before.
  const beforeOpen = await browser.execute(() => {
    const canvas = document.querySelector(".maru-diagram-canvas");
    return {
      sha: canvas?.getAttribute("data-engine-spec-sha256") ?? null,
      ids: [...(canvas?.querySelectorAll("[data-node-id]") ?? [])]
        .map((node) => node.getAttribute("data-node-id") ?? "").join(","),
    };
  });
  const clicked = await browser.execute((wanted: string) => {
    const name = [...document.querySelectorAll<HTMLElement>(".maru-diagram-list-name")]
      .find((node) => (node.textContent ?? "").trim() === wanted);
    const button = name?.closest("button");
    if (!button) return false;
    button.click();
    return true;
  }, title);
  assert.equal(clicked, true, `Could not open "${title}" from the diagram file list`);
  await browser.waitUntil(async () => browser.execute((options: {
    wantEngine: boolean;
    wantSha: string | null;
    before: { sha: string | null; ids: string };
  }) => {
    const canvas = document.querySelector(".maru-diagram-canvas");
    if (!canvas) return false;
    if (!options.wantEngine) {
      const ids = [...canvas.querySelectorAll("[data-node-id]")]
        .map((node) => node.getAttribute("data-node-id") ?? "").join(",");
      return ids.length > 0 && ids !== options.before.ids;
    }
    const status = canvas.getAttribute("data-engine-geometry-status");
    if (status !== "ready" && status !== "refused") return false;
    if (options.wantSha !== null) return canvas.getAttribute("data-engine-spec-sha256") === options.wantSha;
    const sha = canvas.getAttribute("data-engine-spec-sha256");
    return sha !== options.before.sha;
  }, { wantEngine: expectEngine, wantSha: options.specSha256 ?? null, before: beforeOpen }), {
    timeout: 60_000,
    interval: 250,
    timeoutMsg: `The canvas never settled on "${title}"${options.specSha256 ? ` with spec ${options.specSha256.slice(0, 8)}` : ""}`,
  });
}

interface PaintReport {
  specSha256: string | null;
  status: string | null;
  nodes: Array<{ id: string; box: number[]; transform: string | null }>;
  routes: Array<{
    id: string;
    path: string | null;
    /** Sample points inside a container, where a lane fill can cover the route. */
    pointsInContainers: number;
    /** The first sample the route does not own, named by whatever paints there. */
    covered: { at: { x: number; y: number }; by: string } | null;
  }>;
  labels: Array<{
    id: string;
    lines: string[];
    width: number;
    height: number;
    /** Painted top-left, in canvas coordinates. */
    painted: { x: number; y: number };
  }>;
  surface: { width: number; height: number };
}

/** Read what this WKWebView painted, without trusting any app-side helper. The
 *  engine's status is awaited first: switching documents publishes `pending`
 *  before the loaded document's own layout lands, and the previous scene's
 *  attributes are still on the element while that happens.
 *
 *  The member and container boxes let a route sample say whether it is inside a
 *  lane: a point inside a member is where the route legitimately ends, so only a
 *  point outside every member can prove what paints above the route. */
async function painted(
  memberBoxes: readonly number[][] = [],
  containerBoxes: readonly number[][] = [],
): Promise<PaintReport> {
  await browser.waitUntil(async () => browser.execute(() => {
    const surface = document.querySelector(".maru-diagram-canvas");
    if (!surface) return false;
    const status = surface.getAttribute("data-engine-geometry-status");
    return status === "ready" || status === "refused"
      || (status === null && surface.querySelectorAll("[data-node-id]").length > 0);
  }), { timeout: 60_000, interval: 200, timeoutMsg: "the canvas never settled on a geometry result" });
  return browser.execute((boxes: { members: number[][]; containers: number[][] }) => {
    const surface = document.querySelector<SVGSVGElement>(".maru-diagram-canvas");
    if (!surface) throw new Error("the diagram canvas is not mounted");
    const rect = surface.getBoundingClientRect();
    const scene = surface.querySelector<SVGGElement>(":scope > g[transform]");
    const view = /translate\(([-\d.]+),\s*([-\d.]+)\)\s*scale\(([-\d.]+)\)/.exec(
      scene?.getAttribute("transform") ?? "",
    );
    if (!view) throw new Error("the canvas scene carries no viewport transform");
    const tx = Number(view[1]);
    const ty = Number(view[2]);
    const zoom = Number(view[3]);
    // Client pixels -> canvas pixels, the inverse of the scene transform.
    const toCanvas = (x: number, y: number) => ({
      x: (x - rect.left - tx) / zoom,
      y: (y - rect.top - ty) / zoom,
    });
    const paintedBox = (element: Element) => {
      const box = element.getBoundingClientRect();
      const topLeft = toCanvas(box.left, box.top);
      const bottomRight = toCanvas(box.right, box.bottom);
      return {
        x: topLeft.x,
        y: topLeft.y,
        w: bottomRight.x - topLeft.x,
        h: bottomRight.y - topLeft.y,
      };
    };
    const inside = (box: readonly number[], x: number, y: number, inset = 0) =>
      x > box[0]! + inset && x < box[0]! + box[2]! - inset
      && y > box[1]! + inset && y < box[1]! + box[3]! - inset;
    const describe = (element: Element | null) => {
      if (!element) return "nothing";
      const tags = [element.tagName.toLowerCase()];
      for (const name of ["class", "data-node-id", "data-engine-source-id", "data-edge-id", "data-engine-label"]) {
        const value = element.getAttribute(name);
        if (value) tags.push(`${name}="${value}"`);
      }
      return tags.join(" ");
    };
    return {
      specSha256: surface.getAttribute("data-engine-spec-sha256"),
      status: surface.getAttribute("data-engine-geometry-status"),
      nodes: [...surface.querySelectorAll("[data-engine-source-id]")].map((group) => ({
        id: group.getAttribute("data-engine-source-id") ?? "",
        box: (group.getAttribute("data-engine-box") ?? "").split(" ").map(Number),
        transform: group.querySelector("[data-node-id]")?.getAttribute("transform") ?? group.getAttribute("transform"),
      })),
      routes: [...surface.querySelectorAll<SVGGElement>("[data-engine-route]")].map((group) => {
        const paths = [...group.querySelectorAll<SVGPathElement>("path")];
        // The interactive hit path is transparent and owns the pointer; the
        // stroke path below it is what the user sees. Compare and hit-test the
        // stroke path, never the hit area.
        const visible = paths.find((path) => getComputedStyle(path).pointerEvents === "none") ?? paths[paths.length - 1];
        let pointsInContainers = 0;
        let covered: { at: { x: number; y: number }; by: string } | null = null;
        if (visible) {
          const length = visible.getTotalLength();
          for (let step = 1; step < 96 && !covered; step += 1) {
            const point = visible.getPointAtLength((length * step) / 96);
            // A member's own body and stroke own the pixels at its border, and
            // an arrow marker sits there too, so only a sample clear of every
            // member box says anything about paint order.
            if (boxes.members.some((box) => inside(box, point.x, point.y, -4))) continue;
            const inContainer = boxes.containers.some((box) => inside(box, point.x, point.y));
            if (inContainer) pointsInContainers += 1;
            const client = { x: rect.left + tx + point.x * zoom, y: rect.top + ty + point.y * zoom };
            if (client.x < 0 || client.y < 0 || client.x > window.innerWidth || client.y > window.innerHeight) continue;
            const top = document.elementFromPoint(client.x, client.y);
            if (!top) continue;
            // Only a member or container group painted above the route hides
            // it. Another edge's wider transparent hit area is pointer chrome,
            // and crossing strokes are what the engine routed.
            const cover = top.closest("[data-engine-source-id]");
            if (cover) {
              covered = { at: { x: point.x, y: point.y }, by: describe(cover) };
            }
          }
        }
        return {
          id: group.getAttribute("data-engine-route") ?? "",
          path: visible?.getAttribute("d") ?? null,
          pointsInContainers,
          covered,
        };
      }),
      labels: [...surface.querySelectorAll<SVGGraphicsElement>("[data-engine-label]")].map((element) => {
        const box = element.getBBox();
        const painted = paintedBox(element);
        // Only what the canvas painted is read here. Where the label belongs
        // comes from the engine's own label bounds, so an adapter that moved a
        // label but kept it inside its owner cannot satisfy the comparison.
        return {
          id: element.getAttribute("data-engine-label") ?? "",
          lines: [...element.querySelectorAll("tspan")].map((line) => line.textContent ?? ""),
          width: box.width,
          height: box.height,
          painted: { x: painted.x, y: painted.y },
        };
      }),
      surface: { width: rect.width, height: rect.height },
    };
  }, { members: memberBoxes as number[][], containers: containerBoxes as number[][] });
}

function assertFamilyPainted(paint: PaintReport, family: NativeE2eDiagramE4Family): void {
  assert.equal(paint.status, "ready", `${family.type}: the canvas did not reach engine geometry, status ${paint.status}`);
  assert.equal(paint.specSha256, family.specSha256, `${family.type}: the canvas laid out different bytes than the fixture`);
  assert.ok(family.nodes.length > 0, `${family.type}: the engine scene has no nodes`);
  for (const expected of family.nodes) {
    const actual = paint.nodes.find((node) => node.id === expected.id);
    assert.ok(actual, `${family.type}: node ${expected.id} is not painted`);
    assert.deepEqual(actual.box, expected.box, `${family.type}: node ${expected.id} box ${JSON.stringify(actual.box)} != ${JSON.stringify(expected.box)}`);
    if (actual.transform) {
      assert.equal(
        actual.transform,
        `translate(${expected.box[0]},${expected.box[1]})`,
        `${family.type}: node ${expected.id} is painted at ${actual.transform}`,
      );
    }
  }
  for (const expected of family.routes) {
    const actual = paint.routes.find((route) => route.id === expected.id);
    assert.ok(actual, `${family.type}: route ${expected.id} is not painted`);
    assert.equal(actual.path, expected.path, `${family.type}: route ${expected.id} path differs from the engine`);
    // The engine routed this relation, so it must be visible everywhere it
    // runs: a lane fill or a member box painted over it is the defect below.
    assert.equal(
      actual.covered,
      null,
      `${family.type}: route ${expected.id} is covered at (${actual.covered?.at.x.toFixed(1)},${actual.covered?.at.y.toFixed(1)}) by ${actual.covered?.by}`,
    );
  }
  const mixed = family.labels.find((label) => label.lines.join(" ").includes(family.mixedLabel));
  assert.ok(mixed, `${family.type}: no engine label carries the mixed label ${family.mixedLabel}`);
  // Only a label whose owner the canvas places has somewhere to be painted;
  // page and legend labels the scene does not place are the engine's own.
  const placed = new Set<string>([
    ...family.nodes.map((node) => node.id),
    ...family.containers.map((container) => container.id),
    ...family.routes.map((route) => route.id),
  ]);
  const paintedIds = paint.labels.map((label) => label.id);
  for (const expected of family.labels) {
    if (!placed.has(expected.targetId)) continue;
    const actual = paint.labels.find((label) => label.id === expected.id);
    assert.ok(
      actual,
      `${family.type}: label ${expected.id} targets placed ${expected.targetId} but is not painted; painted ${paintedIds.join(",")}`,
    );
    assert.deepEqual(actual.lines, expected.lines, `${family.type}: label ${expected.id} lines differ from the engine's breaks`);
    const target = family.nodes.find((node) => node.id === expected.targetId)
      ?? family.containers.find((container) => container.id === expected.targetId);
    if (target) {
      assert.ok(
        actual.width <= target.box[2] + 1 || expected.targetId.startsWith("edge:"),
        `${family.type}: label ${expected.id} is ${actual.width}px wide inside a ${target.box[2]}px box`,
      );
    }
  }
  for (const actual of paint.labels) {
    const engine = family.labels.find((label) => label.id === actual.id);
    assert.ok(engine, `${family.type}: label ${actual.id} is painted but is not in the engine scene`);
    if (!placed.has(engine.targetId)) continue;
    // The engine's line breaks are only correct if the first line starts where
    // the engine put the box, and no line leaves that box. Both fail when a
    // text baseline other than the top edge is used, and an adapter that moved
    // a label while keeping it inside its owner fails the origin comparison
    // because the expected point comes from the engine's bounds, not from the
    // coordinates the canvas itself paints with.
    assert.ok(
      Math.abs(actual.painted.x - engine.box[0]) <= 2
      && Math.abs(actual.painted.y - engine.box[1]) <= 2,
      `${family.type}: label ${actual.id} paints its first line at (${actual.painted.x.toFixed(1)},${actual.painted.y.toFixed(1)}); the engine put the label box at (${engine.box[0]},${engine.box[1]})`,
    );
    const right = actual.painted.x + actual.width;
    const bottom = actual.painted.y + actual.height;
    assert.ok(
      actual.painted.x >= engine.box[0] - 2
      && actual.painted.y >= engine.box[1] - 2
      && right <= engine.box[0] + engine.box[2] + 2
      && bottom <= engine.box[1] + engine.box[3] + 2,
      `${family.type}: label ${actual.id} spans (${actual.painted.x.toFixed(1)},${actual.painted.y.toFixed(1)})-(${right.toFixed(1)},${bottom.toFixed(1)}) outside its engine label box (${engine.box.join(",")})`,
    );
  }
}

describe("native engine canvas (T4)", () => {
  let fixture: NativeE2eDiagramE4Result;
  const shots: string[] = [];

  before(async () => {
    await waitForBridge();
    fixture = await runFixture();
    await fs.mkdir(EVIDENCE_DIR, { recursive: true });
  });

  it("draws every engine family's boxes, routes and label breaks in WKWebView", async () => {
    assert.equal(fixture.families.length, 5, `expected five engine families, got ${fixture.families.length}`);
    let containerRoutePoints = 0;
    for (const family of fixture.families) {
      await openDocument(family.documentTitle, { specSha256: family.specSha256 });
      const paint = await painted(
        family.nodes.map((node) => node.box),
        family.containers.map((container) => container.box),
      );
      assertFamilyPainted(paint, family);
      const samples = paint.routes.reduce((total, route) => total + route.pointsInContainers, 0);
      containerRoutePoints += samples;
      shots.push(await screenshot(`family-${family.type}`));
      console.log(`NATIVE_E4_FAMILY ${JSON.stringify({
        type: family.type,
        nodes: family.nodes.length,
        routes: family.routes.length,
        labels: family.labels.length,
        specSha256: family.specSha256,
        containerRouteSamples: samples,
        coveredRoutes: paint.routes.filter((route) => route.covered).map((route) => route.id),
      })}`);
    }
    // Without a route sample inside a lane, the paint-order check proves
    // nothing: the defect it exists for is a lane fill painted over a route.
    assert.ok(
      containerRoutePoints > 0,
      "no engine route was sampled inside a container, so the paint-order check was vacuous",
    );
  }).timeout(300_000);

  it("reopens v7, v8 and v9 documents without losing content", async () => {
    const byVersion = new Map(fixture.versions.map((version) => [version.v, version]));
    for (const v of [7, 8, 9]) {
      const version = byVersion.get(v);
      assert.ok(version, `the fixture reported no v${v} document`);
      assert.equal(version.sourceVersion, v, `v${v} document reports source version ${version.sourceVersion}`);
      assert.equal(version.migratedVersion, 9, `v${v} document did not migrate to the current schema`);
      assert.ok(version.nodeCount >= 2, `v${v} document lost nodes: ${version.nodeCount}`);
      assert.equal(version.reopenEqual, true, `v${v} document changed between two opens`);
    }
    // v7 mints a table dataset on upgrade; v8 and v9 must not duplicate one.
    assert.equal(byVersion.get(7)!.datasets, 1, "the v7 table upgrade did not mint exactly one dataset");
    assert.equal(byVersion.get(8)!.datasets, 0, "the v8 document gained a dataset from the version bump");
    assert.equal(byVersion.get(9)!.datasets, 1, "the v9 semantic document lost its dataset");

    for (const v of [7, 8]) {
      const version = byVersion.get(v)!;
      // The open list renders the document title, not the file name.
      await openDocument(version.documentTitle, { engine: false });
      // A legacy document carries no semantic dataset, so the canvas paints its
      // members from the document itself and none of them is engine-sourced.
      const legacy = await browser.execute(() => {
        const canvas = document.querySelector(".maru-diagram-canvas");
        if (!canvas) return null;
        return {
          engineMembers: canvas.querySelectorAll("[data-engine-source-id]").length,
          members: [...canvas.querySelectorAll<SVGGElement>("[data-node-id]")].map((node) => ({
            id: node.getAttribute("data-node-id") ?? "",
            box: (() => {
              const rect = node.getBoundingClientRect();
              return [Math.round(rect.width), Math.round(rect.height)] as [number, number];
            })(),
            // A plain member paints its title inside a foreignObject; the
            // engine's own labels use <text> instead.
            texts: [...node.querySelectorAll("foreignObject, text")]
              .map((element) => (element.textContent ?? "").trim())
              .filter((value) => value.length > 0),
          })),
        };
      });
      assert.ok(legacy, "the diagram canvas is not mounted");
      assert.equal(legacy.members.length, version.nodeCount,
        `v${v} painted ${legacy.members.length} of its ${version.nodeCount} members`);
      assert.equal(legacy.engineMembers, 0, `v${v} painted engine-sourced members it has no dataset for`);
      assert.ok(legacy.members.some((member) => member.texts.length > 0),
        `v${v} painted no member text: ${JSON.stringify(legacy.members)}`);
      assert.ok(legacy.members.every((member) => member.box[0] > 0 && member.box[1] > 0),
        `v${v} painted a member with no area: ${JSON.stringify(legacy.members)}`);
      shots.push(await screenshot(`legacy-v${v}`));
    }
  }).timeout(300_000);

  it("applies a structural edit, undoes, redoes and reopens it", async () => {
    assert.equal(fixture.apply.refused, true, "the engine must refuse the restricted edit");
    assert.ok(fixture.apply.refusalKeys.length > 0, "the refusal carried no diagnostic key");
    assert.equal(fixture.apply.historyAfterRefusal, 0, "a refused edit must not create a history entry");
    assert.equal(fixture.apply.applied, true, "the accepted edit did not apply");
    assert.equal(fixture.apply.historyAfterApply, 1, "an applied edit must cost exactly one history step");
    assert.equal(fixture.apply.undoRestored, true, "undo did not restore the pre-apply document");
    assert.equal(fixture.apply.redoRestored, true, "redo did not restore the applied document");
    assert.equal(
      fixture.apply.reopenedWithoutLoss,
      true,
      `the saved document lost content on reopen; the loader added only ${JSON.stringify(fixture.apply.addedFields)}`,
    );
    console.log(`NATIVE_E4_APPLY ${JSON.stringify(fixture.apply)}`);
  }).timeout(120_000);

  it("exports SVG and PNG on the native engine path with verified receipts", async () => {
    const started = await browser.execute(() => {
      const target = window as unknown as {
        __MARU_NATIVE_E2E__?: BridgeApi;
        __MARU_DIAGRAM_STATIC_EXPORT_RESULT__?: { status: string; result?: unknown; error?: string };
      };
      const fixtureFn = target.__MARU_NATIVE_E2E__?.diagramStaticExportFixture;
      if (typeof fixtureFn !== "function") return false;
      target.__MARU_DIAGRAM_STATIC_EXPORT_RESULT__ = { status: "pending" };
      void fixtureFn().then(
        (result) => { target.__MARU_DIAGRAM_STATIC_EXPORT_RESULT__ = { status: "complete", result }; },
        (error) => { target.__MARU_DIAGRAM_STATIC_EXPORT_RESULT__ = { status: "failed", error: String(error) }; },
      );
      return true;
    });
    assert.equal(started, true, "the native export fixture is missing; rebuild with VITE_NATIVE_E2E=1");
    await browser.waitUntil(async () => browser.execute(() => {
      const state = (window as unknown as {
        __MARU_DIAGRAM_STATIC_EXPORT_RESULT__?: { status: string };
      }).__MARU_DIAGRAM_STATIC_EXPORT_RESULT__;
      return state?.status === "complete" || state?.status === "failed";
    }), { timeout: 120_000, interval: 500, timeoutMsg: "the native export fixture exceeded 120 s" });
    const state = await browser.execute(() => (window as unknown as {
      __MARU_DIAGRAM_STATIC_EXPORT_RESULT__?: { status: string; result?: unknown; error?: string };
    }).__MARU_DIAGRAM_STATIC_EXPORT_RESULT__ ?? null);
    assert.ok(state, "the native export fixture produced no result");
    if (state.status !== "complete") {
      assert.fail(state.status === "failed" ? (state.error ?? "export failed") : "export still pending");
    }
    const result = state.result as {
      svgPath: string;
      pngPath: string;
      svgReceipt: { outputSha256?: string; readback?: { status?: string } };
      pngReceipt: { outputSha256?: string; readback?: { status?: string } };
    };
    const workspace = path.join(fixtureRootDir(), "workspace");
    for (const [key, receipt] of [["svg", result.svgReceipt], ["png", result.pngReceipt]] as const) {
      assert.match(receipt.outputSha256 ?? "", /^[0-9a-f]{64}$/, `${key} receipt has no output hash`);
      assert.equal(receipt.readback?.status, "passed", `${key} receipt was not verified by byte comparison`);
      const bytes = await fs.readFile(path.join(workspace, key === "svg" ? result.svgPath : result.pngPath));
      assert.ok(bytes.length > 100, `${key} export is empty`);
    }
    console.log(`NATIVE_E4_EXPORT ${JSON.stringify({ svg: result.svgReceipt.outputSha256, png: result.pngReceipt.outputSha256 })}`);
  }).timeout(180_000);

  it("pans, zooms and selects on the engine scene", async () => {
    await openDocument(fixture.families[1]!.documentTitle, { specSha256: fixture.families[1]!.specSha256 });
    const before = await painted();
    assert.ok(before.nodes.length > 1, "the pan/zoom probe needs a painted scene");

    const scene = () => browser.execute(() => {
      const group = document.querySelector<SVGGElement>(".maru-diagram-canvas > g[transform]");
      const match = /translate\(([-\d.]+),\s*([-\d.]+)\)\s*scale\(([-\d.]+)\)/.exec(group?.getAttribute("transform") ?? "");
      return match ? { px: Number(match[1]), py: Number(match[2]), zoom: Number(match[3]) } : null;
    });
    const start = await scene();
    assert.ok(start, "the canvas scene carries no viewport transform");

    // AC8 selection, on an engine member (a lane container is painted beneath
    // its nodes and is authored locked, so it cannot take a selection).
    const member = await browser.execute((wantedIds: string[]) => {
      const nodes = [...document.querySelectorAll<SVGGElement>(".maru-diagram-canvas [data-node-id]")]
        .filter((node) => wantedIds.includes(node.getAttribute("data-node-id") ?? ""));
      for (const node of nodes) {
        const rect = node.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const x = Math.round(rect.left + rect.width / 2);
        const y = Math.round(rect.top + rect.height / 2);
        if (document.elementFromPoint(x, y)?.closest("[data-node-id]") !== node) continue;
        return { id: node.getAttribute("data-node-id") ?? "", x, y };
      }
      return null;
    }, fixture.families[1]!.nodes.map((node) => node.id));
    assert.ok(member, "the canvas has no painted member to select");
    // The WKWebView reports itself unfocused under WebDriver, and while the app
    // believes it is inactive the terminal's first-mouse guard swallows every
    // pointerdown in the document (`stopImmediatePropagation` in the capture
    // phase), exactly as it does for a genuinely inactive window. Mark the
    // window focused, wait out the 150 ms activation grace, so the canvas sees
    // the gestures a user's focused window would give it.
    await browser.execute(async () => {
      window.dispatchEvent(new Event("focus"));
      await new Promise((resolve) => setTimeout(resolve, 400));
    });
    // The embedded driver injects synthetic mouse events only — an action never
    // produces a pointerdown — so the gestures below are dispatched here and the
    // app's own pointer handlers are what runs.
    const clicked = await browser.execute((wanted: { id: string; x: number; y: number }) => {
      const node = [...document.querySelectorAll<SVGGElement>(".maru-diagram-canvas [data-node-id]")]
        .find((candidate) => candidate.getAttribute("data-node-id") === wanted.id);
      if (!node) return false;
      const base = {
        bubbles: true, cancelable: true, pointerId: 7, pointerType: "mouse", isPrimary: true,
        button: 0, clientX: wanted.x, clientY: wanted.y,
      };
      node.dispatchEvent(new PointerEvent("pointerdown", { ...base, buttons: 1 }));
      node.dispatchEvent(new PointerEvent("pointerup", { ...base, buttons: 0 }));
      return true;
    }, member);
    assert.equal(clicked, true, `the painted member "${member.id}" is not in the scene`);
    await browser.waitUntil(async () => browser.execute((wanted: string) =>
      [...document.querySelectorAll(".maru-diagram-canvas [data-node-id].is-selected")]
        .some((node) => node.getAttribute("data-node-id") === wanted), member.id), {
      timeout: 15_000,
      interval: 250,
      timeoutMsg: `clicking painted member "${member.id}" did not select it`,
    });
    shots.push(await screenshot("selection"));

    // The canvas pans on Shift+drag over an empty part of the surface.
    const from = await browser.execute(() => {
      const surface = document.querySelector(".maru-diagram-canvas") as SVGSVGElement | null;
      if (!surface) return null;
      const rect = surface.getBoundingClientRect();
      const candidates = [0.85, 0.7, 0.5, 0.3];
      for (const vertical of candidates) {
        for (const horizontal of [0.5, 0.3, 0.7]) {
          const x = Math.round(rect.left + rect.width * horizontal);
          const y = Math.round(rect.top + rect.height * vertical);
          const hit = document.elementFromPoint(x, y);
          if (!hit || hit.closest("[data-node-id]") || hit.closest("[data-canvas-diagnostic]")) continue;
          return { x, y };
        }
      }
      return null;
    });
    assert.ok(from, "no empty canvas point is available to start a pan");
    const dragged = await browser.execute((wanted: { x: number; y: number }) => {
      const surface = document.querySelector(".maru-diagram-canvas") as SVGSVGElement | null;
      if (!surface) return false;
      const base = (x: number, y: number, buttons: number) => new PointerEvent("pointermove", {
        bubbles: true, cancelable: true, pointerId: 8, pointerType: "mouse", isPrimary: true,
        button: 0, buttons, shiftKey: true, clientX: x, clientY: y,
      });
      surface.dispatchEvent(new PointerEvent("pointerdown", {
        bubbles: true, cancelable: true, pointerId: 8, pointerType: "mouse", isPrimary: true,
        button: 0, buttons: 1, shiftKey: true, clientX: wanted.x, clientY: wanted.y,
      }));
      surface.dispatchEvent(base(wanted.x + 30, wanted.y + 20, 1));
      surface.dispatchEvent(base(wanted.x + 60, wanted.y + 40, 1));
      surface.dispatchEvent(new PointerEvent("pointerup", {
        bubbles: true, cancelable: true, pointerId: 8, pointerType: "mouse", isPrimary: true,
        button: 0, buttons: 0, shiftKey: true, clientX: wanted.x + 60, clientY: wanted.y + 40,
      }));
      return true;
    }, from);
    assert.equal(dragged, true, "the canvas surface could not take the pan gesture");
    await browser.waitUntil(async () => (await scene())?.px !== start.px, {
      timeout: 15_000,
      interval: 250,
      timeoutMsg: "Shift+drag did not pan the canvas",
    });
    const panned = await scene();
    assert.ok(panned, "the canvas scene lost its transform while panning");
    assert.equal(Math.round(panned.px - start.px), 60, `the pan moved x by ${panned.px - start.px}px instead of 60px`);
    assert.equal(Math.round(panned.py - start.py), 40, `the pan moved y by ${panned.py - start.py}px instead of 40px`);
    assert.equal(panned.zoom, start.zoom, "panning changed the zoom");
    shots.push(await screenshot("pan"));

    // The zoom group lives on the view tab, not the file tab the open used.
    assert.equal(await clickByText("보기") || await clickByText("View"), true, "The diagram view ribbon tab is missing");
    const zoomed = await clickByText("축소") || await clickByText("Zoom out");
    assert.equal(zoomed, true, "the ribbon's zoom-out control is missing");
    await browser.waitUntil(async () => {
      const next = await scene();
      return next !== null && next.zoom < panned.zoom;
    }, { timeout: 15_000, interval: 250, timeoutMsg: "zoom-out did not shrink the scene" });
    const zoomLabel = await browser.execute(() =>
      (document.querySelector(".maru-diagram-zoom-label")?.textContent ?? "").trim());
    assert.notEqual(zoomLabel, "", "the zoom readout is empty after zooming");
    const zoomedScene = await scene();
    assert.ok(zoomedScene, "the canvas scene lost its transform while zooming");
    shots.push(await screenshot("zoom"));

    console.log(`NATIVE_E4_INTERACTION ${JSON.stringify({
      zoomLabel,
      pan: { dx: panned.px - start.px, dy: panned.py - start.py },
      zoom: { before: panned.zoom, after: zoomedScene.zoom },
      selected: member.id,
    })}`);
  }).timeout(180_000);

  it("anchors the engine's refusal diagnostic beside its element", async () => {
    const refusal = fixture.refusal;
    // The refusing document is the only one whose layout the engine refuses,
    // so the canvas settles on `refused` rather than a stale scene.
    await openDocument(refusal.documentTitle, { specSha256: refusal.specSha256 });
    const state = await browser.execute(() => {
      const canvas = document.querySelector(".maru-diagram-canvas");
      if (!canvas) return null;
      const badge = canvas.querySelector<SVGGElement>("[data-canvas-diagnostic]");
      const target = badge
        ? canvas.querySelector<SVGGElement>(`[data-node-id="${badge.getAttribute("data-target-id") ?? ""}"]`)
        : null;
      const badgeRect = badge?.getBoundingClientRect() ?? null;
      const targetRect = target?.getBoundingClientRect() ?? null;
      const match = /translate\(([-\d.]+),\s*([-\d.]+)\)/.exec(badge?.getAttribute("transform") ?? "");
      return {
        status: canvas.getAttribute("data-engine-geometry-status"),
        specSha256: canvas.getAttribute("data-engine-spec-sha256"),
        code: badge?.getAttribute("data-canvas-diagnostic") ?? null,
        targetKind: badge?.getAttribute("data-target-kind") ?? null,
        targetId: badge?.getAttribute("data-target-id") ?? null,
        label: badge?.getAttribute("aria-label") ?? "",
        at: match ? { x: Number(match[1]), y: Number(match[2]) } : null,
        notice: document.querySelectorAll("[data-canvas-diagnostic-notice]").length,
        gap: badgeRect && targetRect ? badgeRect.left - targetRect.right : null,
        topDelta: badgeRect && targetRect ? badgeRect.top - targetRect.top : null,
      };
    });
    assert.ok(state, "the diagram canvas is not mounted");
    assert.equal(state.status, "refused", `the refusing document settled on "${state.status}"`);
    assert.match(state.specSha256 ?? "", /^[0-9a-f]{64}$/, "the refused canvas lost the engine spec hash");
    assert.equal(state.code, refusal.code, `the canvas shows "${state.code}" instead of the engine's "${refusal.code}"`);
    assert.equal(state.targetKind, refusal.targetKind, "the diagnostic is anchored to a different kind of element");
    assert.equal(state.targetId, refusal.targetId, "the diagnostic is anchored to a different element");
    assert.equal(state.notice, 0, "an anchored diagnostic must not also collapse into the canvas notice");
    assert.ok(state.label.includes(refusal.code) && state.label.includes(refusal.path),
      `the badge's details do not carry the engine's code and path: ${state.label}`);
    // The engine's own anchor: immediately right of the member's box, at its top.
    assert.ok(state.at, "the diagnostic badge carries no placement transform");
    assert.equal(state.at.x, refusal.targetX, `the badge sits at x=${state.at.x}, the engine anchored x=${refusal.targetX}`);
    assert.equal(state.at.y, refusal.targetY, `the badge sits at y=${state.at.y}, the engine anchored y=${refusal.targetY}`);
    assert.ok(state.gap !== null && state.gap >= 0 && state.gap <= 24,
      `the badge is not beside the member it names (gap ${state.gap}px)`);
    assert.ok(state.topDelta !== null && Math.abs(state.topDelta) <= 2,
      `the badge is not at the member's top edge (offset ${state.topDelta}px)`);
    shots.push(await screenshot("refusal-diagnostic"));
    console.log(`NATIVE_E4_DIAGNOSTIC ${JSON.stringify({ code: state.code, targetId: state.targetId, at: state.at })}`);
  }).timeout(180_000);

  it("draws the same scene in the English UI", async () => {
    const switched = await browser.execute(() => {
      const toggle = [...document.querySelectorAll<HTMLElement>("button")]
        .find((button) => ["KO", "EN"].includes((button.textContent ?? "").trim()));
      if (!toggle) return false;
      toggle.click();
      return true;
    });
    assert.equal(switched, true, "the UI language toggle is missing");
    await browser.waitUntil(async () => browser.execute(() => {
      const toggle = [...document.querySelectorAll<HTMLElement>("button")]
        .find((button) => ["KO", "EN"].includes((button.textContent ?? "").trim()));
      return (toggle?.textContent ?? "").trim() === "EN";
    }), { timeout: 15_000, interval: 250, timeoutMsg: "the UI did not switch to English" });
    const family = fixture.families[0]!;
    await openDocument(family.documentTitle, { specSha256: family.specSha256 });
    assertFamilyPainted(
      await painted(
        family.nodes.map((node) => node.box),
        family.containers.map((container) => container.box),
      ),
      family,
    );
    shots.push(await screenshot("english-ui"));
  }).timeout(180_000);

  after(async () => {
    // The summary is written here so a failing case still leaves its screenshots.
    await fs.mkdir(EVIDENCE_DIR, { recursive: true });
    await fs.writeFile(
      path.join(EVIDENCE_DIR, "screenshots.json"),
      `${JSON.stringify({ captured: shots, at: new Date().toISOString() }, null, 2)}\n`,
    );
    console.log(`NATIVE_E4_SCREENSHOTS ${JSON.stringify(shots)}`);
  });
});

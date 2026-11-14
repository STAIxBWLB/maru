// T2 (#553 E5): the real macOS app renders a nested Floorplan map through the
// native SVG export command, in WKWebView, with the production engine.
//
// The map is synthetic and carries no `diagram_type`, so this is the whole path
// a saved map travels on export: the plugin command, the family's own layout
// entry point, the E2 router and the E3 writer. Two harness limits are recorded
// rather than papered over:
//  - The command is invoked through `__TAURI_INTERNALS__.invoke` because the
//    export dialog's own button path needs a saved document in a fixture
//    workspace; what is under test here is the engine path, and the capability
//    (`maru-diagram:allow-render-svg`) is the production one.
//  - Chromium cannot stand in for this: the native build is what ships, and the
//    outline text mode of the native export is not the browser build's.
import assert from "node:assert/strict";
import type {} from "webdriverio";

interface ArtifactReport {
  ok: boolean;
  svg: string | null;
  width: number | null;
  height: number | null;
  diagnostics: Array<{ code: string; message: string; path: string }>;
}

/** What the page hands back: the command either reports or refuses. */
type RenderOutcome =
  | { kind: "report"; report: ArtifactReport }
  | { kind: "refusal"; code: string; diagnostics: Array<{ code: string; path: string; message: string }> };

/** A three-level map: frames sized from their children, edges leaving them. */
const NESTED_MAP = {
  $schema: "floorplan/architecture@1",
  project: {
    name: "중첩 지도 렌더",
    summary: "Frames sized from the cells they hold, edges that cross their borders.",
  },
  nodes: [
    { id: "web", label: "웹 애플리케이션", kind: "service" },
    {
      id: "web.ui",
      parent: "web",
      label: "UI (React)",
      kind: "ui",
      summary: "화면과 입력 처리 계층",
    },
    { id: "web.api", parent: "web", label: "API server", kind: "service" },
    { id: "web.api.auth", parent: "web.api", label: "인증 auth", kind: "feature" },
    { id: "web.adapters", parent: "web", label: "Adapters", kind: "library" },
    { id: "store", label: "데이터 저장소", kind: "data", summary: "Postgres" },
  ],
  edges: [
    { from: "web.api.auth", to: "store", kind: "data" },
    { from: "web.adapters", to: "web.api", kind: "event" },
  ],
  flows: [
    {
      id: "sign-in",
      title: "로그인",
      steps: [{ node: "web.ui" }, { node: "web.api.auth" }, { node: "store" }],
    },
  ],
  tour: [{ node: "web", title: "입구" }],
};

function request(document: unknown): string {
  return JSON.stringify({
    specJson: JSON.stringify(document),
    format: "svg",
    theme: "light",
    pixelRatio: 1,
  });
}

async function renderThroughTheApp(input: string): Promise<RenderOutcome> {
  return browser.execute(async (request: string) => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__?: { invoke: (command: string, args: object) => Promise<unknown> };
      }
    ).__TAURI_INTERNALS__;
    if (typeof internals?.invoke !== "function") {
      throw new Error("the app's Tauri IPC bridge is unavailable");
    }
    // The command refuses an unrenderable map by rejecting with its diagnostics,
    // so both arms are read here: the refusal is the assertion, not a driver
    // error with an unreadable message.
    return internals
      .invoke("plugin:maru-diagram|render_svg", { input: request })
      .then(
        (report) => ({ kind: "report" as const, report: report as unknown }),
        (error) => {
          const refusal = (error ?? {}) as {
            code?: string;
            diagnostics?: Array<{ code: string; path: string; message: string }>;
          };
          return {
            kind: "refusal" as const,
            code: refusal.code ?? "unknown",
            diagnostics: refusal.diagnostics ?? [],
          };
        },
      );
  }, input) as unknown as Promise<RenderOutcome>;
}

describe("floorplan SVG export in the real app", () => {
  before(async () => {
    await browser.waitUntil(
      async () =>
        browser.execute(() => {
          const internals = (
            window as unknown as {
              __TAURI_INTERNALS__?: { invoke?: unknown };
            }
          ).__TAURI_INTERNALS__;
          return typeof internals?.invoke === "function";
        }),
      {
        timeout: 30_000,
        interval: 250,
        timeoutMsg:
          "The app's IPC bridge never came up; rebuild with pnpm build:frontend:native-e2e and rerun make test-e2e-native",
      },
    );
  });

  it("renders the nested parts and an edge that leaves its frame", async () => {
    const outcome = await renderThroughTheApp(request(NESTED_MAP));
    assert.equal(outcome.kind, "report", JSON.stringify(outcome));
    const report = (outcome as { report: ArtifactReport }).report;
    assert.equal(report.ok, true, JSON.stringify(report.diagnostics));
    const svg = report.svg;
    assert.ok(svg, "a passing export carries its SVG");

    // Both frames are painted as containers, the nested one inside the outer.
    assert.match(svg, /data-source-id="web:section"/);
    assert.match(svg, /data-source-id="web\.api:section"/);
    // Members and their labels survive the walk: a Korean name and a mixed one.
    assert.match(svg, /data-source-id="web\.api\.auth"/);
    assert.ok(svg.includes("인증 auth"), "a nested member's label is painted");
    assert.ok(svg.includes("데이터 저장소"), "a top-level member's label is painted");
    assert.ok(svg.includes("중첩 지도 렌더"), "the project name is the page title");
    // The two edges are routed, and the asynchronous one carries the dash.
    assert.match(svg, /data-kind="route-path"/);
    assert.match(svg, /data-route-variant="dashed"/);
    assert.ok(svg.includes('data-route-role="event"'), "the upstream kind travels as the role");
    // The emitted page is a real size, not a degenerate one.
    assert.ok((report.width ?? 0) > 0 && (report.height ?? 0) > 0);
    assert.ok(!svg.includes("<!DOCTYPE"), "the artifact carries no document type");
  });

  it("exports the same bytes for the same map", async () => {
    const first = await renderThroughTheApp(request(NESTED_MAP));
    const second = await renderThroughTheApp(request(NESTED_MAP));
    assert.equal(first.kind, "report");
    assert.equal(second.kind, "report");
    const left = (first as { report: ArtifactReport }).report;
    const right = (second as { report: ArtifactReport }).report;
    assert.equal(left.ok, true, JSON.stringify(left.diagnostics));
    assert.equal(right.ok, true, JSON.stringify(right.diagnostics));
    assert.equal(left.svg, right.svg);
  });

  it("refuses a map whose edge names nothing instead of drawing it", async () => {
    const broken = structuredClone(NESTED_MAP);
    broken.edges = [{ from: "web.api.ghost", to: "store", kind: "call" }];
    const outcome = await renderThroughTheApp(request(broken));
    assert.equal(outcome.kind, "refusal", "an unresolvable endpoint is refused, never drawn");
    const refusal = outcome as { code: string; diagnostics: Array<{ path: string }> };
    assert.ok(
      refusal.diagnostics.some((diagnostic) => diagnostic.path.includes("/edges/0/from")),
      `the refusal names the field: ${JSON.stringify(refusal)}`,
    );
  });
});

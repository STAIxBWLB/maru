// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createOfflineViewerHtml,
  OFFLINE_VIEWER_RUNTIME_BUDGET_BYTES,
} from "./offlineViewer";

// S1's generated architecture-light.svg; the screenshot receipt records this exact SVG hash.
const REAL_S1_SVG_SHA256 = "3317383217e8f59e8099685cdf53926a7de5e31f201b7c04b4b53fa2e5313f5f";
const realSvg = readFileSync("src/lib/diagram/viewer/__fixtures__/architecture-light.svg", "utf8");
// Source data mirrors seedFor("architecture") plus the S1 screenshot script's title/subtitle/CJK label edits.
const REAL_S1_SPEC_SHA256 = "ae9c9e83ca21229ed77c250e246a7d49d1f05b0899b05ca12db7e7e378a5edc3";
const realSpec = readFileSync("src/lib/diagram/viewer/__fixtures__/architecture-light.spec.json", "utf8");
const hostileLabel = "</script><script>globalThis.__viewerPwned=1</script><img src=x onerror=alert(1)>";
const S1_FAMILY_SVG_HASHES: Record<string, string> = {
  workflow: "8800e4f67655f6a5367cd4ed55e019893f42c18731012e12e38ed6cc85883809",
  sequence: "6a6ca57982bc10d048c7687d27d0eea900dac946598c7ad6b96d6a016442f774",
  dataflow: "5fe0541d3eccec9ce880e5e6eb6265d1363ad9f5cba78983130aa6c270b20187",
  lifecycle: "9c5b80385fefc485a9fd2a7504f31c5e67cfe5cbebf3547edafcd06b37d35994",
};
type ScreenshotNode = { id: string; label: string; [key: string]: unknown };

function screenshotSpecFor(family: string): { specJson: string; nodes: ScreenshotNode[] } {
  const meta = { title: `마루 ${family} 렌더`, output: "fixture.html", subtitle: "결정적 SVG · 접근성 검증" };
  const labels = ["입력", "처리", "완료"];
  let spec: Record<string, unknown>;
  let nodes: ScreenshotNode[];
  if (family === "workflow") {
    nodes = [
      { id: "a", type: "frontend", label: labels[0]!, lane: "main", col: 0, width: 96, height: 48 },
      { id: "b", type: "backend", label: labels[1]!, lane: "main", col: 2, width: 96, height: 48 },
      { id: "c", type: "backend", label: labels[2]!, lane: "main", col: 4, width: 96, height: 48 },
    ];
    spec = { schema_version: 1, diagram_type: family, meta, lanes: [{ id: "main", label: "Main" }], nodes, edges: [{ from: "a", to: "b", role: "main" }, { from: "b", to: "c", role: "main" }] };
  } else if (family === "sequence") {
    nodes = [{ id: "a", type: "frontend", label: labels[0]! }, { id: "b", type: "backend", label: labels[1]! }];
    spec = { schema_version: 1, diagram_type: family, meta, participants: nodes, messages: [{ from: "a", to: "b", y: 180, label: "Call" }] };
  } else if (family === "dataflow") {
    nodes = [{ id: "a", type: "frontend", label: labels[0]!, stage: 0, row: 0 }, { id: "b", type: "backend", label: labels[1]!, stage: 1, row: 0 }];
    spec = { schema_version: 1, diagram_type: family, meta, stages: [{ label: "Input" }, { label: "Output" }], nodes, flows: [{ from: "a", to: "b", label: "Data" }] };
  } else {
    nodes = [{ id: "a", type: "start", label: labels[0]!, lane: "main", col: 0 }, { id: "b", type: "active", label: labels[1]!, lane: "main", col: 1 }];
    spec = { schema_version: 1, diagram_type: "lifecycle", meta, lanes: [{ id: "main", label: "Main" }], states: nodes, transitions: [{ from: "a", to: "b", label: "Start" }] };
  }
  return { specJson: JSON.stringify(spec), nodes };
}

describe("offline engine viewer HTML", () => {
  it("uses the byte-pinned S1 renderer fixture and is deterministic", () => {
    expect(createHash("sha256").update(realSvg).digest("hex")).toBe(REAL_S1_SVG_SHA256);
    expect(createHash("sha256").update(realSpec).digest("hex")).toBe(REAL_S1_SPEC_SHA256);
    const source = JSON.parse(realSpec);
    const svgDocument = new DOMParser().parseFromString(realSvg, "image/svg+xml");
    expect(svgDocument.querySelector("title")?.textContent).toBe(source.meta.title);
    expect(svgDocument.querySelector('[data-kind="label"][data-target-id="a"]')?.getAttribute("aria-label")).toBe(source.components[0].label);
    expect(svgDocument.querySelector('[data-kind="label"][data-target-id="b"]')?.getAttribute("aria-label")).toBe(source.components[1].label);
    expect(svgDocument.querySelector('[data-kind="label"][data-target-id="connection:0"]')?.getAttribute("aria-label")).toBe(source.connections[0].label);
    const input = { svg: realSvg, specJson: realSpec };
    expect(createOfflineViewerHtml(input)).toBe(createOfflineViewerHtml(input));
  });

  it.each(Object.entries(S1_FAMILY_SVG_HASHES))("accepts the generated S1 %s SVG profile", (family, expectedHash) => {
    // Captures/hashes are copied from the approved S1 screenshot receipt; source inputs mirror seedFor and its screenshot label edits.
    const svg = readFileSync(`src/lib/diagram/viewer/__fixtures__/${family}-light.svg`, "utf8");
    expect(createHash("sha256").update(svg).digest("hex")).toBe(expectedHash);
    const { specJson, nodes } = screenshotSpecFor(family);
    const spec = JSON.parse(specJson);
    const document = new DOMParser().parseFromString(svg, "image/svg+xml");
    expect(document.querySelector("parsererror")).toBeNull();
    expect(document.querySelector("title")?.textContent).toBe(spec.meta.title);
    for (const node of nodes) {
      expect(document.querySelector(`[data-kind="label"][data-target-id="${node.id}"]`)?.getAttribute("aria-label")).toBe(node.label);
    }
    expect(() => createOfflineViewerHtml({ svg, specJson })).not.toThrow();
  });

  it("escapes hostile source labels in the inert JSON and escapes the caller title", () => {
    const hostile = JSON.parse(realSpec);
    hostile.components[0].label = hostileLabel;
    const html = createOfflineViewerHtml({
      svg: realSvg,
      specJson: JSON.stringify(hostile),
      title: `Viewer <img src=x onerror="alert(2)">`,
    });
    const document = new DOMParser().parseFromString(html, "text/html");
    const source = document.getElementById("offline-viewer-source");
    expect(source?.getAttribute("type")).toBe("application/json");
    expect(JSON.parse(source?.textContent ?? "{}").components[0].label).toBe(hostileLabel);
    expect(document.title).toBe(`Viewer <img src=x onerror="alert(2)">`);
    expect(document.querySelectorAll("script")).toHaveLength(2);
    expect(document.querySelectorAll("img")).toHaveLength(0);
    expect(html).not.toContain("</script><script>globalThis.__viewerPwned");
  });

  it("accepts URL-like aria-label text but rejects active SVG elements and attributes", () => {
    const labelText = realSvg.replace('aria-label="a → b"', 'aria-label="url(https://example.invalid)"');
    expect(() => createOfflineViewerHtml({ svg: labelText, specJson: realSpec })).not.toThrow();

    const activeElement = realSvg.replace("</svg>", "<script>globalThis.__viewerPwned=1</script></svg>");
    expect(() => createOfflineViewerHtml({ svg: activeElement, specJson: realSpec })).toThrow(/refused the source SVG/i);
    const activeAttribute = realSvg.replace('role="img"', 'onload="alert(1)" role="img"');
    expect(() => createOfflineViewerHtml({ svg: activeAttribute, specJson: realSpec })).toThrow(/refused the source SVG/i);
  });

  it("allows only the exact inline runtime and stylesheet hashes under a no-network CSP", () => {
    const html = createOfflineViewerHtml({ svg: realSvg, specJson: realSpec });
    const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
    const runtime = html.match(/<script>([\s\S]*?)<\/script><\/body>/)?.[1];
    const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
    expect(style).toBeDefined();
    expect(runtime).toBeDefined();
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("font-src 'none'");
    expect(csp).not.toContain("unsafe-inline");
    const hash = (value: string) => `sha256-${createHash("sha256").update(value).digest("base64")}`;
    expect(csp).toContain(`'${hash(style!)}'`);
    expect(csp).toContain(`'${hash(runtime!)}'`);
    expect(Buffer.byteLength(runtime!, "utf8")).toBeLessThanOrEqual(OFFLINE_VIEWER_RUNTIME_BUDGET_BYTES);
    expect(html).not.toMatch(/<(?:script|link)[^>]+(?:src|href)=/i);
    expect(html).not.toMatch(/@import\s/i);
  });

  it("rejects malformed source JSON before producing an HTML artifact", () => {
    expect(() => createOfflineViewerHtml({ svg: realSvg, specJson: "</script><script>bad</script>" })).toThrow(
      "The offline viewer requires a valid JSON source spec.",
    );
  });
});

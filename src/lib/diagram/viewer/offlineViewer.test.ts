import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  createOfflineViewerHtml,
  OFFLINE_VIEWER_RUNTIME_BUDGET_BYTES,
} from "./offlineViewer";

// S1's generated architecture-light.svg; the screenshot receipt records this exact SVG hash.
const REAL_S1_SVG_SHA256 = "3317383217e8f59e8099685cdf53926a7de5e31f201b7c04b4bfa2e5313f5f";
const realSvg = readFileSync(new URL("./__fixtures__/architecture-light.svg", import.meta.url), "utf8");

function sourceSpec(label = "입력"): string {
  return JSON.stringify({
    schema_version: 1,
    diagram_type: "architecture",
    meta: {
      title: "마루 architecture 렌더",
      subtitle: "결정적 SVG · 접근성 검증",
      output: "fixture.html",
    },
    layout: { mode: "grid", cols: 4 },
    components: [
      { id: "a", type: "frontend", label, row: 0, col: 0 },
      { id: "b", type: "backend", label: "처리", row: 0, col: 1 },
    ],
    connections: [{ from: "a", to: "b", label: "Call" }],
  });
}

describe("offline engine viewer HTML", () => {
  it("uses the byte-pinned S1 renderer fixture and is deterministic", () => {
    expect(createHash("sha256").update(realSvg).digest("hex")).toBe(REAL_S1_SVG_SHA256);
    const input = { svg: realSvg, specJson: sourceSpec() };
    expect(createOfflineViewerHtml(input)).toBe(createOfflineViewerHtml(input));
  });

  it("embeds hostile spec text as inert JSON and escapes the title as text", () => {
    const hostileLabel = "</script><script>globalThis.__viewerPwned=1</script><img src=x onerror=alert(1)>";
    const html = createOfflineViewerHtml({
      svg: realSvg,
      specJson: sourceSpec(hostileLabel),
      title: `Viewer <img src=x onerror="alert(2)">`,
    });
    const dom = new JSDOM(html);
    const { document } = dom.window;
    const source = document.getElementById("offline-viewer-source");
    expect(source?.getAttribute("type")).toBe("application/json");
    expect(JSON.parse(source?.textContent ?? "{}").components[0].label).toBe(hostileLabel);
    expect(document.title).toBe(`Viewer <img src=x onerror="alert(2)">`);
    expect(document.querySelectorAll("script")).toHaveLength(2);
    expect(document.querySelectorAll("img")).toHaveLength(0);
    expect(html).not.toContain("</script><script>globalThis.__viewerPwned");
    dom.window.close();
  });

  it("allows only the exact inline runtime and stylesheet hashes under a no-network CSP", () => {
    const html = createOfflineViewerHtml({ svg: realSvg, specJson: sourceSpec() });
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

// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { extractEngineSvg, sanitizeEngineSvgArtifact } from "./engineSvg";

const html = `<html data-preset="editorial-plate"><head><style>
:root{--text:#111;font-family:system-ui} [data-theme="dark"]{--text:#eee}
.t-label{fill:var(--text);font-size:14px} .toolbar{color:red}
.t-label:hover{fill:red} .c-backend{fill:url(https://example.invalid/a)}
</style></head><body><button class="toolbar">Viewer</button><svg viewBox="0 0 400 200" aria-label="한글 구조" data-focus="private">
<defs><marker id="arrow"><path d="M0 0 L4 2"/></marker></defs>
<g data-node-context="/Users/fixture/private" role="button" tabindex="0"><text class="t-label">한글 日本語 中文</text></g>
<path d="M0 0L2 2" marker-end="url(#arrow)" onclick="alert(1)"/>
<image href="https://example.invalid/image.png"/><foreignObject><div>unsafe</div></foreignObject>
<script>window.engineExecuted=true</script></svg></body></html>`;

describe("engine SVG static conversion", () => {
  it.each(["light", "dark"] as const)("keeps semantic CJK/accessibility and only safe SVG CSS for %s", (theme) => {
    const result = extractEngineSvg(html, theme);
    expect(result).toContain("한글 日本語 中文");
    expect(result).toContain('aria-label="한글 구조"');
    expect(result).toContain(`data-theme="${theme}"`);
    expect(result).toContain("--text");
    expect(result).toContain("marker-end=\"url(#arrow)\"");
    expect(result).not.toMatch(/script|onclick|foreignObject|unsafe|example.invalid|\/Users\/|tabindex|data-focus|data-node|\.toolbar|:hover/);
    expect((window as unknown as Record<string, unknown>).engineExecuted).toBeUndefined();
    const parsed = new DOMParser().parseFromString(result, "image/svg+xml");
    expect(parsed.querySelector("parsererror")).toBeNull();
    expect([...parsed.querySelectorAll("*")].every((element) => element.namespaceURI === "http://www.w3.org/2000/svg")).toBe(true);
  });

  it("refuses zero/multiple roots and invalid dimensions instead of cropping", () => {
    for (const artifact of ["<html/>", "<svg/><svg/>", '<svg viewBox="0 0 -1 2"/>', '<svg viewBox="0 0 9000 9000"/>']) {
      expect(() => extractEngineSvg(artifact)).toThrow(/retry|regenerate/i);
    }
  });

  it("refuses private paths in visible semantic labels", () => {
    expect(() => extractEngineSvg('<svg viewBox="0 0 10 10"><text>/Users/fixture/secret</text></svg>')).toThrow(/remove private paths/i);
  });

  it("sanitizes standalone Rust SVG with the existing DOMPurify profile before DOM use", () => {
    const safe = sanitizeEngineSvgArtifact('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10" data-artifact="engine" aria-label="한글 구조" onload="alert(1)"><script>alert(1)</script><text data-kind="label-text" style="font-feature-settings:\'liga\' 0,\'clig\' 0,\'calt\' 0,\'locl\' 0,\'kern\' 0,\'mark\' 0,\'mkmk\' 0">한글</text><path d="M0 0L2 2" onclick="alert(2)" fill="url(https://example.invalid/a)"/><image href="https://example.invalid/image.png"/></svg>', "dark");
    expect(safe).toContain("한글");
    expect(safe).toContain('data-theme="dark"');
    expect(safe).toContain('aria-label="한글 구조"');
    expect(safe).toContain('data-artifact="engine"');
    expect(safe).toContain('data-kind="label-text"');
    expect(safe).toContain("font-feature-settings");
    expect(safe).not.toMatch(/script|onload|onclick|example\.invalid/);
    expect(() => sanitizeEngineSvgArtifact("<html><svg/></html>")).toThrow(/valid SVG root/i);
  });

  it("accepts the native 1k logical viewBox without inheriting legacy crop limits", () => {
    const large = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1968 8878"><text aria-label="large diagram">Diagram</text></svg>';
    expect(sanitizeEngineSvgArtifact(large)).toContain('viewBox="0 0 1968 8878"');
    expect(() => extractEngineSvg(large)).toThrow(/invalid or oversized dimensions/i);
    expect(() => sanitizeEngineSvgArtifact('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16385 1"/>')).toThrow(/oversized viewBox/i);
    expect(() => sanitizeEngineSvgArtifact('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 9000 9000"/>')).toThrow(/oversized viewBox/i);
  });

  it("preserves inert filesystem-looking labels while removing file and external resource references", () => {
    const result = sanitizeEngineSvgArtifact('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 10"><text aria-label="source /tmp/a">/tmp/a</text><image href="file:///tmp/a.png"/><path d="M0 0L2 2" fill="url(https://example.invalid/fill)"/></svg>');
    expect(result).toContain('aria-label="source /tmp/a"');
    expect(result).toContain(">/tmp/a</text>");
    expect(result).not.toMatch(/file:|example\.invalid/);
  });
});

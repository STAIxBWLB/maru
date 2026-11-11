import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import "../../../lib/i18n/testing";
import { LocaleContext, t } from "../../../lib/i18n";
import type { CanvasDiagnosticPlacement } from "../../../lib/diagram/canvasDiagnostics";
import { CanvasDiagnostics } from "./CanvasDiagnostics";

const item: CanvasDiagnosticPlacement = {
  diagnostic: { code: "workflow/geometry-label-fit", path: "/nodes/0/label", rule: "fit", message: "Label is too wide <source>", fix: "Shorten the label" },
  category: "text",
  target: { kind: "label", id: "node:draft:label", x: 388, y: 300 },
};
function render(locale: "ko" | "en", items: CanvasDiagnosticPlacement[], scope: "elements" | "canvas" = "elements") {
  return renderToStaticMarkup(
    <LocaleContext.Provider value={{ locale, setLocale: () => {}, t: (key, vars) => t(locale, key, vars) }}>
      <svg><CanvasDiagnostics items={items} scope={scope} /></svg>
    </LocaleContext.Provider>,
  );
}

describe("localized read-only canvas diagnostics", () => {
  it.each(["ko", "en"] as const)("shows a cause and next step in %s with original details safely retained", (locale) => {
    const svg = render(locale, [item]);
    expect(svg).toContain(t(locale, "diagram.canvasDiagnostic.text.summary"));
    expect(svg).toContain(t(locale, "diagram.canvasDiagnostic.text.fix"));
    expect(svg).toContain("Label is too wide &lt;source&gt;");
    expect(svg).toContain("Shorten the label");
    expect(svg).toContain('data-target-id="node:draft:label"');
    expect(svg).toContain('transform="translate(388,300)"');
    expect(svg).toContain("data-export-ignore");
    expect(svg).not.toContain("<source>");
  });
  it("keeps untargeted diagnostics in the canvas notice only", () => {
    const unanchored = { ...item, target: null };
    expect(render("ko", [unanchored])).not.toContain("data-canvas-diagnostic");
    expect(render("ko", [unanchored], "canvas")).toContain("data-canvas-diagnostic-notice");
    expect(render("en", [item], "canvas")).not.toContain("data-canvas-diagnostic-notice");
  });
});

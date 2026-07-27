// Static guard for the shared <select> base chrome (src/styles.css `select`
// rule): the chevron is a background-image, so any scoped rule that sets the
// `background` SHORTHAND silently resets it away while the reserved padding
// stays — the exact bug the base rule fixed. The e2e select-audit only sees
// mounted selects; lazily loaded stylesheets (graph.css, diagram.css) need a
// static check. Scope: rules whose selector mentions "select" at all.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = join(__dirname, "..");

function collectCssFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "node_modules") out.push(...collectCssFiles(path));
    } else if (entry.name.endsWith(".css")) {
      out.push(path);
    }
  }
  return out;
}

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

// A rule "targets a select" if the SUBJECT of its selector (the rightmost
// compound) is the `select` element or carries a class with "select" as a
// whole hyphen-delimited segment (.inbox-source-select yes; .selected,
// ::selection, .source-selector, .skill-select input no).
function targetsSelect(selector: string): boolean {
  const subject = selector.split(/[\s>+~]+/).pop()?.replace(/:{1,2}[\w-]+(\([^)]*\))?/g, "") ?? "";
  if (/^select([.\[#]|$)/.test(subject)) return true; // bare select element
  for (const match of subject.matchAll(/\.([_a-zA-Z][\w-]*)/g)) {
    if (match[1].split("-").includes("select")) return true;
  }
  return false;
}

describe("select base chrome invariant", () => {
  it("no select-targeting rule uses the background shorthand", () => {
    const violations: string[] = [];
    for (const file of collectCssFiles(SRC_ROOT)) {
      const css = stripComments(readFileSync(file, "utf8"));
      // Unnested and nested rules alike: `selector { body }` with brace-free
      // bodies still matches inner rules inside @media/@container blocks.
      for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const selectors = match[1].trim();
        const body = match[2];
        if (!selectors.split(",").some((s) => targetsSelect(s.trim()))) continue;
        if (/(^|;)\s*background\s*:/.test(body)) {
          violations.push(`${file}: ${selectors.split("\n").pop()?.trim()}`);
        }
      }
    }
    expect(
      violations,
      `select rules must use background-color, not the background shorthand:\n${violations.join("\n")}`,
    ).toEqual([]);
  });

  it("the base select rule still draws the chevron", () => {
    const css = stripComments(readFileSync(join(SRC_ROOT, "styles.css"), "utf8"));
    const base = /(^|\})\s*select\s*\{([^{}]*)\}/.exec(css);
    expect(base, "base select rule missing").not.toBeNull();
    expect(base![2]).toContain("appearance: none");
    expect(base![2]).toContain("background-image");
  });
});

// Guard for the shared <select> base chrome in src/styles.css: the chevron is
// a background-image on the base `select` rule, so any scoped rule that sets
// the `background` SHORTHAND silently resets it away while the reserved
// padding stays — the exact bug the base rule fixed. The e2e select-audit
// only sees mounted selects; lazily loaded stylesheets (graph.css,
// diagram.css) need this static check.
//
// Scope: rules whose selector SUBJECT (rightmost compound) targets a select —
// the bare `select` element, or a class with "select" as a whole
// hyphen-delimited segment (.inbox-source-select yes; .selected,
// ::selection, .source-selector, .skill-select input no).
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "../src");

function collectCssFiles(dir) {
  const out = [];
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

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

function targetsSelect(selector) {
  const subject =
    selector
      .split(/[\s>+~]+/)
      .pop()
      ?.replace(/:{1,2}[\w-]+(\([^)]*\))?/g, "") ?? "";
  if (/^select([.\[#]|$)/.test(subject)) return true; // bare select element
  for (const match of subject.matchAll(/\.([_a-zA-Z][\w-]*)/g)) {
    if (match[1].split("-").includes("select")) return true;
  }
  return false;
}

const violations = [];
let baseFound = false;
for (const file of collectCssFiles(srcRoot)) {
  const css = stripComments(readFileSync(file, "utf8"));
  // `selector { body }` with brace-free bodies still matches rules nested
  // inside @media/@container blocks.
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1].trim();
    const body = match[2];
    if (!selectors.split(",").some((s) => targetsSelect(s.trim()))) continue;
    if (/(^|;)\s*background\s*:/.test(body)) {
      violations.push(`${file}: ${selectors.split("\n").pop()?.trim()}`);
    }
    if (selectors === "select") {
      if (body.includes("appearance: none") && body.includes("background-image")) {
        baseFound = true;
      }
    }
  }
}

if (!baseFound) {
  violations.push("src/styles.css: base `select` rule lost `appearance: none` or its chevron background-image");
}

if (violations.length > 0) {
  console.error(
    `select-chrome: select rules must use background-color, not the background shorthand:\n  ${violations.join("\n  ")}`,
  );
  process.exit(1);
}
console.log("select-chrome: all select rules preserve the base chevron");

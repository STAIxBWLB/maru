#!/usr/bin/env node
// i18n lint — guards the ko/en parity promise of src/lib/i18n.ts.
//
//   1. Dictionary parity: every key in `ko` must exist in `en` and vice
//      versa (a CI-time gate; vitest covers this at runtime too).
//   2. Hardcoded UI strings in src/**/*.tsx:
//      - any Hangul (Korean strings must live in the dictionary), and
//      - English JSX text nodes and title/aria-label/placeholder literals.
//
// Escape hatch: a trailing `// i18n-lint-ignore` comment on the line.
// Proper nouns and format tokens (filenames, brands, date-fns patterns) are
// allowlisted below.
//
// Known gap (deliberate): only .tsx is scanned. Locale-unaware .ts helpers
// like src/lib/inbox.ts `categoryLabel()` and
// src/components/inbox/processedFormat.ts `statusLabel()` still return
// hardcoded labels; converting them needs locale threading through the lib
// layer and is tracked as follow-up work, not hidden by this lint.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const I18N_PATH = join(ROOT, "src", "lib", "i18n.ts");
const SRC_DIR = join(ROOT, "src");

// ---------------------------------------------------------------------------
// 1. ko/en dictionary key parity
// ---------------------------------------------------------------------------

const i18nText = readFileSync(I18N_PATH, "utf8");

function dictKeys(locale) {
  const marker = `const ${locale}: Record<string, string> = {`;
  const start = i18nText.indexOf(marker);
  if (start === -1) throw new Error(`[i18n-lint] dictionary '${locale}' not found`);
  const rest = i18nText.slice(start + marker.length);
  const end = rest.indexOf("\n};");
  if (end === -1) throw new Error(`[i18n-lint] dictionary '${locale}' not terminated`);
  const keys = new Set();
  for (const line of rest.slice(0, end).split("\n")) {
    const m = line.match(/^\s*"([^"]+)"\s*:/);
    if (m) keys.add(m[1]);
  }
  return keys;
}

const koKeys = dictKeys("ko");
const enKeys = dictKeys("en");
const missingInEn = [...koKeys].filter((k) => !enKeys.has(k));
const missingInKo = [...enKeys].filter((k) => !koKeys.has(k));

const failures = [];
if (missingInEn.length > 0) failures.push(`keys missing in en: ${missingInEn.join(", ")}`);
if (missingInKo.length > 0) failures.push(`keys missing in ko: ${missingInKo.join(", ")}`);

// ---------------------------------------------------------------------------
// 2. Hardcoded UI string scan (src/**/*.tsx)
// ---------------------------------------------------------------------------

// Exact strings that are proper nouns / file names / DSL examples, not
// language copy.
const TEXT_ALLOWLIST = new Set([
  "Maru",
  "README",
  "Frontmatter",
  "manifest.yaml",
  "Git",
  "Hub",
  "Mermaid",
  "PNG",
  "JPG",
  "SVG",
  "JSON",
  "PDF",
  "Claude",
  "Codex",
  "guideline_ids",
  "is:unread newer_than:14d",
]);

const HANGUL = /[가-힣]/;
// JSX text node: >text< with no braces/tags inside.
const JSX_TEXT = />([^<>{}]*[A-Za-z][^<>{}]*)</g;
// Static user-facing attribute literals.
const ATTR_TEXT = /\b(?:title|aria-label|placeholder)="([^"]*)"/g;
// date-fns format lines legitimately carry locale tokens ("yyyy년 M월").
const DATE_FORMAT_LINE = /\bformat(Date|DateTime)?\s*\(|date-fns|yyyy|yyyy년|MMMM/;
// Hangul inside data operations (regex/string matching, hook defaults) is
// user data, not UI copy.
const DATA_OP_LINE =
  /\.(?:replace|match|test|split|includes|startsWith|endsWith|trim)\(|RegExp|=>|useState\(|useMemo\(|useRef\(|useCallback\(/;
// Quoted string-literal lines (array entries like status vocabulary) are
// data, not UI copy.
const STRING_LITERAL_LINE = /^\s*"[^"]*",?\s*$/;
// TS type noise that leaks into the JSX_TEXT pattern (generics, unions,
// fragments of type annotations or ternaries).
const TYPE_NOISE = /[;|&=:]|^\s*&|\bPromise\b|\bPartial\b|\bRecord\b|\bvoid\b/;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      yield* walk(path);
    } else if (name.endsWith(".tsx") && !name.endsWith(".test.tsx")) {
      yield path;
    }
  }
}

const violations = [];

for (const file of walk(SRC_DIR)) {
  const rel = relative(ROOT, file);
  const lines = readFileSync(file, "utf8").split("\n");
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Crude block-comment tracking (good enough for source comments).
    if (inBlockComment) {
      if (line.includes("*/")) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith("/*")) {
      if (!line.includes("*/")) inBlockComment = true;
      continue;
    }
    if (
      trimmed.startsWith("//") ||
      trimmed.startsWith("*") ||
      trimmed.startsWith("import ") ||
      trimmed.includes("i18n-lint-ignore") ||
      trimmed.startsWith("console.")
    ) {
      continue;
    }

    // Hangul anywhere outside the dictionary is almost always a violation.
    if (
      HANGUL.test(line) &&
      !DATE_FORMAT_LINE.test(line) &&
      !DATA_OP_LINE.test(line) &&
      !STRING_LITERAL_LINE.test(trimmed)
    ) {
      violations.push(`${rel}:${i + 1} hardcoded Korean: ${trimmed.slice(0, 100)}`);
    }

    // English JSX text nodes (skip single-token proper nouns via allowlist).
    for (const m of line.matchAll(JSX_TEXT)) {
      const text = m[1].trim();
      if (text.length < 4 || !/[a-z]/.test(text)) continue;
      if (TEXT_ALLOWLIST.has(text) || TYPE_NOISE.test(text)) continue;
      // <option value="kind">kind</option> — enum labels are data.
      if (line.includes('value="') && /^[a-z][a-z-]*$/.test(text)) continue;
      violations.push(`${rel}:${i + 1} hardcoded JSX text "${text.slice(0, 60)}"`);
    }

    // Static title/aria-label/placeholder literals. Path/URL-like examples
    // ("/Users/...", "~/inbox", "services/x.env", "https://…") are
    // locale-independent.
    for (const m of line.matchAll(ATTR_TEXT)) {
      const text = m[1].trim();
      if (text.length < 4 || !/[A-Za-z가-힣]/.test(text)) continue;
      if (TEXT_ALLOWLIST.has(text) || TYPE_NOISE.test(text)) continue;
      if (/^[~./]/.test(text) || /^[\w.-]+\//.test(text) || /^https?:/.test(text)) continue;
      violations.push(`${rel}:${i + 1} hardcoded attribute "${m[0].slice(0, 60)}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

if (failures.length > 0) {
  console.error("[i18n-lint] dictionary parity failed:");
  for (const f of failures) console.error(`  ${f}`);
}
if (violations.length > 0) {
  console.error("[i18n-lint] hardcoded UI strings (move them to src/lib/i18n.ts):");
  for (const v of violations) console.error(`  ${v}`);
}
if (failures.length > 0 || violations.length > 0) {
  process.exit(1);
}
console.log(`[i18n-lint] ok — ${koKeys.size} keys in parity, no hardcoded UI strings`);

// Guard for SEC-02: every `dangerouslySetInnerHTML` sink in src/ must trace to
// a DOMPurify-backed helper. Maru renders content the user did not author
// (Telegram, KakaoTalk, Gmail, Outlook, inbox drops) through innerHTML sinks;
// this check turns the review-only boundary into a build gate before the
// Phase 8-10 refactor churn can add an untraced sink.
//
// Tracing model (D-07/D-08, deliberately narrow):
// - ALLOWED_HELPER_MODULES pins the modules that export DOMPurify-backed
//   helpers; a sink passes when its `__html` expression calls an identifier
//   imported (static top-level import) from one of them.
// - REGISTERED_LOCAL_HELPERS pins explicit (file, function) pairs for local
//   helpers; a sink passes when its expression (or a one-hop in-file
//   definition chain) calls the registered function for that exact file.
// - EditorPane only: the registered-pair match additionally requires the
//   narrow dynamic-import provenance pattern — `previewBaseHtml` assigned
//   inside `import("../lib/markdown").then(({ renderMarkdown }) => ...)`.
// Name-pattern matching is rejected as spoofable and local aliases are not
// followed; there is intentionally no AST parser and no general alias
// following. Everything else fails closed with exit 1.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "../src");

// D-07: pinned module allowlist of DOMPurify-helper exporters.
const ALLOWED_HELPER_MODULES = [
  "src/lib/markdown.ts",
  "src/lib/scratchpad.ts",
  "src/lib/diagram/richText.ts",
];

// D-08: pinned (file, function) registrations for local helpers.
const REGISTERED_LOCAL_HELPERS = [
  ["src/components/EditorPane.tsx", "decoratePreviewHtml"],
  ["src/components/binaryViewers/HwpxViewer.tsx", "sanitizeHwpxPreviewHtml"],
];

const ALLOWED_MODULE_SET = new Set(ALLOWED_HELPER_MODULES);
const REGISTERED_BY_FILE = new Map();
for (const [file, fn] of REGISTERED_LOCAL_HELPERS) {
  if (!REGISTERED_BY_FILE.has(file)) REGISTERED_BY_FILE.set(file, new Set());
  REGISTERED_BY_FILE.get(file).add(fn);
}

const TEST_FILE_PATTERN = /\.(?:test|spec)\.(?:ts|tsx)$/;

function collectTsFiles(dir, relDir = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      // node_modules is the only dependency tree; __tests__ directories carry
      // source-text assertions (e.g. EditorPane.test.tsx's sink literal) that
      // must never be scanned as live sinks.
      if (entry.name !== "node_modules" && entry.name !== "__tests__") {
        out.push(...collectTsFiles(join(dir, entry.name), relPath));
      }
    } else if (/\.(?:ts|tsx)$/.test(entry.name) && !TEST_FILE_PATTERN.test(entry.name)) {
      out.push({ abs: join(dir, entry.name), rel: relPath });
    }
  }
  return out;
}

// Resolve a relative import specifier to a repo-relative path, but only
// return it when the target is one of the pinned allowlisted modules.
function resolveAllowlistedModule(specifier, fileRel) {
  if (!specifier.startsWith(".")) return null;
  const base = normalize(join(dirname(fileRel), specifier));
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
  ]) {
    if (ALLOWED_MODULE_SET.has(candidate)) return candidate;
  }
  return null;
}

// Map of local identifier -> import specifier for static top-level imports.
function collectImports(source) {
  const imports = new Map();
  const named = /import\s+(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(named)) {
    for (const entry of match[1].split(",")) {
      const cleaned = entry.trim().replace(/^type\s+/, "");
      if (!cleaned) continue;
      const [imported, alias] = cleaned.split(/\s+as\s+/);
      imports.set((alias ?? imported).trim(), match[2]);
    }
  }
  const defaulted = /import\s+([A-Za-z_$][\w$]*)\s+from\s*["']([^"']+)["']/g;
  for (const match of source.matchAll(defaulted)) {
    if (!imports.has(match[1])) imports.set(match[1], match[2]);
  }
  return imports;
}

// First `const|let|var <name> = <rhs>;` per identifier (non-greedy to the
// first semicolon — house style requires statement terminators).
function collectDefinitions(source) {
  const defs = new Map();
  const pattern = /(?:^|[\s;])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]*?);/g;
  for (const match of source.matchAll(pattern)) {
    if (!defs.has(match[1])) defs.set(match[1], match[2]);
  }
  return defs;
}

function callIdentifiers(expr) {
  const names = new Set();
  for (const match of expr.matchAll(/\b([A-Za-z_$][\w$]*)\s*\(/g)) names.add(match[1]);
  return names;
}

function referencedIdentifiers(expr) {
  const names = new Set();
  for (const match of expr.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)) names.add(match[1]);
  return names;
}

// EditorPane-only (Pitfall 3): the previewBaseHtml chain bottoms out at a
// dynamic import of the allowlisted markdown helper. Recognize exactly that
// narrow shape: import("<allowlisted>").then(({ <name> }) => ...) with an
// assignment of previewBaseHtml from a call to <name>.
function hasDynamicImportProvenance(source, fileRel) {
  const pattern = /import\(\s*["']([^"']+)["']\s*\)\s*\.then\(\s*\(\s*\{([^}]*)\}\s*\)/g;
  for (const match of source.matchAll(pattern)) {
    if (!resolveAllowlistedModule(match[1], fileRel)) continue;
    for (const raw of match[2].split(",")) {
      const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
      if (!name) continue;
      // Case-insensitive: the state setter is `setPreviewBaseHtml` (capital P)
      // while the state field itself is `previewBaseHtml`.
      const assignment = new RegExp(`previewBaseHtml\\s*[= (]+\\s*${name}\\s*\\(`, "i");
      if (assignment.test(source)) return true;
    }
  }
  return false;
}

function tracesToAllowedCall(fileRel, expr, imports, defs, source, depth) {
  for (const name of callIdentifiers(expr)) {
    const specifier = imports.get(name);
    if (specifier && resolveAllowlistedModule(specifier, fileRel)) return true;
    if (REGISTERED_BY_FILE.get(fileRel)?.has(name)) {
      if (fileRel === "src/components/EditorPane.tsx") {
        return hasDynamicImportProvenance(source, fileRel);
      }
      return true;
    }
  }
  if (depth <= 0) return false;
  for (const name of referencedIdentifiers(expr)) {
    const rhs = defs.get(name);
    if (rhs && tracesToAllowedCall(fileRel, rhs, imports, defs, source, depth - 1)) {
      return true;
    }
  }
  return false;
}

function sinkTraces(fileRel, expr, imports, defs, source) {
  const trimmed = expr.trim();
  const target = /^[A-Za-z_$][\w$]*$/.test(trimmed) ? (defs.get(trimmed) ?? trimmed) : trimmed;
  return tracesToAllowedCall(fileRel, target, imports, defs, source, 1);
}

// CR-01: blank out comments and string/template literals so the raw
// occurrence count below only sees real attribute usages (doc comments in
// HwpxViewer.tsx and EditorPane.tsx name the attribute without using it).
// Small char scanner, not an AST parser (D-07).
function stripCommentsAndStrings(source) {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && source[i] !== "\n") i++;
    } else if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
    } else if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      i++;
      while (i < n) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === quote) break;
        if (quote !== "`" && source[i] === "\n") break;
        i++;
      }
      i = Math.min(i + 1, n);
      out += " ";
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

const violations = [];
let sinkCount = 0;
for (const { abs, rel } of collectTsFiles(srcRoot, "src")) {
  const source = readFileSync(abs, "utf8");
  const imports = collectImports(source);
  const defs = collectDefinitions(source);
  const lines = source.split("\n");
  let matchedInThisFile = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const inline = line.match(
      /dangerouslySetInnerHTML=\{\{\s*__html:\s*((?:[^{}]|\{[^{}]*\})*?)\s*\}\}/,
    );
    const bare = inline ? null : line.match(/dangerouslySetInnerHTML=\{\s*([A-Za-z_$][\w$]*)\s*\}/);
    const expr = inline?.[1] ?? bare?.[1];
    if (expr === undefined) continue;
    sinkCount += 1;
    matchedInThisFile += 1;
    if (!sinkTraces(rel, expr, imports, defs, source)) {
      violations.push(`${rel}:${i + 1} (__html: ${expr.trim()})`);
    }
  }
  // CR-01 reconciliation: the per-line scan above only recognizes sink
  // shapes whose __html expression fits on one line. Prettier wraps long
  // JSX attributes, so a multi-line sink would otherwise pass untraced.
  // Count raw attribute usages and fail closed when they exceed the traced
  // sinks — a multi-line sink must be reshaped or traced explicitly.
  const rawOccurrences = (stripCommentsAndStrings(source).match(/dangerouslySetInnerHTML/g) ?? [])
    .length;
  if (rawOccurrences > matchedInThisFile) {
    violations.push(
      `${rel}: dangerouslySetInnerHTML occurrences (${rawOccurrences}) exceed traced sinks (${matchedInThisFile}); multi-line or unrecognized sink shape must be traced explicitly`,
    );
  }
}

if (violations.length > 0) {
  console.error(
    `check-dom-sanitizer: every dangerouslySetInnerHTML sink in src/ must trace to a DOMPurify-backed helper:\n  ${violations.join("\n  ")}`,
  );
  process.exit(1);
}
console.log(
  `check-dom-sanitizer: all ${sinkCount} dangerouslySetInnerHTML sinks trace to a DOMPurify-backed helper`,
);

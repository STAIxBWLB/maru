// CSP-blob guard for SEC-01 (D-04): the shipped CSP must not carry
// `script-src blob:`. The desktop webview renders third-party content
// (Telegram, KakaoTalk, Gmail, Outlook, inbox drops) through innerHTML
// sinks, and while script-src allows blob:, injected DOM can mint
// executable script URLs — the DOMPurify boundary (SEC-02) is only as
// strong as every sink that feeds it. Dropping script-src blob: turns
// that review-only boundary into a build-enforced one, and D-04 gates
// the drop behind two proofs, both halves of which this guard is.
//
// What runs where, and why:
//
// - Dist half (every run, no arguments): scans dist/assets/*.js for the
//   two constructs that could still demand script-context script URLs —
//   a Worker spawned from an unclassifiable URL and a dynamic import()
//   whose specifier is not a literal. It reads a PRODUCED artifact, not
//   sources: bundled dependencies can introduce constructs no source
//   declaration shows. Chained into `build:frontend` after
//   check-native-e2e-isolation.mjs, so `make verify` carries it against
//   a freshly produced bundle with no new entry in verify's prerequisite
//   list. This is D-04 proof (a). The scan is config-independent: it
//   passes or fails on the bundle alone.
//
// - Binary half (`--binary <path>` only): reads the compiled Tauri
//   binary and asserts the codegen-embedded CSP serialization's
//   script-src source list carries no blob:. tauri-codegen embeds the
//   config text verbatim, so the binary proves what a packaged build
//   actually ships — dev serves no CSP at all (no devCsp key), so the
//   config file alone does not prove the shipped posture. Wired into
//   the Makefile's `release-checks` recipe between the debug no-bundle
//   Tauri build and the artifact prune (a binary must exist, and the
//   check must run before `clean:tauri-debug` deletes it);
//   `release-preflight` inherits it through `release-preflight-core`.
//   This is D-04 proof (b). The assertion targets the CONFIGURED source
//   list carrying no blob:, not the byte-level disappearance of the
//   directive: Tauri's nonce handling may re-create script-src with
//   'self' at runtime (research pitfall 3), which is the expected
//   posture and not what this scan measures.
//
// Needle scope, deliberately narrow (D-05): these two needles cover the
// script-execution sinks app code can drive from a blob: URL — a
// blob:-URL worker spawn and a non-literal dynamic import. DOM
// script-tag injection is owned by check-dom-sanitizer.mjs (SEC-02) and
// the runtime CSP itself, and download anchors (`a.href`) are not
// script sources and must never match. `new Worker(blobUrl)` fetches
// the worker script under worker-src (script-src is only the fallback
// when worker-src is absent) and Maru ships `worker-src: 'self'
// blob:`, so blob-URL worker spawns stay legal after script-src drops
// blob: — the Worker needle therefore exempts bare-identifier
// arguments bound to a createObjectURL(...) call nearby (the graphology
// FA2 supervisor spawn minted through URL.createObjectURL(new
// Blob(...)) is exactly that shape) and fails closed on every other
// bare identifier, which cannot be classified statically. A dynamic
// import() with a non-literal specifier is flagged; method-shaped calls
// (i.import(r)) are excluded by lookbehind — the dynamic import
// operator is a free-standing token, never a property access. Both
// needles run after comment/string stripping so config text and docs
// inside the bundles cannot false-positive. Missing dist or binary is
// a usage error (exit 1), not an environmental skip: each mode runs
// only where its artifact is guaranteed to exist, and unlike a
// cargo/registry invocation nothing here can fail for environmental
// reasons.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// --- Needles (module scope, not exported) ----------------------------------
// Worker-spawn needle: every `new Worker(` call site is examined; the
// argument classification happens in workerSpawnOffenses below.
const WORKER_NEEDLE = /new\s+Worker\s*\(/g;
// Dynamic-import needle: the lookbehind excludes property access
// (i.import(r) is a graphology layout method, not the import operator).
const DYNAMIC_IMPORT_NEEDLE = /(?<![.\w$])import\s*\(/g;
// Embedded-config needle (binary half): the CSP serialization
// tauri-codegen embeds verbatim into the binary. If the config key is
// renamed upstream, update this needle in the same change.
const SCRIPT_SRC_NEEDLE = /"script-src"\s*:\s*"([^"]*)"/g;

const violations = [];
let scannedBundles = 0;
let embeddedScriptSrcValues = [];

function parseArgs(argv) {
  const args = { binary: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--binary") {
      const path = argv[i + 1];
      if (!path) {
        console.error("csp-blob: --binary requires a path argument");
        process.exit(1);
      }
      args.binary = path;
      i += 1;
    } else {
      console.error(`csp-blob: unknown argument ${argv[i]}`);
      process.exit(1);
    }
  }
  return args;
}

// House scanner (check-dom-sanitizer.mjs): blank out comments and
// string/template literals so needle matching only sees live code —
// bundle text carries config strings and doc comments that would
// otherwise match the needles. Small char scanner, not an AST parser.
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

// A blob-URL binding is `<id> = [<qualifier>.]createObjectURL(` in the
// code region before the spawn: the identifier provably holds a blob:
// URL, and a Worker fed one runs under worker-src ('self' blob:', D-05),
// not script-src.
function hasBlobUrlBinding(stripped, identifier, beforeIndex) {
  const region = stripped.slice(Math.max(0, beforeIndex - 1024), beforeIndex);
  const escaped = identifier.replace(/\$/g, "\\$&");
  const binding = new RegExp(
    `(^|[^.\\w$])${escaped}\\s*=\\s*[\\w$.]*createObjectURL\\s*\\(`,
  );
  return binding.test(region);
}

// --- Dist half: the built JS must not demand script-src blob: -------------
function checkBundle() {
  const assetsDir = join(repoRoot, "dist", "assets");
  if (!existsSync(assetsDir)) {
    console.error(
      "csp-blob: dist/assets/ does not exist — run `pnpm build:frontend` first",
    );
    process.exit(1);
  }
  const jsFiles = readdirSync(assetsDir).filter((file) => file.endsWith(".js"));
  scannedBundles = jsFiles.length;
  const offenders = jsFiles.flatMap((file) => {
    const stripped = stripCommentsAndStrings(
      readFileSync(join(assetsDir, file), "utf8"),
    );
    return [
      ...workerSpawnOffenses(stripped).map(
        (offense) => `dist/assets/${file}: ${offense}`,
      ),
      ...dynamicImportOffenses(stripped).map(
        (offense) => `dist/assets/${file}: ${offense}`,
      ),
    ];
  });
  if (offenders.length > 0) {
    violations.push(
      `production bundle carries constructs that demand script-src blob: ` +
        `(SEC-01):\n  ${offenders.join("\n  ")}`,
    );
  }
}

function workerSpawnOffenses(stripped) {
  const offenses = [];
  for (const match of stripped.matchAll(WORKER_NEEDLE)) {
    const trimmed = stripped
      .slice(match.index + match[0].length)
      .trimStart();
    if (trimmed === "" || trimmed.startsWith(")")) continue;
    // A string-literal argument was blanked by stripping; same-origin
    // spawns use the new URL(...) form (GraphInsightsPanel.tsx).
    if (/^new\s+URL\b/.test(trimmed)) continue;
    const identifier = trimmed.match(/^([A-Za-z_$][\w$]*)/);
    if (identifier) {
      if (hasBlobUrlBinding(stripped, identifier[1], match.index)) continue;
      offenses.push(
        `new Worker(${identifier[1]}) — a bare-identifier worker argument ` +
          "is only exempt when bound to a createObjectURL(...) call nearby " +
          "(a blob-URL spawn runs under worker-src 'self' blob:', D-05); " +
          'rewrite same-origin spawns as new Worker(new URL("./w.ts", ' +
          "import.meta.url))",
      );
      continue;
    }
    offenses.push(
      "new Worker(<unclassifiable argument>) — only string literals, " +
        "new URL(...) spawns and createObjectURL-bound identifiers are " +
        "recognized",
    );
  }
  return offenses;
}

function dynamicImportOffenses(stripped) {
  const offenses = [];
  // Lookbehind excludes method-shaped calls (i.import(r)) and property
  // access; a plain `import(` keyword call remains.
  for (const match of stripped.matchAll(DYNAMIC_IMPORT_NEEDLE)) {
    const trimmed = stripped
      .slice(match.index + match[0].length)
      .trimStart();
    if (trimmed === "" || trimmed.startsWith(")")) continue;
    if (/^new\s+URL\b/.test(trimmed)) continue;
    const identifier = trimmed.match(/^([A-Za-z_$][\w$]*)/);
    if (identifier) {
      offenses.push(
        `import(${identifier[1]}) — dynamic import() with a non-literal ` +
          "specifier cannot be proven same-origin; use a string literal",
      );
      continue;
    }
    offenses.push(
      "import(<unclassifiable argument>) — only string-literal specifiers " +
        "are recognized",
    );
  }
  return offenses;
}

// --- Binary half: the compiled binary's embedded CSP is the shipped posture
function checkBinary(binaryPath) {
  if (!existsSync(binaryPath)) {
    console.error(`csp-blob: --binary path does not exist: ${binaryPath}`);
    process.exit(1);
  }
  // latin1 maps bytes 1:1 to code points, so the ASCII config text the
  // codegen embedded survives intact; the binary is only scanned, never
  // executed.
  const text = readFileSync(binaryPath).toString("latin1");
  embeddedScriptSrcValues = [...text.matchAll(SCRIPT_SRC_NEEDLE)].map(
    (match) => match[1],
  );
  if (embeddedScriptSrcValues.length === 0) {
    violations.push(
      `${binaryPath} carries no embedded CSP script-src serialization — ` +
        "wrong artifact or the tauri-codegen config format changed; " +
        "D-04 proof (b) cannot be asserted, failing closed",
    );
    return;
  }
  for (const value of embeddedScriptSrcValues) {
    if (value.includes("blob:")) {
      violations.push(
        `${binaryPath} embedded CSP script-src carries blob: ("${value}") — ` +
          "drop script-src blob: from src-tauri/tauri.conf.json " +
          "(SEC-01, D-04 proof (b))",
      );
    }
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.binary) {
  checkBinary(args.binary);
} else {
  checkBundle();
}

if (violations.length > 0) {
  console.error(
    `csp-blob: script-src blob: must not reach a shippable build (SEC-01):\n  ${violations.join("\n  ")}`,
  );
  process.exit(1);
}
console.log(
  args.binary
    ? `csp-blob: ${args.binary} embedded CSP script-src carries no blob: (configured source list: "${embeddedScriptSrcValues[0]}")`
    : `csp-blob: dist carries no blob: script sources (${scannedBundles} JS bundles scanned; no blob:-attributable worker spawn or non-literal dynamic import)`,
);

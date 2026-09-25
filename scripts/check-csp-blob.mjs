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
// - Default mode (every run, chained into `build:frontend`, so `make
//   verify` and CI carry it against a freshly produced bundle):
//   1. Config: tauri.conf.json, and each tauri.*.conf.json overlay merged
//      onto it the way Tauri merges them, must carry a CSP that restricts
//      scripts and keeps blob: out of script-src / script-src-elem (and out
//      of default-src when no script-src is set). Re-adding blob: fails the ordinary PR build,
//      not only the release preflight.
//   2. Dist (D-04 proof (a)): parses dist/assets/*.{js,mjs} (Vite's
//      bundled Rollup parser, not a regex or char scanner: minified
//      regex literals and template expressions desynced the old
//      comment/string stripper and hid real call sites) and flags the
//      constructs that could still demand script URLs the CSP cannot
//      classify: a dynamic import() or importScripts() whose specifier
//      is not a literal, and a Worker/SharedWorker spawned from anything
//      other than a literal, a `new URL(...)` or an identifier bound to
//      a createObjectURL(...) call in the same bundle. It reads the
//      PRODUCED artifact: bundled dependencies can introduce constructs
//      no source declaration shows. `--dist <dir>` overrides the
//      directory (behavioral tests).
//
// - Binary half (`--binary <path>` only, D-04 proof (b)): reads the
//   compiled Tauri binary and asserts the CSP tauri-codegen compiled in
//   carries no script-src blob:. Codegen stores each directive as its
//   name directly followed by its source list (`script-src'self'`), and
//   that form reflects the effective config, overlays included. The
//   pretty-printed tauri.conf.json that bundle_update.rs pulls in with
//   include_str! is NOT the shipped CSP, so the codegen form must be
//   present or the scan fails closed. Wired into the Makefile's
//   `release-checks` recipe between the debug no-bundle Tauri build and
//   the artifact prune; `release-preflight` inherits it. Tauri's nonce
//   placeholder (`script-src__TAURI_SCRIPT_NONCE__`) is not a source
//   list and is ignored.
//
// Needle scope, deliberately narrow (D-05): `new Worker(blobUrl)` fetches
// the worker script under worker-src, which keeps `'self' blob:`, so a
// createObjectURL-bound worker spawn (the graphology FA2 supervisor) stays
// legal. Download anchors and image sources are not script sources and
// never match. DOM script-tag injection is owned by check-dom-sanitizer.mjs
// (SEC-02) and the runtime CSP itself. Missing dist or binary is a usage
// error (exit 1), not an environmental skip.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Binary half: codegen form, directive name immediately followed by its
// source list (quoted keywords, scheme or scheme://host sources).
const CODEGEN_SCRIPT_SRC =
  /script-src(?:-elem)?((?:\s*(?:'[^'\x00-\x1f]*'|[a-z][a-z0-9+.-]*:(?:\/\/[^\s'"\x00-\x1f]*)?))+)/g;
// Binary half: JSON form (the include_str! copy of tauri.conf.json).
const JSON_SCRIPT_SRC = /"script-src(?:-elem)?"\s*:\s*"([^"]*)"/g;

const violations = [];
let summary = "";

function parseArgs(argv) {
  const args = { binary: null, dist: join(repoRoot, "dist", "assets") };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--binary" || argv[i] === "--dist") {
      const path = argv[i + 1];
      if (!path) {
        console.error(`csp-blob: ${argv[i]} requires a path argument`);
        process.exit(1);
      }
      args[argv[i].slice(2)] = path;
      i += 1;
    } else {
      console.error(`csp-blob: unknown argument ${argv[i]}`);
      process.exit(1);
    }
  }
  return args;
}

// --- Config: the source of the shipped CSP ----------------------------------
// RFC 7396 merge-patch, the way tauri-utils applies a tauri.*.conf.json
// overlay to the base config: objects merge, null deletes, the rest replaces.
function mergePatch(target, patch) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) return patch;
  const out = target && typeof target === "object" && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = mergePatch(out[key], value);
  }
  return out;
}

function checkConfig() {
  const confDir = join(repoRoot, "src-tauri");
  const read = (file) => JSON.parse(readFileSync(join(confDir, file), "utf8"));
  const base = read("tauri.conf.json");
  const confFiles = readdirSync(confDir).filter((f) => /^tauri.*\.conf\.json$/.test(f));
  for (const file of confFiles) {
    // Each overlay is checked as it ships: merged onto the base config.
    const csp = (file === "tauri.conf.json" ? base : mergePatch(base, read(file))).app?.security?.csp;
    if (csp == null) {
      violations.push(`src-tauri/${file} leaves the webview with no CSP (SEC-01)`);
      continue;
    }
    const directives =
      typeof csp === "string"
        ? Object.fromEntries(
            csp
              .split(";")
              .map((d) => d.trim().split(/\s+/))
              .filter((parts) => parts[0])
              .map(([name, ...sources]) => [name, sources.join(" ")]),
          )
        : Object.fromEntries(
            Object.entries(csp).map(([name, v]) => [name, Array.isArray(v) ? v.join(" ") : String(v)]),
          );
    const governing = ["script-src", "script-src-elem"].filter((d) => d in directives);
    if (governing.length === 0) governing.push("default-src");
    if (!(governing[0] in directives)) {
      violations.push(`src-tauri/${file} CSP has no script-src or default-src — scripts are unrestricted (SEC-01)`);
    }
    for (const name of governing) {
      if ((directives[name] ?? "").includes("blob:")) {
        violations.push(
          `src-tauri/${file} ${name} carries blob: ("${directives[name]}") — ` +
            "drop it (SEC-01); worker-src keeps blob: for the graph worker (D-05)",
        );
      }
    }
  }
}

// --- Dist half: the built JS must not demand script-src blob: -------------
function isLiteral(node) {
  return (
    node?.type === "Literal" ||
    (node?.type === "TemplateLiteral" && node.expressions.length === 0)
  );
}

function isObjectUrlCall(node) {
  const callee = node?.type === "CallExpression" ? node.callee : null;
  return (
    (callee?.type === "MemberExpression" && callee.property.name === "createObjectURL") ||
    (callee?.type === "Identifier" && callee.name === "createObjectURL")
  );
}

function calleeName(callee) {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed) return callee.property.name;
  return null;
}

function walk(root, visit) {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    visit(node);
    for (const key in node) {
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) if (child && typeof child.type === "string") stack.push(child);
      } else if (value && typeof value.type === "string") {
        stack.push(value);
      }
    }
  }
}

function bundleOffenses(source, parseAst) {
  const blobBound = new Set();
  const spawns = [];
  const offenses = [];
  const text = (node) => source.slice(node.start, node.end).slice(0, 80);
  walk(parseAst(source), (node) => {
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && isObjectUrlCall(node.init)) {
      blobBound.add(node.id.name);
    } else if (node.type === "AssignmentExpression" && node.left.type === "Identifier" && isObjectUrlCall(node.right)) {
      blobBound.add(node.left.name);
    } else if (node.type === "ImportExpression" && !isLiteral(node.source)) {
      offenses.push(`import(${text(node.source)}) — dynamic import() with a non-literal specifier cannot be proven same-origin; use a string literal`);
    } else if (node.type === "CallExpression" && calleeName(node.callee) === "importScripts" && !node.arguments.every(isLiteral)) {
      offenses.push(`${text(node)} — importScripts() with a non-literal URL`);
    } else if (node.type === "NewExpression" && /^(Shared)?Worker$/.test(calleeName(node.callee) ?? "")) {
      spawns.push(node);
    }
  });
  for (const node of spawns) {
    const arg = node.arguments[0];
    if (!arg || isLiteral(arg)) continue;
    if (arg.type === "NewExpression" && calleeName(arg.callee) === "URL") continue;
    // ponytail: bindings are matched by name per bundle, not by scope; a
    // shadowed identifier could be exempted. Fine while the only blob
    // spawn is the FA2 supervisor.
    if (arg.type === "Identifier" && blobBound.has(arg.name)) continue;
    offenses.push(
      `${text(node)} — worker URL must be a literal, new URL(...), or an identifier ` +
        "bound to createObjectURL(...) (a blob-URL spawn runs under worker-src 'self' blob:, D-05)",
    );
  }
  return offenses;
}

async function checkBundle(assetsDir) {
  if (!existsSync(assetsDir)) {
    console.error(`csp-blob: ${assetsDir} does not exist — run \`pnpm build:frontend\` first`);
    process.exit(1);
  }
  const { parseAst } = await import("vite");
  const jsFiles = readdirSync(assetsDir).filter((file) => /\.m?js$/.test(file));
  const offenders = jsFiles.flatMap((file) => {
    try {
      return bundleOffenses(readFileSync(join(assetsDir, file), "utf8"), parseAst).map(
        (offense) => `${file}: ${offense}`,
      );
    } catch (error) {
      return [`${file}: unparseable bundle, failing closed (${error instanceof Error ? error.message : error})`];
    }
  });
  if (offenders.length > 0) {
    violations.push(
      `production bundle carries constructs that demand script-src blob: (SEC-01):\n  ${offenders.join("\n  ")}`,
    );
  }
  summary = `csp-blob: config and dist carry no blob: script sources (${jsFiles.length} JS bundles parsed; no unclassifiable worker spawn, importScripts or non-literal dynamic import)`;
}

// --- Binary half: the compiled binary's codegen CSP is the shipped posture
function checkBinary(binaryPath) {
  if (!existsSync(binaryPath)) {
    console.error(`csp-blob: --binary path does not exist: ${binaryPath}`);
    process.exit(1);
  }
  // latin1 maps bytes 1:1 to code points; the binary is only scanned.
  const text = readFileSync(binaryPath).toString("latin1");
  const codegen = [...text.matchAll(CODEGEN_SCRIPT_SRC)].map((m) => m[1].trim());
  const json = [...text.matchAll(JSON_SCRIPT_SRC)].map((m) => m[1]);
  if (codegen.length === 0) {
    violations.push(
      `${binaryPath} carries no codegen CSP script-src serialization — ` +
        "wrong artifact or the tauri-codegen format changed; D-04 proof (b) cannot be asserted, failing closed",
    );
    return;
  }
  for (const value of [...codegen, ...json]) {
    if (value.includes("blob:")) {
      violations.push(
        `${binaryPath} embedded CSP script-src carries blob: ("${value}") — ` +
          "drop script-src blob: from src-tauri/tauri.conf.json (SEC-01, D-04 proof (b))",
      );
    }
  }
  summary = `csp-blob: ${binaryPath} embedded CSP script-src carries no blob: (compiled source list: "${codegen[0]}")`;
}

const args = parseArgs(process.argv.slice(2));
if (args.binary) {
  checkBinary(args.binary);
} else {
  checkConfig();
  await checkBundle(args.dist);
}

if (violations.length > 0) {
  console.error(
    `csp-blob: script-src blob: must not reach a shippable build (SEC-01):\n  ${violations.join("\n  ")}`,
  );
  process.exit(1);
}
console.log(summary);

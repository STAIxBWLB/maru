# Phase 10: Bundle and Build Hardening - Pattern Map

**Mapped:** 2026-09-21
**Files analyzed:** 11 (3 new, 8 modified groups)
**Analogs found:** 11 / 11

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `scripts/check-csp-blob.mjs` (new) | utility (build guard) | file-I/O (scans produced artifacts) | `scripts/check-native-e2e-isolation.mjs` | exact |
| `e2e/first-activation-styles.spec.ts` (new) | test (Playwright e2e) | event-driven (browser page) | `e2e/startup.spec.ts` | exact |
| `src/lib/modePreload.ts` (new, discretionary) | service (idle warm-up scheduler) | event-driven (idle callback) | `src/lib/startupProfile.ts` + `src/lib/modeRegistry.tsx` | role-match |
| `src/components/<mode>/<mode>.css` family (new, ~14-17 files) | component styling (CSS) | static asset via import graph | `src/components/graph/graph.css` + `GraphView.tsx` import site | exact |
| `src-tauri/tauri.conf.json` (modified) | config | build-time config | self (CSP block, :33-52) | exact |
| `scripts/check-bundle-budget.mjs` (modified) | utility (build guard) | file-I/O | self (stale comment :27-28, assertion patterns) | exact |
| `Makefile` (modified) | config (build orchestration) | - | self (`release-checks` recipe, `check-*` family) | exact |
| `package.json` (modified) | config | - | self (`build:frontend` chain, :14-17) | exact |
| `src/styles.css` (modified, 26,458 lines) | model (entry stylesheet, being split) | - | self (section-header census, stay-in-entry exemplars) | exact |
| mode pane component modules (modified, import sites) | component | - | `src/components/graph/GraphView.tsx`, `DiagramMode.tsx`, `SettingsSurface.tsx`, `MeetingSourceWorkbench.tsx` | exact |
| `src/main.tsx` (modified, preload wiring) | controller (entry point) | event-driven | self (`void import()` precedent, :8-9) | exact |

## Pattern Assignments

### `scripts/check-csp-blob.mjs` (new; utility, file-I/O) — D-04 proofs (a) and (b)

**Analog:** `scripts/check-native-e2e-isolation.mjs` (248 lines) — the only existing guard with the exact
two-half shape the new check needs: no-arg mode scans produced JS artifacts, `--binary <path>` mode scans
a compiled executable, both documented in a header comment that explains what-runs-where-and-why.

**Two-half design + wiring rationale** (analog lines 1-30): copy this header structure verbatim in spirit —
each half's scope, why it runs there, and what it must never run against:

```js
// - Bundle half (every run): scans dist/assets/*.js for the debug bridge
//   namespace. Chained into `build:frontend` after check-bundle-budget.mjs,
//   so `make verify` carries it against a freshly produced production bundle
//   with no new entry in verify's prerequisite list.
// - Binary half (`--binary <path>` only): ... Wired into the Makefile's
//   `release-checks` recipe between the debug no-bundle Tauri build and the
//   artifact prune (a binary must exist, and the check must run before
//   `clean:tauri-debug` deletes it); `release-preflight` inherits it through
//   `release-preflight-core`.
```

**Sync'd-identifier constants** (analog lines 41-68): every needle constant documents its source file and
the rename obligation. The new guard's needles (e.g. the serialized `"script-src"` config text) need the
same provenance comments:

```js
// --- Identifiers that must stay in sync with their sources -----------------
// The browser global declared by src/lib/nativeE2eBridge.ts (plan 06-02). If
// that module renames the namespace, update this string in the same change.
const BRIDGE_NAMESPACE = "__MARU_NATIVE_E2E__";
```

**Argument parsing + dispatch** (analog lines 72-89, 229-236): unknown args fail; `--binary` requires a
value; dispatch selects halves:

```js
function parseArgs(argv) {
  const args = { binary: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--binary") {
      const path = argv[i + 1];
      if (!path) {
        console.error("native-e2e-isolation: --binary requires a path argument");
        process.exit(1);
      }
      args.binary = path;
      i += 1;
    } else {
      console.error(`native-e2e-isolation: unknown argument ${argv[i]}`);
      process.exit(1);
    }
  }
  return args;
}
// ...
const args = parseArgs(process.argv.slice(2));
if (args.binary) {
  checkManifest();
  checkBinary(args.binary);
} else {
  checkBundle();
  checkManifest();
}
```

**Artifact scan loop** (analog lines 92-119): existence gate with remediation message, `.js` filter,
flat-map offenders with file-qualified messages:

```js
function checkBundle() {
  const assetsDir = join(repoRoot, "dist", "assets");
  if (!existsSync(assetsDir)) {
    console.error(
      "native-e2e-isolation: dist/assets/ does not exist — run `pnpm build:frontend` first",
    );
    process.exit(1);
  }
  const needles = [BRIDGE_NAMESPACE, ...NATIVE_ONLY_COMMANDS];
  const offenders = readdirSync(assetsDir)
    .filter((file) => file.endsWith(".js"))
    .flatMap((file) => {
      const content = readFileSync(join(assetsDir, file), "utf8");
      return needles
        .filter((needle) => content.includes(needle))
        .map((needle) => `dist/assets/${file} contains "${needle}"`);
    });
```

**Environmental-failure warn-and-skip** (analog lines 136-150): an environment problem (missing tool,
cold cache) must NOT be reported as a violation — exit 1 is reserved for a successfully-parsed artifact
that violates the rule. Relevant for the `--binary` half (binary path missing = `process.exit(1)` with
remediation; binary present but scan tooling fails = warn-and-skip only if genuinely environmental):

```js
    // An environmental cargo failure — cargo not installed, a cold registry
    // cache (`--offline` fails on a machine that has never run cargo), a
    // corrupted index — is NOT an isolation violation. Hard-failing here
    // would block `pnpm build:frontend` for frontend-only contributors and
    // misdiagnose an environment problem as a D-10 breach, training people
    // to bypass the gate. Warn and skip the manifest half instead: the
    // bundle half still guards the artifact that actually ships. Exit-1 is
    // reserved for a SUCCESSFULLY PARSED manifest that violates D-10 ...
    console.warn(
      "native-e2e-isolation: skipping Cargo manifest assertions — " +
        `cargo metadata failed for environmental reasons: ${error.message}`,
    );
    return;
```

**Fail-closed + success line** (analog lines 238-248): violations accumulate in a module-level array,
one stderr block, exit 1; success prints exactly one `console.log`:

```js
if (violations.length > 0) {
  console.error(
    `native-e2e-isolation: runner-only affordances must not reach a shippable build:\n  ${violations.join("\n  ")}`,
  );
  process.exit(1);
}
console.log(
  args.binary
    ? `native-e2e-isolation: ${args.binary} and Cargo manifest carry no ...`
    : "native-e2e-isolation: bundle and Cargo manifest carry no native-e2e affordances",
);
```

**Strip-then-scan idiom for the `--binary` grep** (secondary analogs): `check-dom-sanitizer.mjs:176-207`
(`stripCommentsAndStrings` — comment/string blanking char scanner) and `check-select-chrome.mjs:31`
(`stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "")`). The static dist scan must strip
comments and string literals from minified JS before matching blob:-script needles, otherwise CSP config
text and doc comments inside the bundle create false positives that block every build. The `--binary`
mode greps the serialized config text ( needles like `"script-src": "'self' blob:"`), verified present in
the debug binary this session.

### `e2e/first-activation-styles.spec.ts` (new; test, event-driven) — FOUC criterion 3

**Analog:** `e2e/startup.spec.ts` (26 lines) — the existing spec that asserts startup-path behavior via
the startupProfile flag; same shape (clean state, navigate with flag, assert DOM, inspect window state):

```ts
import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
});

test("keeps the full terminal renderer out of the collapsed startup path", async ({
  page,
}) => {
  await page.goto("/?startupProfile=1");

  await expect(page.getByRole("button", { name: "Sample Workspace", exact: true })).toBeVisible();
  await expect(page.locator(".terminal-panel.collapsed")).toBeVisible();
  await expect(page.locator(".native-terminal-view")).toHaveCount(0);

  const marks = await page.evaluate(() =>
    (
      (window as Window & {
        __MARU_STARTUP_PROFILE__?: { marks?: Array<{ name: string }> };
      }).__MARU_STARTUP_PROFILE__?.marks ?? []
    ).map((mark) => mark.name),
  );
  expect(marks).toContain("workspace:first-usable");
```

**Computed-style assertion idiom** (secondary analogs): `e2e/select-audit.spec.ts:17` iterates
`getComputedStyle(el)` over mounted elements; `e2e/smoke.spec.ts:1620` polls
`.evaluate((element) => getComputedStyle(element).backgroundColor)`; `e2e/workbench-layout.spec.ts:87`
polls computed `overflowY`. For a FOUC assertion, poll computed styles (e.g. `color`/`background-color`
resolving to a `:root`-token value rather than the UA default) on first mode activation.

**Config context:** `playwright.config.ts` — `testDir: "./e2e"` (the new spec is auto-picked-up),
chromium-only project, vite webServer on 127.0.0.1:5307, `trace: { mode: "retain-on-failure",
snapshots: false, screenshots: false }`. The spec runs via `pnpm test:e2e` / `make test-e2e`, which is in
`release-preflight`, NOT in `make verify` (research Validation Architecture).

### `src/lib/modePreload.ts` (new, discretionary; service, event-driven) — D-03

**No exact analog exists** (no idle-preload module in the codebase). Compose two verified idioms:

**Idle scheduling primitive** — `src/lib/startupProfile.ts:88-97` (reuse, do not hand-roll):

```ts
export function scheduleStartupIdle(work: () => void, timeout = 1500): () => void {
  if (typeof window === "undefined") return () => {};
  const idleWindow = window as Window & OptionalIdleCallbacks;
  if (idleWindow.requestIdleCallback && idleWindow.cancelIdleCallback) {
    const handle = idleWindow.requestIdleCallback(work, { timeout });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }
  const handle = window.setTimeout(work, timeout);
  return () => window.clearTimeout(handle);
}
```

**Registry descriptors as the only mode reference** — `src/lib/modeRegistry.tsx:211-217` + the descriptor
shape at :46-52. The preload module must call `descriptor.load()`; it must NOT import adapter components
(src/lib boundary; adapters live under `src/lib/modeAdapters/` and are reachable only through the
registry):

```ts
export function getModeDescriptor(mode: string): ModeDescriptor | null {
  return mode in modeRegistry ? modeRegistry[mode as RegisteredModeId] : null;
}

/** Exhaustive app-mode inventory for registry tests and descriptor consumers. */
export function getRegisteredModeIds(): readonly RegisteredModeId[] {
  return registeredModeIds;
}
```

Descriptor contract (modeRegistry.tsx:46-52): `id`, `load: () => Promise<{ default:
ComponentType<ModeAdapterProps> }>`, `placements`, `isAvailable: () => boolean` (skip disabled modes —
`isE2EFlowEnabled`/`isDiagramEnabled` gates at :72/:79), `fallback: "mode-loading"`.

**`void import()` fire-and-forget idiom** — `src/main.tsx:8-9` (the precedent the research cites):

```ts
// Display serif loads as a split chunk: the KR subset @font-face list alone
// is ~90 KiB of CSS per weight, which would blow the initial-CSS bundle
// budget if imported statically. font-display: swap covers the async arrive.
void import("@fontsource/noto-serif-kr/600.css");
void import("@fontsource/noto-serif-kr/700.css");
```

**Placement constraint:** the new module lives in `src/lib/` and imports only from `./modeRegistry` and
`./startupProfile` (both src/lib). Research skeleton:

```tsx
// src/lib/modePreload.ts (new; scheduling detail is Claude's Discretion)
import { registeredModeIds, getModeDescriptor } from "./modeRegistry";
import { scheduleStartupIdle } from "./startupProfile";

export function scheduleModePreload(): () => void {
  return scheduleStartupIdle(() => {
    for (const id of registeredModeIds) {
      const descriptor = getModeDescriptor(id);
      if (!descriptor.isAvailable()) continue;      // don't fetch disabled modes
      void descriptor.load().catch(...);
    }
  }, 2000);
}
```

Note: `registeredModeIds` is module-private (not exported); `getRegisteredModeIds()` (:216-218) is the
public accessor — import that one. Wiring site: `src/main.tsx` after `markStartup("app:entry")`.

### `src/components/<mode>/<mode>.css` family (new; component styling) — D-01/D-02

**Analog:** the four proven colocated-CSS files. Import site pattern — a top-level static `import
"./<file>.css"` inside the owning pane component module:

- `src/components/graph/GraphView.tsx:18` — `import "./graph.css";` (among lib imports)
- `src/components/diagram/DiagramMode.tsx:149` — `import "./diagram.css";` (after dialog/canvas imports, before lib/theme)
- `src/components/settings/SettingsSurface.tsx:17` — `import "./settings.css";` (last import)
- `src/components/meetings/MeetingSourceWorkbench.tsx:15` — `import "./meetingSourceWorkbench.css";` (after ui/Button)

```tsx
// GraphView.tsx:15-18
import {
  chooseSaveFile,
  isTauri,
  vaultGraphLayoutRead,
  vaultGraphLayoutSave,
  vaultGraphRead,
} from "../../lib/api";
import { diagramExportBlobToPath } from "../../lib/diagram";
import "./graph.css";
```

**Placement/naming convention (Claude's Discretion):** `src/components/<mode>/<mode>.css`, one file per
mode, colocated with the mode's top-level pane component — modes whose panes live in a directory get
`<mode>.css` at that directory's root. Import site is the top-level pane component (the module the
adapter renders), NOT the adapter itself (keeps the adapter a thin loader, matching GraphModeAdapter.tsx
which renders `<GraphView .../>` and imports no CSS).

**Documented cross-file dependency precedent** — `src/components/graph/graph.css:529-530`: lazy CSS that
consumes an entry-defined class documents the dependency in place rather than duplicating the rule:

```css
/* .sr-only (used by the graph live regions) is defined in styles.css — it is
   app-wide, and this file only loads once Graph mode has been opened. */
```

**Mechanism (no config):** `vite.config.ts` (16 lines) sets no `cssCodeSplit` — the default `true` ships
CSS imported in async JS chunks with the chunk. Any transitive static import from `main.tsx`/`App.tsx`
pulls the CSS back into the entry chunk silently.

**D-02 mechanical ownership rule for the split.** Section-header census of `src/styles.css` (verified
this session; line numbers valid at HEAD):

| Section header | styles.css line | Mode | Disposition |
|---|---|---|---|
| `/* ─── Editor pane ─── */` | :3651 | EditorPane (shell-level shared component) | boundary case — likely stays |
| `/* Suspense fallbacks (lazy modes + rich editor) */` | :4024 | `.mode-loading`/`.editor-loading` | **stays** (renders before any chunk loads) |
| `/* ─── Inbox pane ─── */` | :4908 | inbox | move |
| `/* ─── Comms pane ─── */` | :5438 | comms | move |
| `/* ─── Outline pane ─── */` | :6644 | outline (editor feature) | boundary case |
| `/* ─── Maru Today pane ─── */` | :9873 | today (+ standalone tasks note at :9875) | move (tasks rules may follow the prefix) |
| `/* ─── VS Code-style tool panel (Terminal + Graph) ─── */` | :12693 | shell tool panel | boundary case — tool panel is shell chrome |
| `/* ============================ Workspace pairing ============================ */` | :15434 | pairing UI | boundary case |
| `/* =============================== System mode =============================== */` | :15479 | not a registeredModeId | boundary case — resolve owner first |
| `/* Unified Calendar (Fantastical-style) — used by TasksPane + MeetingsPane. */` | :20090 (multi-line) | tasks AND meetings | **cross-mode boundary case** — two consumers |
| `/* ─── Maru E2E flow pane ─── */` | :21111 | e2e | move (VITE-gated mode) |
| `/* ---------- Shared Outbox pane ---------- */` | :21684 | outbox (comms/inbox shared?) | boundary case |
| `/* ─── Sites mode ─── */` | :21937 | sites | move |
| `/* === Managed vault (Phase 8b) — schema strip · inspector form · switcher toggle === */` | :22404 | pkm (vault) | move |
| `/* macOS-neutral design foundation bridge */` | :23846 (multi-line) | foundations | **stays** (compat aliases for imported subsystems) |
| `/* === Drafts pane === */` | :24547 | drafts | move |
| `/* === Gap analysis pane === */` | :25014 | gap | move |
| `/* === Agents mode === */` | :25572 | agents | move |

Class-prefix resolution for the remainder (`today-*`, `scratchpad-*` at :7513+, `drafts-*`, `graph-*`,
`diagram-*`, `inbox-*`, ...): grep the prefix, move matching rule blocks. Only cross-mode selectors get
manual review per D-02. The scratchpad rules (:7513-7577+, class prefix `scratchpad-*`) are the
greppable pattern example.

**Stays in the entry stylesheet (from research + verified exemplars):** foundations tokens/`:root`
variables, the `@media (prefers-color-scheme: dark)` first-paint fallback at the file head, shell chrome,
`.mode-loading` (styles.css:4024-4035, verified):

```css
/* Suspense fallbacks (lazy modes + rich editor) */
.mode-loading,
.editor-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--muted);
  font-size: var(--type-body-size);
}
```

and `.sr-only` (styles.css:294) — consumed by graph live regions, deliberately left in styles.css
(graph.css:529-530 documents the dependency). `src/foundations.css` (92 lines: `:root` font stack,
`--shell-*` geometry, color-scheme) is the base layer that stays untouched.

### `src-tauri/tauri.conf.json` (modified; config) — D-04/D-05

**Current CSP block** (lines 33-52, verified; `"script-src"` at :35):

```json
"security": {
  "csp": {
    "default-src": "'self' ipc: http://ipc.localhost",
    "script-src": "'self' blob:",
    "worker-src": "'self' blob:",
    "connect-src": "'self' ipc: http://ipc.localhost asset: http://asset.localhost blob: data:",
    "frame-src": "'self' asset: http://asset.localhost",
    "img-src": "'self' data: blob: asset: http://asset.localhost",
    "media-src": "'self' data: blob: asset: http://asset.localhost",
    "style-src": "'self' 'unsafe-inline' asset: http://asset.localhost",
    "font-src": "'self' data: asset: http://asset.localhost blob:",
    "object-src": "'none'"
  },
  "assetProtocol": { "enable": true, "scope": { "allow": [], "deny": [] } }
}
```

Change: `"script-src": "'self' blob:"` -> `"script-src": "'self'"` (research prefers the explicit
`'self'` over deleting the key). `worker-src` blob: **stays** (D-05 — sole Worker is
`new Worker(new URL("../../lib/graph/analysis.worker.ts", import.meta.url), { type: "module" })` at
`src/components/graph/GraphInsightsPanel.tsx:43`, a same-origin URL, but the directive is declared and
locked). Only script-src narrows; connect-src/img-src/media-src/font-src keep their blob: (download
anchors in `src/lib/diagram/export.ts:78`, `src/components/e2e/E2EFlowPane.tsx:103`, `src/lib/graph/export.ts:74`,
`src/components/diagram/modals/ImportExportDialog.tsx:71` — all `a.href`, none script sources).
Pitfall: omitting script-src does not remove it — Tauri re-creates it with `'self'` when nonces exist;
dev receives NO CSP at all (no `devCsp` key), so only packaged builds prove this change.

### `scripts/check-bundle-budget.mjs` (modified; utility, file-I/O)

**Stale-comment correction** (lines 27-31, the exact text CONTEXT `<specifics>` requires corrected in
the change that lands the split):

```js
// Lowered from 500 KiB after the i18n dictionaries moved to lazy chunks
// (issue #201): the entry measured 284 KiB gzip, leaving ~12% headroom.
check("initial JS", largestMatching(/^index-.*\.js$/), 320 * 1024);
check("initial CSS", largestMatching(/^index-.*\.css$/), 70 * 1024);
```

The `~12% headroom` promise is not enforced (D-06: no headroom target pursued). Rewrite the comment to
describe post-split reality; do not change the `320 * 1024` / `70 * 1024` numbers.

**Optional per-mode CSS placement assertion** (planner discretion) extends the existing
source-text-assertion pattern (lines 46-72). Existing lazy-chunk + source assertions to imitate:

```js
const modeRegistrySource = readFileSync(new URL("../src/lib/modeRegistry.tsx", import.meta.url), "utf8");
if (!modeRegistrySource.includes('import("./modeAdapters/PkmModeAdapter")')) {
  throw new Error("bundle-budget: PKM adapter must use a dynamic registry import");
}
// ...
const appSource = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
if (appSource.includes('from "./lib/modeAdapters/PkmModeAdapter"')) {
  throw new Error("bundle-budget: App must not eagerly import the PKM adapter");
}
```

A per-mode CSS placement assertion would read the new pane component modules and fail if a mode CSS
import is reachable from `main.tsx`/`App.tsx` (pitfall 11: import-placement mistakes silently defeat the
split). Note this guard's failure style is `throw new Error("bundle-budget: ...")` (uncaught = non-zero
exit), unlike the violations-array style of check-native-e2e-isolation — match the file being edited.
Existing adapter-chunk assertions at :32-44 (Diagram/Graph/Sites/RichMarkdownEditor/Pkm/E2EFlow) are the
template for asserting new `<mode>ModeAdapter-*.css` chunk emission if desired.

### `Makefile` + `package.json` (modified; config/build orchestration)

**Two wiring patterns exist; the new guard follows the artifact-guard pattern:**

1. *Source-scanning guards* are direct `verify` prerequisites with Makefile targets:
   `check-select-chrome` (:176-178), `check-dom-sanitizer` (:180-182), `check-type-tokens` (:200-203) —
   all listed in `verify:`'s prerequisite line (:369).
2. *Dist-artifact guards* are chained into package.json `build:frontend` so they run against a freshly
   produced dist, deliberately NOT in verify's prerequisite list (check-native-e2e-isolation.mjs header,
   lines 10-13: "no new entry in verify's prerequisite list").

`check-csp-blob.mjs` is a dist/binary-artifact guard -> pattern 2. Exact current wiring:

```json
"build:frontend": "vite build && node scripts/check-bundle-budget.mjs && node scripts/check-native-e2e-isolation.mjs",
"build:frontend:native-e2e": "VITE_NATIVE_E2E=1 vite build",
"check:bundle-budget": "node scripts/check-bundle-budget.mjs",
"check:native-e2e-isolation": "node scripts/check-native-e2e-isolation.mjs",
```

Pattern: append `&& node scripts/check-csp-blob.mjs` to `build:frontend` (after
check-native-e2e-isolation), add a standalone `check:csp-blob` script. Makefile counterpart for parity
with the check family (:182-183):

```make
.PHONY: check-native-e2e-isolation
check-native-e2e-isolation: ## Static guard: no native-e2e runner affordances in the production bundle or Cargo manifest (D-10)
	$(NODE) scripts/check-native-e2e-isolation.mjs
```

**`--binary` half wiring — the release-checks window** (Makefile:295-302, verified; the build -> scan ->
prune sequence is the load-bearing pattern — the binary is deleted by the final line):

```make
release-checks: verify test-cli cli-smoke-debug ## Full verify plus release-only CLI and debug Tauri checks
	$(PNPM) tauri build --debug --no-bundle --config '{"build":{"beforeBuildCommand":null}}'
	@# D-10 artifact-level scan: the unstripped debug binary carries the same
	@# default feature set the release build uses, so a native-e2e plugin that
	@# arrived through a stray flag or a dependency is caught here. Must run
	@# BEFORE the debug-artifact prune below, which deletes the binary.
	$(NODE) scripts/check-native-e2e-isolation.mjs --binary $(TAURI_DIR)/target/debug/maru
	$(PNPM) clean:tauri-debug -- --force
```

New line: `$(NODE) scripts/check-csp-blob.mjs --binary $(TAURI_DIR)/target/debug/maru` immediately after
the existing `--binary` scan, before `clean:tauri-debug`. Inheritance chain (verified): `verify:` at
:369; `release-preflight-core` (:309-312) = diff-check + release-checks; `release-preflight` (:314-318)
= release-preflight-core + cli-smoke + test-e2e + test-e2e-native. The packaged proof therefore lands in
`release-preflight` with ONE Makefile edit; CI runs only `release-preflight-core`
(.github/workflows/release-preflight.yml). No separate release-preflight edit is needed.

**Pitfall to preserve:** `check-command-isolation` expects exactly 381 commands
(Makefile:193-194, `--all --expected-count 381`); Phase 10 adds no IPC commands.

### `src/main.tsx` (modified; controller, event-driven)

**Full current file** (19 lines) — the wiring site. Precedent for both the `void import()` idiom and the
budget rationale (:6-9); entry CSS imports (:10-11) are the only entry CSS import site:

```ts
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { markStartup } from "./lib/startupProfile";
// Display serif loads as a split chunk: the KR subset @font-face list alone
// is ~90 KiB of CSS per weight, which would blow the initial-CSS bundle
// budget if imported statically. font-display: swap covers the async arrive.
void import("@fontsource/noto-serif-kr/600.css");
void import("@fontsource/noto-serif-kr/700.css");
import "./foundations.css";
import "./styles.css";

markStartup("app:entry");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

Pattern: add `import { scheduleModePreload } from "./lib/modePreload";` and call it near
`markStartup("app:entry")`. Do NOT import per-mode CSS here or in App.tsx — that is the silent
entry-chunk regression path.

### Mode pane component modules (modified; component import sites)

Per the colocated-CSS analog above: each mode's top-level pane component gains one `import
"./<mode>.css";` line. Verified precedent modules: `GraphView.tsx:18`, `DiagramMode.tsx:149`,
`SettingsSurface.tsx:17`, `MeetingSourceWorkbench.tsx:15`. Adapters
(`src/lib/modeAdapters/*ModeAdapter.tsx`, 18 files, verified tracked) stay thin: e.g.
`GraphModeAdapter.tsx` imports only stores/lib and renders `<GraphView/>` — the CSS import belongs in
the pane component GraphView, not the adapter. `modeRegistry.tsx` itself needs NO change (its
`load()`/`lazyAdapters` seam at :61-207 already carries whatever the adapter imports).

## Shared Patterns

### Guard-script idiom (scripts/check-*.mjs family)
**Source:** `scripts/check-native-e2e-isolation.mjs` (structure), `check-select-chrome.mjs:31,47-66`
(strip-then-scan), `check-dom-sanitizer.mjs:176-207` (stripCommentsAndStrings)
**Apply to:** `scripts/check-csp-blob.mjs`
- Header comment: what runs where, why, and the sync'd-constant obligations.
- Scan PRODUCED artifacts (dist/assets, compiled binary), never sources; dist must be freshly produced
  by `pnpm build:frontend` (stale native-e2e dist fails remediation-documented, analog :113-119).
- Strip comments/strings before needle-matching (false positives block every build).
- Accumulate violations -> one stderr block -> `process.exit(1)`; success = exactly one console.log line.
- Environmental failure (missing binary path is NOT environmental; missing tooling is) -> warn-and-skip,
  never misdiagnosed as a violation (analog :136-150).
- ESLint does not scan `scripts/` (eslint.config.js D-03 comment: scope is src + e2e + e2e-native), but
  `pnpm test` runs `vitest run src scripts` — a `scripts/*.test.mjs` unit test for the new guard would be
  picked up by vitest (the `check-command-isolation.test.mjs` exclusion + `node --test` special case at
  package.json:29 is the existing precedent, not a requirement).

### Verification culture: prove against the artifact that ships
**Source:** check-native-e2e-isolation.mjs:1-9; CLAUDE.md "run that reaches the end is the healthy
signal"; Phase 6 packaged-build precedent (research)
**Apply to:** every Phase 10 change. CSP behavior is provable only in the packaged runtime (dev serves
no CSP); CSS budgets are provable only against `pnpm build:frontend` output; FOUC against a real
activation in `make test-e2e` + native confirmation in `release-preflight`.

### Bundle-budget discipline: dynamic-import the heavy stuff
**Source:** `src/main.tsx:6-9` (font CSS comment), `src/lib/modeRegistry.tsx:64-183` (18 dynamic
imports), `scripts/check-bundle-budget.mjs:27-44` (budget + lazy-chunk assertions)
**Apply to:** modePreload wiring and the CSS split. Fresh baseline (research, this session's build):
initial JS 308.3 KiB gzip <= 320; initial CSS 61.3 KiB gzip <= 70; 8 CSS chunks emitted; per-chunk CSS
gzip: Graph 6.5, Diagram 4.9, Meetings 2.1, Settings 1.4, RichEditor 34.1, index 61.3 KiB.

### Guard-scope contrast (CSS guards)
**Source:** `check-select-chrome.mjs:20-29` (collectCssFiles walks ALL `src/**/*.css` — new per-mode
files are already covered), `Makefile:199-203` (check-type-tokens greps ONLY `src/styles.css` —
per-mode files are NOT covered)
**Apply to:** the CSS split. Moved rules leave check-type-tokens' scope. styles.css is currently
token-clean so moved rules are clean, but do not treat the per-mode files as a raw-px escape hatch
(research pitfall 10: guard-weakening, forbidden). The planner may extend check-type-tokens to
`src/**/*.css` — flag as a decision, not silently.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `src/lib/modePreload.ts` | service | event-driven | No idle-preload module exists; composed from two verified idioms (`scheduleStartupIdle` + registry `descriptor.load()`) instead — role-match, see assignment above |
| packaged-CSP runtime check (`--binary` mode) | utility | binary scan | No existing binary-JSON-config scan; check-native-e2e-isolation's `--binary` byte-scan (:203-227) is the shape precedent; the embedded-config probe (`strings`-style literal match of serialized `"script-src"`) is new |

Both use RESEARCH.md patterns as primary reference; no codebase analog fully covers them.

## Metadata

**Analog search scope:** `scripts/check-*.mjs` (9 files, 4 read in full), `e2e/*.spec.ts` (24 files,
startup.spec read; getComputedStyle census), `src/lib/` (startupProfile, modeRegistry, modeAdapters),
`src/components/{graph,diagram,settings,meetings}/`, `src/main.tsx`, `src/App.tsx` (lazy census),
`src/styles.css` (section-header + prefix census), `src/foundations.css`, `Makefile`, `package.json`,
`src-tauri/tauri.conf.json`, `vite.config.ts`, `playwright.config.ts`, `eslint.config.js`.

**Files scanned:** ~60 (full reads: 14; targeted reads + greps: rest).

**Tracked-source gate:** every analog path verified via `git ls-files` this session — all tracked
(including `e2e/startup.spec.ts`, `scripts/check-command-isolation.test.mjs`,
`src/lib/modeAdapters/*`). No mirror paths emitted.

**Version/anchor drift guardrails for the planner:** the App.tsx "React.lazy mode chunks :501-521"
citation in older context is stale — the only React.lazy in App.tsx is :566
(`LazySettingsSurface`); the 18 mode chunks are `src/lib/modeRegistry.tsx:64-183`. Verify is at
Makefile:369, release-checks at :295-302, release-preflight-core at :309-312, release-preflight at
:314-318. styles.css is 26,458 lines at HEAD (research said 26,457). Line numbers in this document were
re-verified against HEAD this session.

**Pattern extraction date:** 2026-09-21

# Phase 10: Bundle and Build Hardening - Research

**Researched:** 2026-09-21
**Domain:** Frontend build/bundling (Vite 7 CSS code splitting), Tauri 2 CSP configuration, repo guard-script culture (scripts/check-*.mjs), Makefile release gates
**Confidence:** HIGH (predominantly in-repo evidence read and re-verified this session; a fresh production build was run to establish the current baseline; Tauri CSP mechanics confirmed against the vendored crate source and official docs)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

#### CSS split

- **D-01:** Full per-mode split. Every mode's CSS leaves `src/styles.css` and
  ships in that mode's own lazy chunk; only genuinely shared/base styles stay
  in the entry stylesheet. — **Reversibility:** costly — once rules are
  dispersed across per-mode files, re-consolidating means re-deriving
  ownership for every selector again.
- **D-02:** Rule ownership is assigned mechanically by the existing class
  naming convention (per-mode prefix/section pattern in `src/styles.css`);
  only boundary cases get manual review. No new analysis tooling is built for
  the assignment.

#### First-activation styling (FOUC)

- **D-03:** Preload on idle. After app load, `requestIdleCallback` triggers a
  dynamic `import()` of each mode's lazy chunk, which carries its CSS with it
  - JS and CSS are both warm before first activation. No hover/focus trigger
  is needed on top of idle preload.

#### CSP tightening

- **D-04:** Dropping `script-src blob:` requires two proofs: (a) a static
  check that nothing in the production `dist/` output requires blob: script
  URLs, in the shape of the existing `scripts/check-*.mjs` family, and
  (b) a packaged-build runtime check. The packaged check lives in
  `release-preflight` so it gates every release, not just this change.
- **D-05:** `worker-src blob:` stays. The graph worker needs it and it is
  already declared separately (`src-tauri/tauri.conf.json`); only
  `script-src blob:` is in scope.

#### Budget target

- **D-06:** Passing the existing 70 KiB initial-CSS budget is sufficient. The
  budget numbers are not raised (per PERF-05) and no additional headroom
  target (e.g. restoring the ~12% margin from the v0.4.46-era comment in
  `scripts/check-bundle-budget.mjs`) is pursued in this phase.

### Claude's Discretion

- Per-mode CSS file placement and naming convention under `src/`.
- How the static "dist requires blob: script" check is implemented, within
  the `scripts/check-*.mjs` idiom.
- Preload scheduling details (which modes, idle callback ordering).

### Deferred Ideas (OUT OF SCOPE)

None - discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SEC-01 | "`script-src 'self' blob:` is dropped from the CSP if the Vite production build no longer requires it, verified against a packaged build rather than a dev server, since this class of removal can pass in development and fail only in the shipped bundle." ([VERIFIED: .planning/REQUIREMENTS.md:101-104]) | Blob-usage census: app code never creates blob: script URLs (only download-anchor blob: URLs in 4 files; the sole Worker loads from a same-origin URL). Tauri CSP mechanics verified: production CSP is an HTTP response header serialized from config at runtime; dev serves no CSP at all (no `devCsp`), which is exactly the dev-passes/shipped-fails hazard. D-04's two proofs map to: (a) a new dist-scanning check in the check-*.mjs idiom chained into `build:frontend`/`make verify`; (b) a packaged-artifact check in the Makefile `release-checks` window, where a debug no-bundle Tauri binary already exists and is scanned before pruning (check-native-e2e-isolation precedent). |
| PERF-05 | "Per-mode CSS ships in the lazy chunk of the mode that uses it rather than in the entry stylesheet, restoring the initial-CSS budget headroom spent since v0.4.46. The budget numbers themselves are not raised, and no mode shows unstyled content on its first activation." ([VERIFIED: .planning/REQUIREMENTS.md:49-53]) | Vite `cssCodeSplit` defaults to true and is not overridden in vite.config.ts; when enabled "CSS imported in async JS chunks will be preserved as chunks and fetched together when the chunk is fetched" [CITED: https://vite.dev/config/build-options.html]. Five component CSS files (graph, diagram, meetings, settings, rich editor) already ship in their own lazy chunks, proving the mechanism. Fresh baseline: entry CSS 61.3 KiB gzip vs 70 KiB budget (passes today); moving mode sections out of the 26,457-line styles.css reduces it further. FOUC handled by D-03 idle preload plus existing Suspense fallback styles already in the entry stylesheet. |
</phase_requirements>

## Summary

Phase 10 is two mechanical changes plus two proofs, and nearly everything the planner needs is already in the repo:

1. **CSS split (PERF-05, D-01/D-02):** Move each mode's rules out of the `src/styles.css` monolith (26,457 lines) into per-mode CSS files colocated with the mode's pane components, imported at the top of the component module the adapter loads. Vite's default `cssCodeSplit: true` then ships that CSS in the mode's lazy chunk automatically - no Vite config change is required or wanted. Ownership assignment follows D-02's mechanical rule: styles.css is already organized in section-header comment blocks with per-mode class prefixes (e.g. "=== Drafts pane ===", "=== Gap analysis pane ===", "=== Agents mode ==="), and 5 existing component-level CSS files demonstrate the exact target pattern.
2. **CSP tightening (SEC-01, D-04/D-05):** Change `"script-src": "'self' blob:"` to `"script-src": "'self'"` in tauri.conf.json. Nothing in the app requires blob: script URLs. Two proofs per D-04: a static dist scan (new check-*.mjs script) and a packaged-artifact check riding the existing `release-checks` window where a Tauri binary with the embedded config already exists.
3. **FOUC prevention (criterion 3, D-03):** Idle preload of every mode chunk via the existing `scheduleStartupIdle` helper in src/lib/startupProfile.ts plus `import()` of each mode adapter - the same `void import()` idiom main.tsx already uses for the lazy font CSS.

**Primary recommendation:** Land the CSS split as one plan with per-mode file moves (mechanical, reviewable per mode), and the CSP drop as a second plan with its two proofs. Update the stale headroom comment in check-bundle-budget.mjs in the same change that touches the budget gate (10-CONTEXT.md `<specifics>`). Do not raise any budget (D-06). Do not touch `worker-src` (D-05).

## Architectural Responsibility Map

| Concern | Owner | Notes |
|---------|-------|-------|
| CSP directives | `src-tauri/tauri.conf.json` `app.security.csp` (object form) | Serialized to an HTTP header at runtime by Tauri; embedded into the compiled binary by tauri-codegen |
| Entry stylesheet imports | `src/main.tsx:10-11` | `import "./foundations.css"; import "./styles.css";` - the only entry CSS import site |
| Per-mode CSS files | `src/components/<mode>/<mode>.css` (new, colocated) | Imported at the top of the mode's top-level pane component; rides the adapter's lazy chunk via cssCodeSplit |
| Mode lazy seam | `src/lib/modeRegistry.tsx:64-183` | 18 dynamic imports, one per mode: `load: () => import("./modeAdapters/XModeAdapter").then((module) => ({ default: module.XModeAdapter }))` |
| Idle scheduling primitive | `src/lib/startupProfile.ts:88-100` (`scheduleStartupIdle`) | requestIdleCallback with setTimeout fallback, cancel handle returned - reuse, do not hand-roll |
| Budget gate | `scripts/check-bundle-budget.mjs` | `initial JS` <= 320 KiB, `initial CSS` <= 70 KiB (gzip); stale ~12% comment at lines 27-28 to correct |
| dist artifact guards | `scripts/check-native-e2e-isolation.mjs` (bundle half) | The idiom to extend: scan dist/assets produced output, fail closed, chained into `build:frontend` |
| Release gates | `Makefile` | `verify` (:369) is the gate; `release-checks` (:296) has the binary-scan window; `release-preflight` (:311) is the human-run macOS full pass; CI runs only `release-preflight-core` |
| FOUC verification | `e2e/` (Playwright, browser mode) and/or `e2e-native/` | No existing FOUC/CSP spec exists; new spec is a Wave 0 implementation task |
| Suspense fallback styling | `src/styles.css:4024-4035` (`.mode-loading`) | Must stay in the entry stylesheet - it renders before any mode chunk loads |

## Standard Stack

All versions resolved from lockfiles this session (no assumptions):

| Package | Version (resolved) | Declared | Evidence |
|---------|--------------------|----------|----------|
| vite | 7.3.2 | ^7.3.1 | [VERIFIED: pnpm-lock.yaml:156-158] |
| @vitejs/plugin-react | 5.2.0 | ^5.1.1 | [VERIFIED: pnpm-lock.yaml:117-119] |
| react / react-dom | 19.2.5 | ^19.2.0 | [VERIFIED: pnpm-lock.yaml:86-91] |
| typescript | 5.9.3 | ~5.9.3 | [VERIFIED: pnpm-lock.yaml:150-152] |
| vitest | 4.1.5 | ^4.1.5 | [VERIFIED: pnpm-lock.yaml:159-161] |
| @tauri-apps/api / cli | ^2.10.1 / ^2.10.0 | - | [VERIFIED: package.json dependencies] |
| tauri (Rust) | 2.10.3 | - | [VERIFIED: src-tauri/Cargo.lock:4998-4999 `name = "tauri"` / `version = "2.10.3"`] |
| tauri-utils (transitive) | 2.8.3 | - | [VERIFIED: cargo registry cache, CSP injection source read] |

Relevant standard-library/browser APIs (no packages): `requestIdleCallback`, dynamic `import()`, `URL.createObjectURL` (download anchors only), module Workers.

## Package Legitimacy Audit

**No new external packages are needed for this phase.** The CSS split is file moves plus import statements; the CSP change is a config edit; both proofs reuse the repo's own check-*.mjs idiom and Node built-ins (node:fs, node:zlib already used by check-bundle-budget.mjs); the idle preload uses the browser API via the existing `scheduleStartupIdle` helper. This is stated explicitly per planner requirement: zero new dependencies, zero new dev-dependencies. The five version surfaces that must stay in sync (per project CLAUDE.md) are untouched by this phase except tauri.conf.json's CSP block, which is config, not version.

## Architecture Patterns

### System diagram: where each change lands in the build pipeline

```text
src/main.tsx ──imports──> foundations.css + styles.css (entry, shrinks)
     │
     └─ App.tsx ──modeRegistry.tsx──> import("./modeAdapters/X")   (18 lazy seams)
                                          │ cssCodeSplit (default true)
                                          ▼
                              dist/assets/XModeAdapter-<hash>.js + .css  (per-mode chunk pair)

vite build ──> dist/ ──> check-bundle-budget.mjs (JS<=320, CSS<=70 KiB gzip)
                     ──> NEW check: dist blob:-script scan  (D-04 proof a, make verify)
                     ──> check-native-e2e-isolation.mjs (existing)
       │
tauri build ──> compiled binary with embedded tauri.conf.json (config via codegen)
       │           ──> NEW packaged-CSP check in Makefile release-checks window (D-04 proof b)
       ▼
packaged app runtime: CSP delivered as HTTP header on tauri:// asset responses
```

### Recommended per-mode CSS structure (Claude's Discretion: placement/naming)

Follow the pattern the repo already proved. `graph.css`, `diagram.css`, `settings.css`, and `meetingSourceWorkbench.css` are colocated with their owning component and imported at the top of the component module ([VERIFIED: src/components/graph/GraphView.tsx:18, src/components/diagram/DiagramMode.tsx:149, src/components/settings/SettingsSurface.tsx:17, src/components/meetings/MeetingSourceWorkbench.tsx:15]). Their CSS demonstrably ships in the mode's lazy chunk (fresh build lists `GraphModeAdapter-*.css`, `DiagramModeAdapter-*.css`, `MeetingsModeAdapter-*.css`, `SettingsSurface-*.css` in dist/assets).

- **Placement:** `src/components/<mode>/<mode>.css` - one file per mode, colocated with the mode's top-level pane component. Modes whose panes live in a directory (today/, tasks/, drafts/, gap/, agents/, inbox/, comms/, files/, pkm/, catalog/, studio/, dashboard/, scratchpad/, e2e/, diagram/, graph/, sites/) get `<mode>.css` at that directory's root.
- **Import site:** the top of the mode's top-level pane component (the module the adapter renders), not the adapter itself - matching the existing graph/diagram precedent and keeping the adapter a thin loader.
- **Ownership assignment (D-02 mechanical rule):** styles.css section-header comments map blocks to modes (census: line 4024 "Suspense fallbacks (lazy modes + rich editor)" stays; 15434 "Workspace pairing"; 15479 "System mode"; ~20090 calendar; 22404 "Managed vault (Phase 8b)"; 22488 "Standalone Files workspace"; 23415 "Agents settings tab"; 24547 "=== Drafts pane ==="; 25014 "=== Gap analysis pane ==="; 25572 "=== Agents mode ==="). Class prefixes (`today-*`, `drafts-*`, `graph-*`, `diagram-*`, `inbox-*`, ...) resolve the remainder; only genuinely cross-mode selectors get manual review.
- **Stays in the entry stylesheet:** foundations-level tokens, `:root` variables, the `@media (prefers-color-scheme: dark)` first-paint fallback, shell chrome (activity rail, editor tabs, dialogs, tool panels), `.mode-loading` Suspense fallback, and app-wide utility classes referenced by lazy CSS (`.sr-only` is consumed by graph live regions and deliberately left in styles.css - the dependency is documented at src/components/graph/graph.css:529-530).

### Patterns to follow

- **CSS import from the lazy component rides the chunk.** Mechanism, not config: Vite assigns CSS to chunks by import-graph reachability. A per-mode CSS file is split iff it is reachable only through the mode's dynamic import. Any transitive static import from main.tsx/App.tsx pulls it back into the entry chunk.
- **Scan produced artifacts, not sources.** D-04's static proof reads dist/ output (what actually ships), exactly as check-native-e2e-isolation.mjs's bundle half reads dist/assets/*.js. Source scans miss dependency-introduced usage and minifier rewrites.
- **Fail closed with a success line.** check-*.mjs idiom: violations to stderr + `process.exit(1)`; on success one `console.log("...: all clear")` line.
- **Reuse `scheduleStartupIdle`** (requestIdleCallback + timeout fallback + cancel handle) for D-03 preload rather than new scheduling code.

### Anti-patterns (rejected in discussion log; do not resurrect)

- Raising any budget number (D-06, PERF-05 explicitly forbids).
- Hover/focus-triggered preload (D-03 locked idle preload; hover adds a first-hover lag path).
- DOM-based CSS attribution tooling (D-02 locked the mechanical prefix/section rule).
- Static-only CSP proof (D-04 requires the packaged check too).
- Scanning src/ for blob: instead of dist/ (produced artifact is the ship truth).
- Two-way/combined lazy CSS bundle (D-01 locked full per-mode split).

## Don't Hand-Roll

| Need | Use instead | Why |
|------|-------------|-----|
| CSS chunk splitting | Vite `cssCodeSplit` default (vite.config.ts sets nothing) | "When enabled, CSS imported in async JS chunks will be preserved as chunks and fetched together when the chunk is fetched" [CITED: https://vite.dev/config/build-options.html] |
| CSS gzip measurement | `check-bundle-budget.mjs` (`gzipSync` from node:zlib) | Existing gate already measures exactly the right artifact |
| Idle scheduling | `scheduleStartupIdle` in src/lib/startupProfile.ts:88-100 | Existing requestIdleCallback + fallback + cancel helper |
| Sanitizer tracing gate | existing `check-dom-sanitizer.mjs` | SEC-02 already landed; do not duplicate |
| select-chrome protection | existing `check-select-chrome.mjs` | Already guards background-shorthand resets across ALL css files including new per-mode ones |
| Binary artifact scan idiom | `check-native-e2e-isolation.mjs --binary` half | The exact pattern for a packaged-binary config check |
| Comment/string stripping for CSS scans | `stripComments` in check-select-chrome.mjs + `([^{}]+)\{([^{}]*)\}` rule regex | Proven, works inside @media/@container |

## Common Pitfalls

1. **Dev server passes, packaged build fails (SEC-01's exact warning).** tauri.conf.json has no `devCsp`; in dev the webview loads http://127.0.0.1:5307 and receives NO CSP at all, so dev can never validate CSP behavior. Only the packaged runtime (tauri:// asset protocol, CSP as HTTP header) enforces it. Every CSP claim must be proven against the built artifact.
2. **Meta-tag misconception.** Production CSP is delivered as an HTTP response header on the tauri:// asset protocol response, not a `<meta http-equiv>` tag. The meta-tag injection path in tauri-utils `create_csp_meta_tag` exists only for `data:`-URL webviews (feature-gated). A runtime check must not look for a CSP meta tag in the packaged DOM.
3. **Omitting `script-src` does not remove `script-src`.** Tauri's `replace_csp_nonce` runs for script-src when the HTML carries nonce placeholders and re-creates the directive via `csp.entry("script-src").or_default()` plus `'self'` ([VERIFIED: cargo cache tauri-2.10.3 src/manager/mod.rs:126-155]). Deleting the key and setting `"script-src": "'self'"` end up equivalent at runtime; prefer the explicit `'self'` for readability, but do not expect the directive to vanish from the shipped header.
4. **Cross-file selector dependencies.** Lazy CSS references entry-defined classes: `.sr-only` (graph live regions; documented at graph.css:529), `.mode-loading` (Suspense fallback, styles.css:4024-4035). Moving a shared utility into a mode file breaks every other consumer; the D-02 boundary-case review exists for exactly these.
5. **`background` shorthand resets.** check-select-chrome.mjs exists because a scoped `background:` shorthand silently resets the select chevron background-image set by the base rule. The new per-mode CSS files are already inside that guard's scan scope (it walks all src/**/*.css) - do not reintroduce shorthands that clobber entry-defined backgrounds.
6. **First-paint fallback must stay in entry.** The `@media (prefers-color-scheme: dark)` block at the top of styles.css is the pre-CSS-load/pre-hydration color fallback; it must never move to a lazy chunk.
7. **Stale dist/ after a native-e2e build.** `pnpm build:frontend:native-e2e` (VITE_NATIVE_E2E=1) produces a dist/ that the isolation guard correctly rejects. Any guard run against dist/ must follow a fresh `pnpm build:frontend` (check-native-e2e-isolation.mjs's failure message documents this exact remediation).
8. **check-command-isolation count.** `make verify` runs `check-command-isolation.mjs --all --expected-count 381` ([VERIFIED: Makefile:192-194]). Phase 10 adds no IPC commands; if any plan touches src-tauri command registration this number breaks - it shouldn't.
9. **eslint --max-warnings 0.** `pnpm lint` runs `eslint src e2e e2e-native --max-warnings 0` ([VERIFIED: package.json:21]); new files must be warning-free.
10. **check-type-tokens scope.** The raw-px guard greps only `src/styles.css` ([VERIFIED: Makefile:200-204]); graph.css/diagram.css still carry pre-existing raw values and are documented as "not gated yet". Do not move raw-px rules into per-mode CSS files as a way to escape the guard - that would be a guard-weakening change (forbidden by project constraints).
11. **Import-placement mistakes silently defeat the split.** A per-mode CSS file transitively imported by App.tsx or main.tsx lands in the entry chunk and the CSS budget improvement evaporates without any error. Worth a cheap assertion (see Validation Architecture).
12. **App.tsx seam drift.** The orchestrator's context cites "React.lazy mode chunks at src/App.tsx:501-521" - that is stale. The only React.lazy in App.tsx is line 566 (`LazySettingsSurface`); the 18 mode chunks are dynamic imports in `src/lib/modeRegistry.tsx:64-183`. Plans must anchor on modeRegistry.
13. **Do not hand-edit generated artifacts.** dist/, src-tauri/gen/schemas/, and lockfiles are generated (project CLAUDE.md); the packaged check must scan build OUTPUT as produced, never write it.

## Code Examples

### 1. CSP change (src-tauri/tauri.conf.json:33-46)

```jsonc
"security": {
  "csp": {
    "default-src": "'self' ipc: http://ipc.localhost",
    "script-src": "'self'",            // was: "'self' blob:"  (SEC-01, D-04)
    "worker-src": "'self' blob:",      // unchanged (D-05: graph worker)
    "connect-src": "'self' ipc: http://ipc.localhost asset: http://asset.localhost blob: data:",
    "frame-src": "'self' asset: http://asset.localhost",
    "img-src": "'self' data: blob: asset: http://asset.localhost",
    "media-src": "'self' data: blob: asset: http://asset.localhost",
    "style-src": "'self' 'unsafe-inline' asset: http://asset.localhost",
    "font-src": "'self' data: asset: http://asset.localhost blob:",
    "object-src": "'none'"
  }
}
```

Note connect-src/img-src/media-src/font-src keep their blob: (download anchors, images, media, fonts) - only script-src narrows.

### 2. Static dist blob:-script check skeleton (D-04 proof a; check-*.mjs idiom)

```js
// scripts/check-csp-blob.mjs — D-04 proof (a): the production dist/ output
// must not require blob: script URLs. Scans the PRODUCED artifact, not
// sources, because dependency-introduced usage and minifier rewrites only
// exist in the bundle (same reasoning as check-native-e2e-isolation's
// bundle half).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const distAssets = join(dirname(fileURLToPath(import.meta.url)), "../dist/assets");
if (!existsSync(distAssets)) {
  console.error("csp-blob: dist/assets/ does not exist — run `pnpm build:frontend` first");
  process.exit(1);
}

const violations = [];
for (const file of readdirSync(distAssets).filter((f) => f.endsWith(".js"))) {
  const content = readFileSync(join(distAssets, file), "utf8");
  // A script-source blob: URL is created by `new Worker(blobUrl)` /
  // `import(blobUrl)` / `script.src = blobUrl` from a Blob-backed
  // URL.createObjectURL result. Download-anchor blob: URLs (a.href = url)
  // and blob: strings inside CSP config text are NOT script sources and
  // must not match. Keep the needles narrow and fail closed on doubt.
  if (/new\s+Worker\s*\(\s*[A-Za-z_$][\w$.]*\b/.test(content) === false) continue;
  // (implementation task: attribute each Worker/import call site to whether
  //  its URL argument can be a blob: URL; a false positive here blocks every
  //  build, so the shipped check needs the comment/string-stripping pass from
  //  check-dom-sanitizer.mjs before landing)
}
if (violations.length > 0) {
  console.error(`csp-blob: dist requires blob: script URLs:\n  ${violations.join("\n  ")}`);
  process.exit(1);
}
console.log("csp-blob: dist carries no blob: script sources");
```

Chained into `"build:frontend"` after check-native-e2e-isolation.mjs (same pattern that guard's header documents: "Chained into `build:frontend` ... so `make verify` carries it against a freshly produced production bundle with no new entry in verify's prerequisite list").

### 3. Packaged-CSP check (D-04 proof b) — rides the existing release-checks window

The CSP config is embedded in the compiled binary by tauri-codegen; the debug no-bundle binary provably carries the literal config text (this session: `strings src-tauri/target/debug/maru` matched `script-src": "'self' blob:",`). The Makefile `release-checks` recipe already builds that binary, scans it (check-native-e2e-isolation --binary), then deletes it:

```make
release-checks: verify test-cli cli-smoke-debug ## Full verify plus release-only CLI and debug Tauri checks
	$(PNPM) tauri build --debug --no-bundle --config '{"build":{"beforeBuildCommand":null}}'
	$(NODE) scripts/check-native-e2e-isolation.mjs --binary $(TAURI_DIR)/target/debug/maru
	@# NEW (Phase 10): packaged-CSP proof (D-04 b) — the same binary embeds the
	@# tauri.conf.json CSP; assert script-src carries no blob: before the prune.
	$(NODE) scripts/check-csp-blob.mjs --binary $(TAURI_DIR)/target/debug/maru
	$(PNPM) clean:tauri-debug -- --force
```

The check parses the embedded config JSON (or greps the serialized `script-src` source list) and fails closed if `blob:` appears in script-src. `release-preflight` inherits it through `release-preflight-core` (diff-check -> release-checks), satisfying D-04's "lives in release-preflight".

### 4. Idle preload (D-03) skeleton using the existing helper

```tsx
// src/lib/modePreload.ts (new; scheduling detail is Claude's Discretion)
import { registeredModeIds, getModeDescriptor } from "./modeRegistry";
import { scheduleStartupIdle } from "./startupProfile";

export function scheduleModePreload(): () => void {
  return scheduleStartupIdle(() => {
    for (const id of registeredModeIds) {
      const descriptor = getModeDescriptor(id);
      if (!descriptor.isAvailable()) continue;      // don't fetch disabled modes
      void descriptor.load().catch(() => {});       // warm JS+CSS; failure is non-fatal
    }
  }, 2000);
}
// main.tsx (browser mode or always): const cancelPreload = scheduleModePreload();
```

Precedent for the `void import()` idiom and the budget rationale: src/main.tsx:8-9 lazy-loads the Noto Serif KR font CSS with the comment that static import "would blow the initial-CSS bundle budget" and "font-display: swap covers the async arrive".

## Runtime State Inventory

- **CSS-split refactor (frontend files):** no stored data, no live service config, no OS-registered state, no secrets. Pure source-file reorganization; a stale read of styles.css is impossible after a clean checkout.
- **CSP change (tauri.conf.json):** config surface consumed at app build time; affects updater artifacts (`createUpdaterArtifacts: true`) built afterwards. No runtime migration; existing installs pick it up via the next update. No secrets involved.
- **Build artifacts (freshness):** dist/ and *.tsbuildinfo are stale-prone. Guards that read dist/ must run after a fresh `pnpm build:frontend`; the binary CSP check must run inside the release-checks window while the debug binary exists (it is deleted by `clean:tauri-debug` immediately after).
- **CI runners:** stateless; no changes needed. CI executes only `make release-preflight-core` ([VERIFIED: .github/workflows/release-preflight.yml:59-60]); the full `release-preflight` (native suite, packaged proof) remains a human-run macOS gate, consistent with the existing verification culture.

## Environment Availability

All required tooling is present and was exercised this session: `node` (check scripts ran), `pnpm` (fresh `pnpm build:frontend` completed clean: initial JS 308.3 KiB gzip <= 320, initial CSS 61.3 KiB gzip <= 70, all 8 CSS chunks emitted), `cargo` (cargo metadata used by guards; crate cache inspected), `make` (Makefile targets read). Web access was available: Vite build-options and Tauri CSP docs fetched successfully (no ctx7 CLI; the MCP server offers no docs provider - web_fetch covered the gap).

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | vitest 4.1.5 (TypeScript/React unit) + cargo test (Rust unit) |
| Config file | none standalone - vitest invoked via package.json scripts: `"test": "vitest run src scripts --exclude '**/check-command-isolation.test.mjs' && node --test scripts/check-command-isolation.test.mjs"` |
| Quick run command | `pnpm test` |
| Full suite command | `make test` (runs `test-ts` + `test-rust`: vitest + cargo test) |

`make verify` remains the gate ([VERIFIED: Makefile:369-370]): typecheck, lint, release-version-check, icons-check, lint-i18n, check-select-chrome, check-dom-sanitizer, check-type-tokens, test-ts, test-rust, fmt-check, clippy, build-frontend (which chains check-bundle-budget.mjs + check-native-e2e-isolation.mjs), check-command-isolation.

### Phase Requirements -> Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| SEC-01 (proof a) | dist/ requires no blob: script URLs | static artifact scan (check-*.mjs) | `node scripts/check-csp-blob.mjs` (chained into `pnpm build:frontend` -> `make verify`) | New guard - Wave 0 |
| SEC-01 (proof b) | packaged config's script-src has no blob: | packaged-artifact scan in Makefile release-checks window | `node scripts/check-csp-blob.mjs --binary src-tauri/target/debug/maru` (wired into `release-checks`; inherited by `release-preflight` via `release-preflight-core`) | New - Wave 0 |
| PERF-05 | initial CSS <= 70 KiB gzip, un-raised | budget gate (existing) | `node scripts/check-bundle-budget.mjs` (already in `pnpm build:frontend`) | Existing |
| PERF-05 | per-mode CSS in lazy chunks, never entry | budget gate + optional source assertion (mode CSS files not reachable from main.tsx/App.tsx; planner discretion per CONTEXT integration point) | same command chain | Optional assertion - Wave 0 |
| Criterion 3 (FOUC) | no unstyled first activation | e2e: new Playwright spec asserting computed styles on first mode activation (browser mode); native confirmation via e2e-native suite in release-preflight (macOS, human-run); manual visual pass as documented fallback | `pnpm test:e2e` / `make test-e2e` (in `release-preflight`, NOT in `make verify`) | New spec - Wave 0 |
| D-03 preload | idle preload warms chunks | manual/observation (startupProfile-style marks or devtools); no gate justified - preload failure degrades gracefully to normal lazy load | - | - |

### Sampling Rate

- **Per task commit:** `pnpm test` (plus `pnpm build:frontend` for any change touching dist-scanning guards or CSS placement)
- **Per wave merge:** `make verify`
- **Phase gate:** `make verify` green + `make release-preflight` (human-run, macOS: includes the packaged-CSP proof and e2e/native suites) before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `scripts/check-csp-blob.mjs` (new static + `--binary` modes) - covers SEC-01 both proofs
- [ ] `e2e/first-activation-styles.spec.ts` (new) - covers criterion 3
- [ ] Optional: per-mode CSS placement assertion in check-bundle-budget.mjs - covers PERF-05 hardening
- [ ] Stale-comment correction in check-bundle-budget.mjs:27-28 - 10-CONTEXT.md `<specifics>` requires it in the change that lands the split

No framework install needed - existing test infrastructure covers everything else. (None of these are test-runner gaps; all land as ordinary implementation tasks.)

## Security Domain

Enforcement is active (`workflow.security_enforcement` defaults true per planning-config reference; .planning/config.json sets neither key, so nyquist_validation and security_enforcement are both treated as enabled). This section feeds `<threat_model>` blocks in future PLAN.md files for this phase.

### Applicable ASVS Categories (L1 - Opportunistic, the GSD default)

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V14 Config (CSP) | **yes - this phase's core** | tauri.conf.json `app.security.csp` object form; Tauri compile-time nonce/hash injection; mitigation verified PRESENT via the packaged-artifact check |
| V5 Input Validation | yes (adjacent, already landed) | DOMPurify-backed helper tracing, enforced by `check-dom-sanitizer.mjs` (SEC-02, `make verify` gate) |
| V4 Access Control | no change | Tauri IPC command surface (365 commands) untouched by this phase |
| V2/V3/V6 | no | No auth, session, or crypto surface touched |

### Known Threat Patterns for Tauri 2 + React 19 desktop webview

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| XSS escalation via blob: script URLs - injected DOM (third-party content rendered through innerHTML sinks: Telegram, KakaoTalk, Gmail, Outlook, inbox drops) can create executable script URLs while `script-src blob:` is allowed | Tampering / Elevation of Privilege | Drop `script-src blob:` (this phase) + existing DOMPurify sink tracing (SEC-02). Planner disposition: mitigate (high, primary trust boundary). |
| CSP weakening via worker-src blob: retention | Tampering | Accepted with documented rationale (D-05 locked): the graph analysis worker requires it; directive is scoped to workers only, and worker context cannot reach the DOM/IPC surface that script execution in the main frame would. Planner disposition: accept, rationale = locked decision D-05. |
| Dev/prod CSP divergence (CSP absent in dev, enforced only in packaged runtime) | Tampering (evidence gap) | D-04 two-proof design: dist artifact scan in `make verify` + packaged-binary check in `release-preflight`. Planner disposition: mitigate. |
| innerHTML sinks receiving unsanitized third-party HTML | Tampering | Existing: every sink traces to a DOMPurify helper (check-dom-sanitizer.mjs, exit 1). No change this phase. |

**Block-on-high:** threats at high severity on the primary trust boundary (the webview content -> IPC surface) must be mitigated, not accepted, before phase verification.

## Project Constraints (from CLAUDE.md)

- `make verify` is the gate; do not weaken or delete existing guards.
- `check-command-isolation` expects exactly **381** registered commands (`--all --expected-count 381`, Makefile:194).
- No raw `font-size: Npx` in `src/styles.css` - use `--type-*`/`--read-*` tokens from src/foundations.css (check-type-tokens guard, Makefile:200-204).
- Every `dangerouslySetInnerHTML` sink in src/ must trace to a DOMPurify-backed helper (check-dom-sanitizer.mjs).
- Generated directories and files are not hand-edited: `dist/`, `src-tauri/gen/schemas/`, lockfiles (pnpm-lock.yaml, Cargo.lock).
- `src/lib` must not import components, except the documented type-only legacy imports (knowledgeModeStore.ts, terminalPanelStore.ts). Note: the new preload module lives in src/lib and must reference the registry's descriptors, not import adapter components.
- Nothing imports `src/App.tsx`.
- Keyed module stores with `useSyncExternalStore`; no new state library.
- Five version surfaces stay in sync (package.json, tauri.conf.json, Cargo.toml, Cargo.lock, pnpm-lock.yaml); Phase 10 touches only tauri.conf.json's CSP block, not versions.
- Git commit messages in English; orchestrator commits (research does not commit).

## Sources

### Primary (HIGH confidence - all read this session, in-repo)

- `.planning/phases/10-bundle-and-build-hardening/10-CONTEXT.md` - D-01..D-06, Claude's Discretion, canonical refs, specifics (stale-comment correction), integration points
- `.planning/REQUIREMENTS.md:49-53, 101-104` - PERF-05, SEC-01 verbatim
- `.planning/ROADMAP.md:245-258` - Phase 10 goal, success criteria, dependencies
- `src-tauri/tauri.conf.json:33-52` - full CSP block verbatim (`"script-src": "'self' blob:"` at :35, `"worker-src": "'self' blob:"` at :36); no devCsp key anywhere in the file
- `scripts/check-bundle-budget.mjs:1-45` - budgets (:29-30), gzip measurement, stale comment (:27-28)
- `scripts/check-native-e2e-isolation.mjs:1-31, full` - two-half artifact-scan design, dist/ scanning pattern, environmental-failure warn-and-skip precedent
- `scripts/check-select-chrome.mjs:1-80` - CSS-scanning idiom (stripComments, rule regex), cross-file dependency rationale
- `scripts/check-dom-sanitizer.mjs:1-31, full` - check-*.mjs tracing idiom, comment/string stripping
- `scripts/check-command-isolation.mjs:445, 470-476` - expected-count mechanics (365 baseline + 16 integrations = 381 via Makefile)
- `Makefile:90, 168-170, 192-204, 288-315, 369-370` - build-frontend, test, check-command-isolation, check-type-tokens, release-checks window (build -> scan -> prune), release-preflight(-core), verify
- `package.json:13-21` - build/build:frontend/build:frontend:native-e2e/test/lint scripts
- `pnpm-lock.yaml:86-161` - resolved versions; `src-tauri/Cargo.lock:4998-4999` - tauri 2.10.3
- `vite.config.ts` (16 lines, full) - no cssCodeSplit override, server config
- `src/main.tsx:8-11` - entry CSS imports + lazy font CSS precedent
- `src/foundations.css` (91 lines, full) - base layer that stays in entry
- `src/styles.css` (26,457 lines) - section-header census for D-02; .mode-loading at 4024-4035; .sr-only at 294; dark-scheme fallback at head
- `src/lib/modeRegistry.tsx:14-18, 60-77, 64-183` - registeredModeIds (18 modes), load() shape, the actual lazy seam
- `src/lib/startupProfile.ts:88-100` - scheduleStartupIdle helper
- `src/App.tsx:566, 8432` - LazySettingsSurface; Suspense fallback
- `src/components/graph/GraphInsightsPanel.tsx:43` - the sole Worker instantiation (`new Worker(new URL("../../lib/graph/analysis.worker.ts", import.meta.url), { type: "module" })`)
- `src/components/graph/graph.css:529-530` - documented .sr-only cross-file dependency
- Blob-usage census (this session): src/lib/diagram/export.ts:78, src/components/e2e/E2EFlowPane.tsx:103, src/lib/graph/export.ts:74, src/components/diagram/modals/ImportExportDialog.tsx:71 - all download anchors, none script sources
- CSS-import census (this session): exactly 6 `import "*.css"` in src - main.tsx x2, plus the 4 lazy component CSS files
- `.planning/codebase/CONCERNS.md:96-200` - §2 CSP concern verbatim (:119-121), §3 budget baselines (:153-155; note: measured at a938128, now stale - fresh build passes both gates)
- `.planning/codebase/ARCHITECTURE.md` - mode adapter pattern, bundle budget guard notes (note: line 49 "eager ScratchpadPane" is doc drift - ScratchpadPane loads via ScratchpadModeAdapter in modeRegistry)
- `.github/workflows/release-preflight.yml:17-18, 59-60` - CI runs only release-preflight-core
- `e2e-native/wdio.conf.ts:16` + `e2e-native/specs/webview.spec.ts` - native runner launches the debug binary; no existing CSP/FOUC spec
- Fresh build measurement (this session, `pnpm build:frontend`): initial JS 308.3 KiB gzip <= 320 KiB; initial CSS 61.3 KiB gzip <= 70 KiB; 8 CSS chunks (fonts 600/700, Diagram/Graph/MeetingsModeAdapter, RichMarkdownEditor, SettingsSurface, index); per-chunk gzip: Graph 6.5, Diagram 4.9, Meetings 2.1, Settings 1.4, RichEditor 34.1, index 61.3 KiB

### Secondary (MEDIUM-HIGH confidence - vendored crate source)

- cargo registry cache `tauri-2.10.3/src/manager/mod.rs:50-155` - set_csp/replace_csp_nonce: nonce placeholders replaced at runtime, script-src re-created via or_default() with 'self' when nonces/hashes exist
- cargo registry cache `tauri-2.10.3/src/protocol/tauri.rs:214-218` - CSP delivered as HTTP response header on asset protocol responses
- cargo registry cache `tauri-2.10.3/src/manager/webview.rs:456-466` + `tauri-utils-2.8.3/src/html.rs:160-186` - meta-tag CSP injection exists ONLY in the feature-gated data-URL path
- Debug binary strings scan (this session): `script-src": "'self' blob:",` found verbatim in src-tauri/target/debug/maru - config is embedded in compiled binaries by codegen

### Tertiary ([CITED] official docs)

- [CITED: https://vite.dev/config/build-options.html] - build.cssCodeSplit: default true; "Enable/disable CSS code splitting. When enabled, CSS imported in async JS chunks will be preserved as chunks and fetched together when the chunk is fetched."
- [CITED: https://v2.tauri.app/security/csp/] - CSP object form in tauri.conf.json; compile-time nonce/hash appending; blob: appears in examples' img-src; page does not document meta-vs-header injection (settled via crate source above)

**Not accessed:** ctx7 (CLI absent, no MCP docs provider); DISCUSSION-LOG.md consulted only to confirm locked choices, not as planning input.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - every version from lockfiles read this session; no assumed versions
- Architecture: HIGH - lazy seam, CSS split mechanism, guard idiom, and Makefile gates all verified in-repo; a fresh production build validated the baseline empirically
- CSP mechanics: HIGH - verified against vendored tauri 2.10.3 / tauri-utils 2.8.3 source, the compiled debug binary, and official docs ([CITED])
- Pitfalls: MEDIUM-HIGH - dev/prod CSP divergence and cross-file selector dependencies verified; residual risk in edge selectors only discoverable during the mechanical split itself (D-02 boundary cases)

**Research date:** 2026-09-21
**Valid until:** 2026-10-21 (30 days; in-repo evidence - stable unless the build pipeline or guard family changes)

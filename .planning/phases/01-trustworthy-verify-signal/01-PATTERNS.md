# Phase 1: Trustworthy Verify Signal - Pattern Map

**Mapped:** 2026-08-22
**Files analyzed:** 12 (2 new, 10 edited)
**Analogs found:** 9 / 12 (structural analogs; this phase is config/build plumbing, not product code)

**Note on this phase's shape:** every file here is a build/config artifact or a hand-maintained data
ledger, not a controller/service/component in the usual sense. "Role" and "data flow" below are
repurposed for this domain: role = the build-graph position (make target, tsconfig node, CI step,
lint config), data flow = how it's invoked (composed-target, referenced-project, script-entrypoint,
static-data).

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|--------------------|------|-----------|-----------------|----------------|
| `Makefile` (new `lint`/`clippy`/`fmt-check` targets + `verify` prereqs) | make-target (build tooling) | composed-target | `Makefile:166-180` (`lint-i18n`, `check-select-chrome`) | exact |
| `eslint.config.js` (new) | config (lint) | static-config | none in-repo | no analog |
| `tsconfig.e2e.json` (new) | config (tsc project) | referenced-project | `tsconfig.app.json` | exact |
| `tsconfig.scripts.json` (new) | config (tsc project) | referenced-project | `tsconfig.node.json` | role-match (looser strictness, closer shape) |
| `tsconfig.json` (edit `references`) | config (tsc solution) | referenced-project | itself, extended | exact |
| `package.json` `scripts.lint` (new) | config (npm script) | script-entrypoint | `package.json` `scripts.typecheck` / `scripts["lint:i18n"]` | exact |
| `package.json` `devDependencies` (add 4, remove 1) | config (dependency manifest) | static-config | itself, extended | exact |
| `playwright.config.ts` (edit `trace`) | config (test runner) | static-config | itself, extended | exact |
| `.github/workflows/ci.yml` | CI step composition | request-response (job steps) | itself; no edit needed for GATE-04 | exact (no-op edit) |
| `rust-toolchain.toml` (new) | config (toolchain pin) | static-config | none in-repo (Node pin in `package.json engines`/`packageManager` is the nearest sibling convention, different file format) | role-match (cross-language) |
| `src-tauri/Cargo.toml` (no edit, GATE-05 does not touch the `rust-version` floor) | config (crate manifest) | static-config | itself | exact (no-op) |
| `src/lib/e2eFlow.ts` (edit `TODO_LEDGER`) | data module (hand-maintained ledger) | static-data | `src/lib/sites.ts:267` doc-comment convention | role-match |

## Pattern Assignments

### `Makefile`; new `lint`, `clippy`, `fmt-check` targets + `verify` prerequisite list

**Analog:** `Makefile:166-188` (`lint-i18n`, `check-select-chrome`, `check-type-tokens`, `test-rust`) and `Makefile:308-309` (`verify`)

**Existing target shape** (`Makefile:166-181`):
```makefile
.PHONY: lint-i18n
lint-i18n: ## i18n lint: ko/en key parity + hardcoded UI string scan
	$(NODE) scripts/lint-i18n.mjs

.PHONY: check-select-chrome
check-select-chrome: ## Static guard: select rules must not wipe the base chevron via background shorthand
	$(NODE) scripts/check-select-chrome.mjs

# The type scale is the single source of truth (PR #137). A raw px font-size in
# styles.css silently opts that rule out of any future --type-* retune, so the
# pane drifts away from the rest of the app. graph.css/diagram.css still carry
# pre-existing raw values and are not gated yet.
.PHONY: check-type-tokens
check-type-tokens: ## Static guard: styles.css font sizes must use the --type-*/--read-* scale
	@! grep -nE 'font-size: *[0-9.]+px' src/styles.css \
		|| (echo "check-type-tokens: raw px font-size above — use a --type-*/--read-* token (src/foundations.css)"; exit 1)
```

**Convention to copy exactly:**
- `.PHONY: <name>` line immediately precedes the target.
- Target line carries a trailing `## <one-line description>`; this is not decoration, `help`
  (`Makefile:40-44`) parses it with `awk` to render `make help` output. A target without `##` is
  invisible to `make help`.
- Body is a single indented recipe line (tab-indented) calling either `$(PNPM)`, `$(NODE) scripts/...`,
  or (for Rust) `cd $(TAURI_DIR) && $(CARGO) ...`; see `test-rust` below.
- No prerequisite unless the target genuinely needs one (`lint-i18n`/`check-select-chrome`/
  `check-type-tokens` have none; they're pure static scans with no build step first).

**Rust target shape to copy for `clippy`/`fmt-check`** (`Makefile:187-189`):
```makefile
.PHONY: test-rust
test-rust: $(ICON_PATH) ## Rust unit + integration tests (cargo test --lib)
	cd $(TAURI_DIR) && $(CARGO) test --lib
```
`$(ICON_PATH)` is a prerequisite here because the crate won't compile without the generated icon
asset. `clippy` needs the same prerequisite for the same reason (it also compiles the crate);
`fmt-check` does not compile anything, so it should NOT carry `$(ICON_PATH)`.

**`verify` composition** (`Makefile:308-309`):
```makefile
.PHONY: verify
verify: typecheck release-version-check icons-check lint-i18n check-select-chrome check-type-tokens test-ts test-rust build-frontend ## Full verification: typecheck + release versions + generated assets + guards + tests + frontend build
```
This is a flat space-separated prerequisite list, one line, `##` description restates what the
composed targets do in prose. New entries (`lint`, `clippy`, `fmt-check`) are inserted into this
line; CONTEXT.md D-04 anchors `lint` specifically after `typecheck`. The `##` comment must be
re-worded to mention lint/clippy/fmt-check or it goes stale (existing convention: the comment is a
plain-English gloss of the prerequisite list, not auto-generated).

`lint` also needs an `install`-style dependency: `node_modules` (see `install: node_modules
$(ICON_PATH)` at `Makefile:51-52` and `typecheck: node_modules` at `Makefile:159-160`) since it
invokes `$(PNPM) lint` which requires `eslint` to be installed.

**`package.json` script line to add** (matches `"typecheck": "tsc -b"` one-per-concern style,
`package.json:29`):
```json
"lint": "eslint src e2e"
```

---

### `tsconfig.e2e.json` (new) / `tsconfig.scripts.json` (new)

**Analog:** `tsconfig.app.json` (strict sibling) and `tsconfig.node.json` (looser sibling)

**`tsconfig.app.json` in full** (21 lines, read whole file; this is the shape `tsconfig.e2e.json`
should match at the strict end):
```json
{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "allowJs": false,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "forceConsistentCasingInFileNames": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx"
  },
  "include": ["src"]
}
```

**`tsconfig.node.json` in full** (14 lines; the shape `tsconfig.scripts.json` is closer to,
since it's the existing precedent for a narrow, single-purpose project reference):
```json
{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.node.tsbuildinfo",
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "Bundler",
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "noEmit": true
  },
  "include": ["vite.config.ts"]
}
```

**Conventions to copy exactly, from both siblings:**
- `tsBuildInfoFile` follows the pattern `./node_modules/.tmp/tsconfig.<name>.tsbuildinfo`; new files
  must add `tsBuildInfoFile: "./node_modules/.tmp/tsconfig.e2e.tsbuildinfo"` and
  `"./node_modules/.tmp/tsconfig.scripts.tsbuildinfo"` respectively. Every existing tsconfig has
  this field; a new one that omits it is inconsistent with the whole file family, not just cosmetically.
- `moduleResolution: "Bundler"`, `module: "ESNext"`, `skipLibCheck: true`, `noEmit: true` are
  invariant across every existing tsconfig; copy verbatim, don't re-derive.
- `"composite": true` is NOT present in either existing sibling (they're leaf configs referenced only
  by `tsconfig.json`'s solution file) but RESEARCH.md's Code Examples section confirms both new
  configs need it explicitly, because `tsc -b` (project-reference build mode) requires every
  referenced project to declare `composite: true` or the reference is rejected. This is the one
  field where the new files must diverge from both analogs, not an oversight.
- `include` is a single-element array naming the directory/file the project covers; `["src"]`,
  `["vite.config.ts"]`; new files follow with `["e2e"]` and `["scripts"]`.

**`tsconfig.json` solution file; the edit target** (7 lines, full file):
```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" }
  ]
}
```
D-09 adds two more `{ "path": "./tsconfig.e2e.json" }` / `{ "path": "./tsconfig.scripts.json" }`
entries to this array. `files: []` stays empty; this file is purely a reference aggregator, never
add source files to it directly.

---

### `package.json`; `devDependencies` edit (GATE-02 add 4, GATE-06 remove 1)

**Analog:** the file's own existing `devDependencies` block (`package.json:57-67`), alphabetically
sorted, `^`-range pins except where a package needs an exact pin:
```json
"devDependencies": {
  "@playwright/test": "^1.59.1",
  "@tauri-apps/cli": "^2.10.0",
  "@types/react": "^19.2.7",
  "@types/react-dom": "^19.2.3",
  "@vitejs/plugin-react": "^5.1.1",
  "graphology-types": "0.24.8",
  "jsdom": "^29.1.1",
  "typescript": "~5.9.3",
  "vite": "^7.3.1",
  "vitest": "^4.1.5"
}
```
New entries (`eslint`, `typescript-eslint`, `eslint-plugin-react-hooks`, `@types/node`) slot into
this list alphabetically, matching the `^X.Y.Z` range-pin convention already used for every other
entry (no exact-pin needed unless a peer-range conflict forces it). `@types/dompurify` is removed
from `dependencies` (`package.json:52`, not `devDependencies`; it's currently misplaced as a
runtime dep even though it's a type-only stub), matching GATE-06.

---

### `playwright.config.ts`; `trace` setting

**Analog:** itself; this is a single-field edit, not a new-pattern file. Full file already read
(27 lines). Only line 13 changes:
```diff
   use: {
     baseURL: `http://127.0.0.1:${port}`,
-    trace: "on-first-retry",
+    trace: "retain-on-failure",
   },
```
No other field in the file changes. Do not touch `webServer.reuseExistingServer` or add a `retries`
key; both are explicitly out of scope per D-12/D-13.

---

### `src/lib/e2eFlow.ts`; `TODO_LEDGER` edit (GATE-07)

**Analog for the module-comment convention:** `src/lib/sites.ts:267`; a single-line JSDoc-style
comment directly above an exported declaration, stating the declaration's authoritative role in
one sentence:
```typescript
/** Single source of truth for "should the native webview be visible". */
export function shouldShowSiteView(args: {
  hasActiveSite: boolean;
  overlayOpen: boolean;
  localDialogOpen: boolean;
}): boolean {
```
This is the closest in-repo precedent for "declare that a structure is the authoritative/hand-
maintained source, not derived"; the repo's convention for this is a single terse `/** ... */`
line immediately above the declaration, not a multi-paragraph block comment. `TODO_LEDGER` should
get the same treatment: one `/** ... */` line above `const TODO_LEDGER: E2EFlowTodo[] = [` stating
it is hand-maintained (edited by hand as flow gaps are found/closed, not generated from README/
REQUIREMENTS.md diffing).

**Entries to edit** (`src/lib/e2eFlow.ts:139-176`, already read in full):
```typescript
const TODO_LEDGER: E2EFlowTodo[] = [
  { id: "readme-slide-export-conflict", ... status: "todo" },
  { id: "monorepo-extraction-deferred", ... status: "todo" },
  {
    id: "native-tauri-e2e-runner-missing",
    content:
      "Native Tauri E2E remains broader than the browser smoke harness; Rust storage tests and browser flow tests cover this implementation.",
    status: "todo",
  },
  { id: "hub-connector-deferred-local-first", ... status: "todo" },
  {
    id: "skill-name-drift",
    content:
      "README names inbox-processor, lint, and hwpx-fill while current bundled skills are inbox-process, vault-lint, and hwpx.",
    status: "todo",
  },
  { id: "stage-baseline-gaps", ... status: "todo" },
];
```
GATE-07 (per CONTEXT.md canonical_refs) drops the `skill-name-drift` entry entirely (its premise -
stale skill names in README; is resolved; RESEARCH.md's Sources section confirms this was verified
by grepping README.md this session) and keeps `native-tauri-e2e-runner-missing` open (PROJECT.md
scopes the native runner as out of v1). Each object in the array follows the `{ id, content,
status }` shape defined by the `E2EFlowTodo` interface (`src/lib/e2eFlow.ts:47-51`); a new/edited
entry must keep this exact shape, `status` is the literal union `"todo" | "done"`.

---

## Shared Patterns

### Makefile target registration (applies to `lint`, `clippy`, `fmt-check`)
**Source:** `Makefile:166-189`
**Apply to:** all three new Makefile targets
- `.PHONY: <name>` directly above the target.
- `<name>: [prereqs] ## <description parsed by make help>`.
- Single tab-indented recipe line per concern; compose via prerequisites, not shell `&&` chains,
  when the composed piece is itself a reusable target (e.g. `test-rust` already establishes the
  `cd $(TAURI_DIR) && $(CARGO) ...` idiom for anything needing to run cargo from repo root).

### tsconfig project-reference shape (applies to `tsconfig.e2e.json`, `tsconfig.scripts.json`)
**Source:** `tsconfig.app.json`, `tsconfig.node.json`, `tsconfig.json`
**Apply to:** both new tsconfig files and the `tsconfig.json` edit
- Every leaf config gets its own `tsBuildInfoFile` under `./node_modules/.tmp/`.
- `moduleResolution: "Bundler"`, `module: "ESNext"`, `noEmit: true`, `skipLibCheck: true` are
  non-negotiable repo-wide invariants; copy, don't reconsider.
- New leaf configs need `composite: true` (absent from existing leaves, required by `tsc -b` for
  configs newly added to the `references` array; see RESEARCH.md Code Examples for the confirmed
  working shape).
- Solution file (`tsconfig.json`) only ever grows its `references` array; `files` stays `[]`.

### `package.json` `scripts` naming
**Source:** `package.json:16-30`
**Apply to:** the new `"lint"` script
- One-word-per-concern verb keys (`typecheck`, `preview`, `dev`) or `namespace:verb` for grouped
  concerns (`icons:generate`, `icons:check`, `check:select-chrome`, `lint:i18n`). `"lint"` fits the
  bare one-word-per-concern group alongside `typecheck`, matching D-04's Makefile target name.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `eslint.config.js` | config (lint) | static-config | No ESLint configuration exists anywhere in this repo today (confirmed: no `.eslintrc*`, no `eslint.config.*`, no `eslint` reference in `package.json` or `pnpm-lock.yaml`). This is a genuinely greenfield file; use RESEARCH.md's "Pattern 1" flat-config example (Standard Stack + Code Examples sections) as the shape, not an in-repo analog. |
| `rust-toolchain.toml` | config (toolchain pin) | static-config | No file of this name/format exists at repo root or in `src-tauri/`. `src-tauri/Cargo.toml:8`'s `rust-version = "1.77.2"` is a *floor* declaration, not a pin, and D-11 explicitly treats it as unrelated (the new file pins current CI stable, not that floor). The nearest sibling convention is the Node toolchain pin (`package.json` `engines.node`/`packageManager`), but that's a different ecosystem's manifest field, not a transferable file format; use RESEARCH.md's "Pattern 2" TOML example as the shape. |
| `src-tauri/` crate-level clippy/lint config | (n/a; GATE-01 needs none) | (n/a) | Searched `src-tauri/src/lib.rs` and `src-tauri/src/main.rs` for `#![allow(...)]`, `#![deny(...)]`, `#![warn(...)]`, or any `clippy::` crate-level attribute; none exist. GATE-01's clippy work has a clean slate to be consistent with: D-08 already forbids adding `allow` escapes, so this absence is confirmation, not a gap to fill. |

## Metadata

**Analog search scope:** repo root (`Makefile`, `tsconfig*.json`, `package.json`,
`playwright.config.ts`, `.github/workflows/ci.yml`), `src/lib/` (for the module-comment
convention), `src-tauri/` (`Cargo.toml`, `src/lib.rs`, `src/main.rs` for lint-attribute precedent).
**Files scanned:** ~12 read directly, plus targeted greps across `src/lib/*.ts` and `Makefile`.
**Pattern extraction date:** 2026-08-22

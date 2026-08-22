# Phase 1: Trustworthy Verify Signal - Research

**Researched:** 2026-08-22
**Domain:** Static-analysis gate infrastructure (ESLint 9/10 flat config, `tsc -b` project references, Rust clippy/fmt, Playwright tracing, toolchain pinning) for a React 19 + Tauri 2 + Vite 7 desktop app with zero prior linter setup.
**Confidence:** HIGH - every quantitative claim below was measured this session by actually running the tool against this repo, not estimated from the roadmap or training data.

## Summary

This phase adds seven independent gates to `make verify`. None of them are conceptually hard - the risk in this phase is entirely in the *size of the pre-existing violation backlog* each gate exposes, because CONTEXT.md already locked the rule set, the scope, and the rollout strategy (D-01 through D-13). This research therefore spent most of its budget **measuring real backlog counts** rather than debating alternatives, per the explicit "Measure, do not guess" instruction.

Headline numbers, all measured this session: **0** rustfmt violations, **75** clippy violations (`cargo clippy -- -D warnings`, lib scope) or **90** with `--all-targets`, **74** ESLint errors across `src/` under the exact D-02 four-rule set (with a recommended `argsIgnorePattern`/`varsIgnorePattern` tweak - see Pitfall 1), **22** of those in `App.tsx` (not 49 - see Pitfall 2, a correction to CONTEXT.md's stated backlog size), **6** pre-existing type errors in `e2e/` once a correct tsconfig is used, and **44** pre-existing type errors across 9 files in `scripts/` once `checkJs` is turned on. `@types/node` is not installed anywhere in the dependency tree today and is required for both new tsconfigs to resolve at all (Node builtins are used in 18 of 24 `scripts/*.mjs` files and in 3 `e2e/*.spec.ts` files).

**Primary recommendation:** Implement all seven gates exactly as CONTEXT.md decided (no re-litigation needed - the decisions hold up under measurement), but budget real fix time for the `scripts/` typecheck backlog (44 errors, mostly JSDoc type mismatches, not missing annotations) and correct the plan's assumption about the `App.tsx` `exhaustive-deps` backlog size from 49 down to the measured number of real violations (10 `exhaustive-deps` + 12 `no-unused-vars` = 22 total, see Pitfall 2).

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| JS/TS lint gate (GATE-02) | Build/CI tooling | - | Runs at `pnpm lint` / `make lint`, no runtime component |
| Rust lint gate (GATE-01) | Build/CI tooling | - | `cargo clippy`/`cargo fmt`, compile-time only |
| Typecheck coverage (GATE-03) | Build/CI tooling | - | `tsc -b` project references, no runtime component |
| E2E trace capture (GATE-04) | CI / Test infrastructure | - | Playwright config change, artifact upload already exists in `.github/workflows/ci.yml` |
| Toolchain pin (GATE-05) | Build/CI tooling | - | `rust-toolchain.toml` at repo root, consumed by `rustup`/`cargo`/CI action |
| Deprecated types removal (GATE-06) | Frontend (dependency graph) | Build tooling | `package.json` dependency edit + `pnpm typecheck` verification |
| E2E flow ledger truthfulness (GATE-07) | Frontend (`src/lib/e2eFlow.ts`) | - | Single TS module, no other tier touches it |

This phase has no browser/API/database tier work - every gate lives in the build-and-verify layer. There is no risk of tier misassignment here; the map is included for completeness per the research protocol.

## Standard Stack

### Core

| Library | Version (measured) | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `eslint` | `9.39.5` **or** `10.9.0` - see Pitfall 5 | Flat-config lint runner | Only linter with a mature `react-hooks/exhaustive-deps` implementation [VERIFIED: npm view this session] |
| `@eslint/js` | `10.0.1` | `js.configs.recommended` building block (used only if the planner opts into base JS recommended rules; D-02 does not require it) | Official ESLint JS rule bundle [VERIFIED: npm view] |
| `typescript-eslint` | `8.67.0` (meta package: parser + plugin + configs in one) | TS parser + `@typescript-eslint/no-unused-vars` + `@typescript-eslint/no-floating-promises` | The only maintained TS-aware ESLint integration; supports ESLint `^9.0.0 \|\| ^10.0.0` and TypeScript `>=4.8.4 <6.1.0` (repo has TS `~5.9.3`, compatible) [VERIFIED: npm view typescript-eslint peerDependencies] |
| `eslint-plugin-react-hooks` | `7.1.1` | `rules-of-hooks` + `exhaustive-deps` | v7 dropped legacy config support and ships flat-config-native; peer range `^9 \|\| ^10` [VERIFIED: npm view eslint-plugin-react-hooks peerDependencies] |
| `@types/node` | `22.19.21`+ (Node 22 line, matches `engines.node >=22` and CI's `node-version: 22.22.3`) | Type declarations for `fs`/`path`/`process`/`child_process`/etc. used in `scripts/*.mjs` and `e2e/*.spec.ts` | **Required, not optional** - see Don't-Hand-Roll and Pitfall 3 below; without it `tsc -b` cannot resolve `types: ["node"]` and every Node-builtin call site errors [VERIFIED: this session, confirmed no `@types/node` anywhere in `node_modules` and 18/24 `scripts/*.mjs` files import Node builtins] |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `globals` | `17.11.0` | Predefined global-variable sets (`globals.node`, `globals.browser`) for flat config `languageOptions.globals` | Only if the planner wants explicit global declarations instead of relying on `@types/node`/DOM lib; not strictly required since `parserOptions.project` type-awareness already covers most of this |
| `eslint-plugin-react-refresh` | `0.5.4` | Warns on non-component exports that break Vite HMR fast refresh | **Not requested by D-02** (correctness-only scope) - list here only because it is the common Vite+React companion; do not add it unless the user asks, per D-02's explicit "no style rules" boundary |

### Alternatives Considered

| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| ESLint 9/10 | Biome, oxlint | Both rejected in D-01 - neither implements `react-hooks/exhaustive-deps` to the same fidelity, and the repo's 18 existing `eslint-disable` comments are already ESLint-syntax |
| `typescript-eslint` meta package | `@typescript-eslint/parser` + `@typescript-eslint/eslint-plugin` separately | Meta package is the officially recommended install path since v8; fewer version-drift bugs between parser and plugin |
| Two `tsconfig.*.json` (D-09) | One combined tsconfig covering `src`+`e2e`+`scripts` | Rejected by D-09 - `.mjs` needs `allowJs`/`checkJs`/`strict:false`, which would leak into the `.ts` spec files if merged |

**Installation:**
```bash
pnpm add -D eslint typescript-eslint eslint-plugin-react-hooks @types/node
```
Exact pins to use (locking D-01's literal "ESLint 9" reading - see Pitfall 5 for the version-line discrepancy this surfaces):
```bash
pnpm add -D eslint@9.39.5 typescript-eslint@8.67.0 eslint-plugin-react-hooks@7.1.1 @types/node@22
```

**Version verification:** All four versions above were confirmed via `npm view <pkg> version` this session (2026-08-22). `eslint@9.39.5` carries an npm deprecation notice ("This version is no longer supported. Please see https://eslint.org/version-support") because the 9.x line is EOL now that 10.x is current stable - see Pitfall 5 for the decision this surfaces for the planner/user.

## Package Legitimacy Audit

| Package | Registry | Published | Weekly Downloads | Source Repo | Verdict | Disposition |
|---------|----------|-----------|-------------------|-------------|---------|-------------|
| `eslint` | npm | 2026-08-21 | 133,515,414 | github.com/eslint/eslint | SUS (`too-new` heuristic only) | Approved - heuristic false positive; this is the official ESLint package with a 133M/week download count |
| `@eslint/js` | npm | 2026-02-06 | 119,613,808 | github.com/eslint/eslint | OK | Approved |
| `typescript-eslint` | npm | 2026-08-10 | 74,851,244 | github.com/typescript-eslint/typescript-eslint | SUS (`too-new` heuristic only) | Approved - same false-positive pattern, official monorepo package |
| `eslint-plugin-react-hooks` | npm | 2026-04-17 | 83,059,186 | github.com/facebook/react | OK | Approved |
| `@types/node` | npm | 2026-08-07 | 349,691,671 | github.com/DefinitelyTyped/DefinitelyTyped | SUS (`too-new` heuristic only) | Approved - official DefinitelyTyped package, largest download count of any package checked |

**Packages removed due to `[SLOP]` verdict:** none.
**Packages flagged as suspicious `[SUS]`:** `eslint`, `typescript-eslint`, `@types/node` - all three are flagged only by the legitimacy checker's "too-new" heuristic (their latest patch/minor was published within the checker's freshness window), which is a known false-positive class for high-velocity, high-download official packages. Weekly download counts (74M-350M) and matching GitHub org/repo ownership rule out slopsquatting. No `checkpoint:human-verify` is warranted for these three specifically, but the planner should still gate the actual `pnpm add` step behind normal PR review since it is this phase's one new-dependency exception per CONTEXT.md.

*All five package names above were discovered from this repo's own `package.json`/CONCERNS.md context and cross-checked against the npm registry directly in this session (`npm view <pkg> peerDependencies`/`version`), not sourced from training-data guesses - tag as `[VERIFIED: npm registry, this session]`.*

## Architecture Patterns

### System Architecture Diagram

```
                     make verify
                          |
        +---------+---------+--------+---------+---------+---------+---------+---------+
        |         |         |        |         |         |         |         |         |
   typecheck   lint(NEW)  release  icons-   lint-i18n  check-   check-   test-ts  test-rust  build-
   (tsc -b)   (eslint)   -version  check              select-  type-              (cargo    frontend
                          -check              (existing) chrome   tokens            test --lib)
        |         |                                                                    |
        |         |                                                                    |
  tsconfig.json  eslint.config.js                                              cargo clippy (NEW,
  references:     scoped to                                                    appended before
  app/node/       src/**+e2e/**                                                test-rust or as its
  e2e(NEW)/                                                                    own target) +
  scripts(NEW)                                                                 cargo fmt --check (NEW)
                                                                                     |
                                                                              rust-toolchain.toml (NEW)
                                                                              read by rustup before
                                                                              cargo invokes rustc

                     make test-e2e (separate target, also run by CI)
                          |
                   playwright.config.ts
                   trace: "retain-on-failure" (CHANGED from "on-first-retry")
                          |
                on failure -> test-results/<test-name>/trace.zip
                          |
              already uploaded by .github/workflows/ci.yml's
              "Upload e2e artifacts on failure" step (path: test-results/, playwright-report/)
```

A reader tracing GATE-01 through GATE-05: `make verify` fans out to independent sub-targets; the two genuinely new fan-out branches are `lint` (GATE-02, feeding off a new `eslint.config.js`) and the Rust half appended to (or alongside) `test-rust` (GATE-01, gated by a new `rust-toolchain.toml` that `rustup` reads before `cargo` even starts). GATE-03 is a graph edge, not a new node - it widens `tsconfig.json`'s existing `references` array. GATE-04 is outside `make verify` entirely (it lives in `make test-e2e`, a sibling target CI already runs) and only changes what artifact `test-results/` contains on failure - the upload step is unchanged.

### Recommended Project Structure

No new directories. Two new files at repo root (`eslint.config.js` next to `vite.config.ts`; `rust-toolchain.toml` next to `Cargo.toml` at repo root - **not** `src-tauri/Cargo.toml`, since `rustup`/`cargo` resolve `rust-toolchain.toml` by walking up from the invocation directory, and `Makefile`'s `test-rust`/future `clippy` targets `cd $(TAURI_DIR)` first). Two new tsconfig files (`tsconfig.e2e.json`, `tsconfig.scripts.json`) beside the existing `tsconfig.app.json`/`tsconfig.node.json`.

```
maru/
├── rust-toolchain.toml       # NEW (GATE-05) - repo root, not src-tauri/
├── eslint.config.js          # NEW (GATE-02) - flat config, ESM
├── tsconfig.json             # EDIT (GATE-03) - add 2 references
├── tsconfig.e2e.json         # NEW (GATE-03) - strict, DOM+DOM.Iterable+node types
├── tsconfig.scripts.json     # NEW (GATE-03) - allowJs+checkJs, strict:false
├── Makefile                  # EDIT (GATE-01, GATE-02) - new lint/clippy/fmt-check targets
├── package.json              # EDIT (GATE-02, GATE-06) - new "lint" script, drop @types/dompurify
├── playwright.config.ts      # EDIT (GATE-04) - trace: "retain-on-failure"
└── src-tauri/
    └── Cargo.toml             # unchanged - rust-version floor stays as-is per D-11
```

### Pattern 1: Flat config with `parserOptions.project` scoped per-directory (GATE-02 + no-floating-promises)

**What:** `typescript-eslint`'s `tseslint.config()` helper accepts an array of config objects; each object's `files` glob determines which files get which `languageOptions.parserOptions.project`. Point `src/**/*.{ts,tsx}` at `tsconfig.app.json` and `e2e/**/*.ts` at the new `tsconfig.e2e.json`.

**When to use:** Whenever type-aware rules (here, only `no-floating-promises`) need to run over a subset of files that don't all share one tsconfig - which is this repo's exact situation (D-09 already splits `e2e`/`scripts` from `src`).

**Example** (measured working config from this session - this exact shape produced the 74-error/8-warning result reported above):
```js
// eslint.config.js - verified against this repo this session
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "./tsconfig.app.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
  {
    files: ["e2e/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "./tsconfig.e2e.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-floating-promises": "error",
    },
  },
);
```
Note this deliberately does **not** extend `tseslint.configs.recommended` or `recommendedTypeChecked` (D-02's explicit exclusion) - only the four named rules are enabled, applied manually with the `@typescript-eslint` plugin registered directly. This keeps the type-aware compile cost limited to `no-floating-promises` alone rather than pulling in the ~40-rule `recommended-type-checked` bundle.

### Pattern 2: `rust-toolchain.toml` - minimal channel pin, no `path`/`profile` needed

**What:** A `[toolchain]` TOML table at repo root with a `channel` field. `rustup` auto-detects and installs/uses this exact toolchain for any `cargo`/`rustc` invocation under this directory tree, overriding both the user's `rustup default` and any `dtolnay/rust-toolchain@stable` CI step (the CI action becomes a fallback installer only - the file wins) [CITED: rust-lang.github.io/rustup/overrides.html].

**When to use:** GATE-05, exactly as D-11 specifies - pin to "the version CI builds with today," not the `rust-version = "1.77.2"` floor in `src-tauri/Cargo.toml:8`.

**Example:**
```toml
# rust-toolchain.toml - repo root
[toolchain]
channel = "1.98.0"
components = ["clippy", "rustfmt"]
```
`components` is listed under CONTEXT.md's "Claude's Discretion" - recommend including it, since it makes `cargo clippy`/`cargo fmt` work out of the box on a fresh clone (`rustup` auto-installs missing components for a pinned toolchain) without a separate CI/setup step.

### Anti-Patterns to Avoid

- **Extending `tseslint.configs.recommendedTypeChecked` "just to get `no-floating-promises`":** pulls in ~40 rules the roadmap explicitly rejected (D-02). Register the plugin and the single rule manually instead (Pattern 1).
- **Putting `rust-toolchain.toml` inside `src-tauri/`:** works for `cd src-tauri && cargo ...` invocations but silently does *not* apply if any tooling ever runs `cargo` from repo root (e.g. a future root-level Cargo workspace command). Repo-root placement is unambiguous and matches where `Cargo.toml`'s sibling `package.json` already lives.
- **Adding `retries: 1` alongside `trace: "retain-on-failure"`:** D-12 explicitly forbids this - it would silently let a flaky test pass and cost the "193/193 first-attempt" signal the suite currently earns.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Detecting unused TS symbols | A custom AST-walking unused-var scanner | `@typescript-eslint/no-unused-vars` | Already handles TS-specific cases (type-only imports, overloads, ambient declarations) that a hand-rolled scanner would miss |
| Detecting missing/incorrect `useEffect`/`useCallback` deps | A custom hook-usage linter | `eslint-plugin-react-hooks`'s `exhaustive-deps` | This is exactly the rule GATE-02 exists to get - it is the canonical implementation maintained by the React team itself |
| Typing 17 loosely-JSDoc'd build scripts | Hand-writing `.d.ts` ambient declarations for `fs`/`path`/`process` | `@types/node` | See Pitfall 3 - this is a one-line `pnpm add -D` that resolves ~all the "Cannot find name" class of errors; do not hand-write Node global types |
| Detecting Node-vs-browser global scope mismatches in `scripts/*.mjs` (the `window` errors in `perf-startup-profile.mjs`, Pitfall 4) | Wrapping every `page.evaluate`/`page.waitForFunction` callback body in a string to dodge typechecking | Add `"DOM"` to the `scripts` tsconfig's `lib` array (verified this session - resolves both `window`-not-found errors without side effects on the rest of the file) | Stringifying callbacks loses IDE support and defeats the purpose of GATE-03 for that file |

**Key insight:** every one of this phase's seven gates is "wire up an existing, well-maintained tool correctly" - there is no case in this phase where hand-rolling is even tempting once the tsconfig/eslint-config shape is right. The actual work is fixing what the tools find, not building the tools.

## Common Pitfalls

### Pitfall 1: Bare `no-unused-vars` (or `@typescript-eslint/no-unused-vars` with no options) flags the codebase's own "intentionally unused" convention

**What goes wrong:** The codebase already uses a `_foo` leading-underscore convention to mark deliberately-unused destructured params/vars (seen in `_kind`, `_cmd`, `_args`, `_deleted`, `_expectedRevision`, `_interrupted`, `_context`, `_warnings`, `_ctx`, and 12 more across `src/`). `@typescript-eslint/no-unused-vars` does **not** honor this convention by default - it flagged 58 violations without the option, 37 with it.

**Why it happens:** The rule's `argsIgnorePattern`/`varsIgnorePattern`/`caughtErrorsIgnorePattern` options default to unset (nothing is ignored) unless configured.

**How to avoid:** Set `{ argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }` on the rule (shown in Pattern 1 above). This is not a scope expansion beyond D-02 - it makes the mechanical rule match an existing repo convention rather than fighting it, and it cuts the real fix-list from 58 to 37 without touching any code.

**Warning signs:** If the planner's task list for GATE-02 assumes ~58 `no-unused-vars` fixes in `src/`, it is using the un-tuned count; the correct number with the ignore pattern applied is 37 [VERIFIED: eslint run this session, config in Pattern 1].

### Pitfall 2: CONTEXT.md's "49 existing violations in `src/App.tsx`" is a useEffect-count, not a measured violation count - real number is 22

**What goes wrong:** D-06 and the `<code_context>` section both cite "49" as the size of the `App.tsx` exhaustive-deps backlog D-06's per-site disable comments must cover. Running the actual D-02 rule set against `App.tsx` this session found **22 total errors** (10 `react-hooks/exhaustive-deps` + 12 `@typescript-eslint/no-unused-vars`), not 49.

**Why it happens:** 49 is the count of `useEffect` calls in `App.tsx` (confirmed: `grep -c useEffect src/App.tsx` = 50, close to 49 - likely one is a comment/string match difference), not the count of hook-dependency *violations*. Most `useEffect`/`useCallback` calls in the file already have correct dependency arrays; only a subset trigger the rule. One of the three existing `eslint-disable-next-line react-hooks/exhaustive-deps` comments already in `App.tsx` (line 6974) is now a **stale/unused directive** - its underlying violation no longer exists.

**How to avoid:** The planner should size D-06's App.tsx work at ~22 real fixes (10 exhaustive-deps disable-comments-with-reason + 12 no-unused-vars removals/renames), not 49, and should also remove the one now-stale disable comment at `App.tsx:6974` while adding the new ones. D-06's *strategy* (staged per-rule rollout, disable-with-reason as a burn-down worklist) is unaffected - this is purely a size correction, not a decision reversal.

**Warning signs:** Any task estimate or checklist in the plan that says "49" for App.tsx should be re-derived from a real `pnpm exec eslint --config eslint.config.js src/App.tsx` run at implementation time, since exact line/violation counts will shift slightly once the actual `eslint.config.js` lands (this session's number came from a config matching D-02 exactly, run against the current `main` tree).

### Pitfall 3: `tsc -b` cannot resolve `types: ["node"]` - `@types/node` is absent from the entire dependency tree

**What goes wrong:** Both new tsconfigs (`tsconfig.e2e.json`, `tsconfig.scripts.json`) need Node's global types (`process`, `fs`, `path`, Node-flavored `URL`, etc. - 18 of 24 `scripts/*.mjs` files and 3 `e2e/*.spec.ts` files reference these). `@types/node` is not installed, not hoisted transitively, and not referenced anywhere in `package.json`.

**Why it happens:** This is a frontend-only Vite/Tauri project; nothing in the existing dependency graph pulls in `@types/node` as a transitive peer.

**How to avoid:** Add `@types/node@22` (matching `engines.node >= 22` / CI's pinned `22.22.3`) as a new devDependency. This is the specific instance CONTEXT.md's "the TypeScript half is the one place a new dependency may be justified" clause covers - scope it to exactly this one package, not a broader dependency add.

**Warning signs:** `tsc -p tsconfig.scripts.json` failing with `TS2688: Cannot find type definition file for 'node'` before any real code error is reached - that error means `@types/node` isn't resolvable, not that the config is wrong.

### Pitfall 4: `scripts/perf-startup-profile.mjs` uses `window` inside Playwright `page.evaluate`/`page.waitForFunction` callbacks - a Node+DOM lib mismatch, not a real bug

**What goes wrong:** `checkJs` with `lib: ["ES2022"]` (no `"DOM"`) flags `window` as undefined at two call sites (lines 52, 58) inside callbacks that actually execute inside the browser page, injected by Playwright - the surrounding file is a Node script, but these specific callback bodies are browser code.

**Why it happens:** TypeScript's `checkJs` doesn't infer execution context from `page.evaluate()`'s signature; it typechecks the callback body against whatever `lib` the file's tsconfig declares.

**How to avoid:** Add `"DOM"` to `tsconfig.scripts.json`'s `lib` array alongside `"ES2022"`. Verified this session - resolves both `window`-not-found errors with no observed regressions elsewhere in the 9 affected files (the DOM lib addition does not introduce new errors in the other 8 files, which don't reference DOM globals).

**Warning signs:** `TS2304: Cannot find name 'window'` inside a `.mjs` file that is otherwise clearly server/CLI code - check whether the reference is inside a Playwright `page.evaluate`/`waitForFunction`/`waitForSelector` callback before assuming it's a real bug.

### Pitfall 5: "ESLint 9" (D-01) is already the previous major line - current npm `latest` is ESLint 10, and 9.x is EOL

**What goes wrong:** `npm view eslint version` (unscoped, `latest` dist-tag) resolves to `10.9.0`. Installing `eslint@9.39.5` (the newest 9.x) triggers an npm deprecation warning: *"eslint@9.39.5: This version is no longer supported."*

**Why it happens:** D-01 was written when flat config (introduced as default in ESLint 9) was the salient distinction from the legacy `.eslintrc` era; the "9" in "ESLint 9 flat config" is shorthand for "the flat-config generation," not necessarily a literal major-version pin. Time has since moved the ecosystem to major 10, which is also flat-config-only and is what all three plugin peer-dependency ranges in this research (`typescript-eslint`, `eslint-plugin-react-hooks`, `eslint-plugin-react-refresh`) explicitly support (`^9 || ^10`).

**How to avoid:** This is flagged, not resolved, per the "don't re-open locked decisions" instruction - but the planner/user should decide explicitly between (a) literal compliance: pin `eslint@9.39.5`, accepting the EOL warning, or (b) intent compliance: install `eslint@10.9.0`, which satisfies "flat config" and has a longer support runway, with zero known compatibility cost given the peer ranges above. This research recommends (b) but defers the final call, since D-01's wording is the locked artifact.

**Warning signs:** A `pnpm install` in CI failing an audit/deprecation-as-error check, or `pnpm add -D eslint@9` silently landing an EOL major without anyone noticing the warning in scrollback.

### Pitfall 6: Local clippy/rustfmt counts were measured on `rustc 1.96.0`, not the `1.98.0` that is actually "today's stable"

**What goes wrong:** This sandbox's `rustup` default toolchain is `1.96.0` (released 2026-05-25). The real current stable - what `dtolnay/rust-toolchain@stable` and D-11's "the version CI builds with today" both resolve to - is **Rust 1.98.0**, released 2026-08-20, two days before this research [CITED: blog.rust-lang.org/2026/08/20/Rust-1.98.0]. Two stable releases (1.97, 1.98) shipped between the two, each of which can add new clippy lints.

**Why it happens:** Local dev-machine toolchains lag behind CI's always-latest `@stable` action unless someone runs `rustup update` regularly.

**How to avoid:** Treat this session's clippy counts (75 lib-scope / 90 all-targets, both with `-D warnings`, 0 rustfmt diffs) as a **lower bound / rough estimate**, not the authoritative number. Before finalizing GATE-01's fix list, re-run `cargo clippy --offline -- -D warnings` (and `--all-targets` if tests are in scope) on `rustc 1.98.0` - either by `rustup update stable` locally or by letting the first CI run against the new `rust-toolchain.toml` surface the authoritative count. rustfmt's 0-violation result is more durable (formatting rules change far less often between releases than lint additions).

**Warning signs:** A CI run after landing `-D warnings` failing with a *different* violation count than what local dev machines report - check `rustc --version` on both sides before assuming the gate itself is broken.

## Code Examples

### Makefile additions (GATE-01, GATE-02 - mirrors the existing `lint-i18n`/`check-select-chrome` pattern at `Makefile:167-180`)

```makefile
.PHONY: lint
lint: node_modules ## ESLint: src/ + e2e/ correctness rules
	$(PNPM) lint

.PHONY: clippy
clippy: $(ICON_PATH) ## Rust lint: clippy with -D warnings, no allow escapes
	cd $(TAURI_DIR) && $(CARGO) clippy -- -D warnings

.PHONY: fmt-check
fmt-check: ## Rust format check (no changes written)
	cd $(TAURI_DIR) && $(CARGO) fmt --check
```
And extend the existing `verify` line (`Makefile:309`):
```makefile
verify: typecheck lint clippy fmt-check release-version-check icons-check lint-i18n check-select-chrome check-type-tokens test-ts test-rust build-frontend
```
(`$(ICON_PATH)` prerequisite copied from the existing `test-rust` target at `Makefile:188` since clippy also needs the generated icon to compile; confirm this dependency still holds when writing the actual target - `test-rust` already establishes the precedent this session relied on for wiring.)

### `package.json` script addition (GATE-02)
```json
"lint": "eslint src e2e"
```
Matches the existing `"typecheck": "tsc -b"` one-liner-per-concern pattern already in `package.json:scripts`.

### `tsconfig.json` reference addition (GATE-03)
```json
{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" },
    { "path": "./tsconfig.e2e.json" },
    { "path": "./tsconfig.scripts.json" }
  ]
}
```

### `tsconfig.e2e.json` (GATE-03 - verified this session, produces exactly 6 real pre-existing errors)
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "composite": true,
    "types": ["node"]
  },
  "include": ["e2e"]
}
```
`DOM.Iterable` is required - omitting it produced a spurious 7th error (`NodeListOf<Element>` iteration) at `e2e/dashboard.spec.ts:391` in this session's first probe run; adding it removed that error with no other change.

### `tsconfig.scripts.json` (GATE-03 - verified this session, produces exactly 44 real pre-existing errors across 9 files)
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowJs": true,
    "checkJs": true,
    "strict": false,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "composite": true,
    "types": ["node"]
  },
  "include": ["scripts"]
}
```
`"DOM"` here is not for e2e-parity - it's specifically to resolve the `window` references inside `scripts/perf-startup-profile.mjs`'s Playwright callbacks (Pitfall 4). `composite: true` is required on both new tsconfigs because `tsc -b` (project references / build mode) requires every referenced project to be composite - omit it and `tsc -b` will refuse to add the reference.

### `playwright.config.ts` change (GATE-04)
```diff
   use: {
     baseURL: `http://127.0.0.1:${port}`,
-    trace: "on-first-retry",
+    trace: "retain-on-failure",
   },
```
No other change to this file. D-12 is explicit: do not add `retries`.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| `.eslintrc.*` (cascading, eslintrc format) | Flat config (`eslint.config.js`, single exported array) | Default since ESLint 9 (April 2026 was the 9.x support window; now EOL - see Pitfall 5) | This repo has zero prior ESLint config, so there is no migration - greenfield flat config is the only path, which simplifies this phase considerably versus a repo migrating an existing eslintrc |
| `eslint-plugin-react-hooks` pre-v6 (eslintrc-only) | v7.1.1 (flat-config-native, peer range `^9 \|\| ^10`) | v6 added flat config support; v7 is current | No compat shim (e.g. `@eslint/eslintrc`'s `FlatCompat`) needed for this plugin - confirmed via its own `peerDependencies` field |

**Deprecated/outdated:**
- ESLint 9.x line: deprecated per npm's own install-time warning as of this session; 10.x is current. See Pitfall 5.
- `@types/dompurify`: deprecated per its own `package.json` `"deprecated"` field (already documented in `.planning/codebase/CONCERNS.md`); `dompurify@3.4.1` ships `dist/purify.cjs.d.ts` and `dist/purify.es.d.mts` directly [VERIFIED: `node_modules/dompurify/package.json` `"types"`/`"exports"` fields, read this session]. All 4 `import DOMPurify from "dompurify"` call sites (`src/components/binaryViewers/HwpxViewer.tsx`, `src/lib/markdown.ts`, `src/lib/scratchpad.ts`, `src/lib/diagram/richText.ts`) will resolve types from the package itself once the stub is removed.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | ESLint 9.x vs 10.x - this research recommends 10.9.0 over the literal "ESLint 9" reading of D-01, but defers to the user/planner (Pitfall 5) | Standard Stack, Pitfall 5 | If the plan silently picks 9.x without flagging the EOL warning, a future `pnpm audit`/deprecation-gate could fail unexpectedly; low risk either way since both satisfy the underlying flat-config intent |
| A2 | `rust-toolchain.toml` `channel = "1.98.0"` as the literal pin value | Pattern 2, Pitfall 6 | This is the correct value as of 2026-08-22 [CITED: rust blog], but D-11 says "the version CI builds with today" - the planner should let the first CI run under the new pin confirm this rather than trust a value that could be stale by execution time |
| A3 | `components = ["clippy", "rustfmt"]` should be added to `rust-toolchain.toml` | Pattern 2 | Explicitly named as Claude's Discretion in CONTEXT.md - low risk, this is a convenience addition with no version-pinning implication |

## Open Questions (RESOLVED)

> Both questions below were answered after this research was written. Resolutions
> are recorded inline; the original text is kept for provenance.

1. **Exact clippy fix list for the 75 (lib) / 90 (all-targets) violations** — **RESOLVED**: plan 01-02 Task 1 re-measures on the pinned toolchain before fixing, so the static number is never trusted at execution time.
   - What we know: Full violation text is captured in this session's `/tmp/clippy.log` (all-targets) and `/tmp/clippy-default.log` (lib-only) - not preserved past this session, but the categories seen include `manual_inspect`, `unnecessary_to_owned`, `field_reassign_with_default`, `bool_assert_comparison`, `useless_vec`, and more. Re-running `cargo clippy --offline -- -D warnings` in `src-tauri/` reproduces the full list.
   - What's unclear: Whether all 75/90 are one-line auto-fixable (`cargo clippy --fix`) or require manual judgment (e.g. the `field_reassign_with_default` one touches test setup code where the "fix" changes struct-literal shape).
   - Recommendation: The planner should budget a `cargo clippy --fix --allow-dirty -- -D warnings` pass first (handles most mechanical lints automatically), then manually address whatever remains - likely a small remainder given clippy's fix coverage is high for the lint categories observed here. Should re-measure on `rustc 1.98.0` first per Pitfall 6.

2. **Whether `--all-targets` (90 violations, includes test code) or lib-only (75 violations) is the intended clippy scope** — **RESOLVED**: lib-only, per CONTEXT.md D-08b. Matches the existing `test-rust` convention; `--all-targets` is explicitly banned in plan 01-02's acceptance criteria.
   - What we know: D-08 says "every violation it surfaces gets fixed," without specifying `--all-targets`. `test-rust` (`Makefile:188`) already runs `cargo test --lib` (lib scope only, no integration-test binaries), suggesting the repo's existing convention is lib-scoped tooling.
   - What's unclear: Whether test code (`#[cfg(test)] mod tests` blocks, which is where this repo's tests live per TESTING.md) should also be clippy-clean.
   - Recommendation: Match the existing `test-rust` convention - lib scope only (`cargo clippy -- -D warnings`, no `--all-targets`) - for consistency, unless the user explicitly wants test code held to the same bar. This keeps the fix list at 75 rather than 90.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node.js | All gates | Yes | v22 (per `engines`), CI pins 22.22.3 | - |
| pnpm | GATE-02, GATE-03, GATE-06 | Yes | 9.15.0 | - |
| Rust / cargo / rustup | GATE-01, GATE-05 | Yes (local sandbox) | rustc/cargo 1.96.0 local; **1.98.0 is true current stable** (Pitfall 6) | Re-measure clippy count against 1.98.0 before finalizing the fix list |
| clippy component | GATE-01 | Yes (bundled with local `stable` toolchain) | matches local rustc | `rust-toolchain.toml`'s `components` field auto-installs it fresh-clone |
| rustfmt component | GATE-01 | Yes | matches local rustc | same as above |
| Playwright + Chromium | GATE-04 verification (D-13's break-it-and-watch-it-fail method) | Not verified this session (no network browser install attempted) | `@playwright/test@^1.59.1` in `package.json` | CI already runs `pnpm exec playwright install --with-deps chromium` - no local action needed for the planner |
| Network access (npm registry) | Version verification | Yes - `npm view` calls succeeded throughout this session | - | - |
| Network access (cargo registry) | N/A for this research | cargo requires `--offline` in this sandbox to avoid hanging (per session's own tooling note); all cargo commands in this research used `--offline` and resolved successfully against the existing lockfile | - | If a real network-based `cargo` invocation is ever needed (e.g. bumping a crate version), expect it to hang without `--offline` in this environment specifically - likely not an issue in CI |

**Missing dependencies with no fallback:** none identified.
**Missing dependencies with fallback:** none beyond the two noted above (both already have a clear path).

## Validation Architecture

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Vitest 4 (TS/React), `cargo test` built-in harness (Rust), Playwright 1.59 (e2e) - all three already wired into `Makefile`, no new framework needed for this phase [CITED: `.planning/codebase/TESTING.md`] |
| Config file | `vite.config.ts` (Vitest, no dedicated `vitest.config.ts`); `playwright.config.ts`; none for `cargo test` |
| Quick run command | `pnpm test -- <pattern>` (Vitest); `cd src-tauri && cargo test --lib <name> --offline` |
| Full suite command | `make test` (= `test-ts` + `test-rust`); `make test-e2e` separately |

### Phase Requirements → Test Map

This phase's "tests" are largely the gates themselves proving they fail correctly (deliberate-break-then-revert), per D-13's explicit method for GATE-04, and identically applicable to GATE-01/02/03.

| Req ID | Behavior | Test Type | Verification Command | File Exists? |
|--------|----------|-----------|----------------------|-------------|
| GATE-01 | Clippy warning / unformatted Rust fails `make verify` | manual break-and-revert (D-13's method) | `cd src-tauri && cargo clippy --offline -- -D warnings` / `cargo fmt --check` | N/A - no fixture needed, break a real file temporarily |
| GATE-02 | Bad hook deps / unused symbol fails `make verify` | manual break-and-revert | `pnpm lint` | N/A |
| GATE-03 | Type error in a Playwright spec or `scripts/*.mjs` fails `make verify` | manual break-and-revert | `pnpm typecheck` (= `tsc -b`) | N/A |
| GATE-04 | Failing e2e in CI uploads a trace | **must** run in real CI, not locally - local `reuseExistingServer` and non-CI trace defaults differ | Land a deliberately failing spec, push, inspect the `playwright-report`/`test-results` artifact for `trace.zip`, then revert (D-13) | N/A |
| GATE-05 | Older commit builds with its own toolchain, not today's stable | manual verification - checkout an old commit, run `rustc --version` inside `src-tauri`, confirm it matches whatever `rust-toolchain.toml` said at that commit (or is absent pre-GATE-05) | `git checkout <old-sha> -- rust-toolchain.toml && cd src-tauri && cargo --version` | N/A |
| GATE-06 | `pnpm typecheck` passes with `@types/dompurify` removed | automated | `pnpm remove @types/dompurify && pnpm typecheck` | N/A |
| GATE-07 | Ledger has no resolved entries, module states hand-maintained | automated (grep) / manual (comment review) | `grep -c "skill-name-drift" src/lib/e2eFlow.ts` should be 0 after the change | `src/lib/e2eFlow.ts` (exists, line 165 currently) |

### Sampling Rate
- **Per task commit:** run the specific gate's own command (table above) plus `pnpm typecheck` (fast, catches cross-gate regressions).
- **Per wave merge:** `make verify` in full.
- **Phase gate:** `make verify` + `make test-e2e` green locally, then a real CI run for GATE-04's artifact-presence proof (D-13) - this cannot be satisfied by local commands alone.

### Wave 0 Gaps
None - this phase adds gates to existing infrastructure; it does not need new test fixtures or frameworks. The one non-standard verification step (GATE-04's "prove a trace lands in CI artifacts") is a manual CI-observation step already specified by D-13, not a missing automated test.

## Security Domain

`security_enforcement` is not explicitly disabled in `.planning/config.json` (no config file exists - default is enabled), so this section is included per protocol. This phase touches no authentication, session, input-validation, or cryptography surface - it is build/CI tooling only.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | No | N/A - no auth code touched |
| V3 Session Management | No | N/A |
| V4 Access Control | No | N/A |
| V5 Input Validation | No | N/A - no user-input-handling code changes; GATE-02's `no-floating-promises` is a correctness rule, not a security control, though it does incidentally reduce a class of "unhandled rejection swallows an error silently" bugs |
| V6 Cryptography | No | N/A |

### Known Threat Patterns for this stack

None applicable - this phase's only "product" surface change is GATE-06 removing an unused type-stub dependency (`@types/dompurify`), which reduces attack surface (fewer dependencies) rather than introducing any. No threat-modeling table is warranted.

## Sources

### Primary (HIGH confidence - measured directly against this repo this session)
- `npm view eslint / @eslint/js / typescript-eslint / eslint-plugin-react-hooks / @types/node version` and `peerDependencies` - package versions and compatibility, 2026-08-22
- `cargo fmt --check` and `cargo clippy --offline -- -D warnings` (both lib-only and `--all-targets`) run in `src-tauri/` - real violation counts
- A working `eslint.config.mjs` matching D-02's exact rule set, run against `src/` with `eslint@9.39.5` + `typescript-eslint@8.67.0` + `eslint-plugin-react-hooks@7.1.1` - real error/warning counts, including the underscore-ignore-pattern comparison
- `tsc -p tsconfig.e2e-probe.json` and `tsc -p tsconfig.scripts-probe.json` (both with a locally-installed `@types/node@22`) - real pre-existing type-error counts for `e2e/` and `scripts/`
- `node_modules/dompurify/package.json` (read directly) - confirms `dompurify@3.4.1` ships its own type declarations
- `src/lib/e2eFlow.ts` (read directly, lines 1-176) - confirms the exact `skill-name-drift` and `native-tauri-e2e-runner-missing` ledger entries and their current `content`/`status` fields
- `README.md` (grepped directly) - confirms the `skill-name-drift` entry's premise (stale skill names `inbox-processor`/`hwpx-fill`) no longer appears, i.e. the entry is genuinely resolved
- `gsd-tools query package-legitimacy check` - legitimacy verdicts for all 5 new/changed packages

### Secondary (MEDIUM confidence)
- [Trace viewer | Playwright](https://playwright.dev/docs/trace-viewer) - `retain-on-failure` semantics and `test-results/` artifact path
- [Overrides - The rustup book](https://rust-lang.github.io/rustup/overrides.html) - `rust-toolchain.toml` schema and override precedence
- [Announcing Rust 1.98.0 | Rust Blog](https://blog.rust-lang.org/2026/08/20/Rust-1.98.0/) - confirms current stable version for GATE-05's pin value

### Tertiary (LOW confidence)
- None - every claim in this research was either measured directly or backed by an official-docs citation above.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH - every version number confirmed via `npm view` this session
- Architecture: HIGH - directly derived from reading `Makefile`, `tsconfig.json`, `playwright.config.ts`, `package.json`, `.github/workflows/ci.yml` this session
- Pitfalls: HIGH - every pitfall in this document is backed by a real tool run against this repo, not inferred

**Research date:** 2026-08-22
**Valid until:** ~2026-08-29 for the Rust toolchain pin value (Pitfall 6 - next stable release is ~6 weeks out, but clippy lint additions can land in point releases too); ~30 days for the ESLint/TypeScript-ESLint version recommendations (Pitfall 5 - the 9-vs-10 question is stable but worth re-checking if implementation is delayed); the violation-count measurements (Pitfalls 1-4, Summary) are valid only until the next commit touches `src/`, `e2e/`, or `scripts/` - re-run before implementation if significant time has passed.

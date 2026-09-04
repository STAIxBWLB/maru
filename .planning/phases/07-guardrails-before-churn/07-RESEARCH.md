# Phase 7: Guardrails Before Churn - Research

**Researched:** 2026-09-05
**Domain:** Rust concurrency (Mutex poisoning), Tauri filesystem watchers (notify crate), static build guards (plain-node scripts), document-index scanning policy
**Confidence:** HIGH

## Summary

Phase 7 is a codebase-internal hardening phase: no new dependencies, no new user-facing surface. Four independent guardrails land in two languages. (1) PERF-03 converts six process-global locks from poison-bricking (`map_err(|_| "..._poisoned")`) to poison-recovering acquisition, each with its own co-located justification comment per D-03; the recovery idiom precedent exists in-tree but is test-only code (`fs.rs:216`). (2) PERF-04 adds a dispatch-time prune predicate over the shared `GENERATED_DIRS` list at five recursive notify watchers; the predicate belongs in `paths.rs` per D-05 and none of the five watcher modules reference `GENERATED_DIRS` today. (3) SEC-02 is a plain-node static guard in the `scripts/check-*.mjs` family that traces every `dangerouslySetInnerHTML` sink in `src/` to a DOMPurify-backed helper via a module allowlist (D-07) plus explicit `file + function` registrations for local helpers (D-08); six sinks exist today and all trace to four helper origins. (4) PERF-06 widens the existing scratchpad exclusion into a shared non-document-roots list at the three verified call sites in `vault.rs`; the inbox root is settings-driven (default `inbox/downloads`, not a hardcoded `inbox/`), which is a design nuance the plan must respect.

**Primary recommendation:** Treat the four requirements as four separable plans/waves sharing one verify gate. All discrete values (lock sites, sink lines, call sites, constant entries) below were read verbatim from source this session and can be lifted directly into PLAN.md task actions.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

- **D-01:** Recovery visibility is a single `warn`-level log line at the recovery point; the user surface shows nothing. Recovery is normal operation, not an event the user acts on.
- **D-02:** When the terminal registry or killer lock is recovered from poisoning, existing PTY sessions are kept and new commands against them keep working. — **Reversibility:** reversible — only the panic-path behavior changes if revisited.
- **D-03:** Each lock's recorded justification for why recovery is safe lives as a co-located code comment at the lock's `static` declaration / guard acquisition site (same position as the `skill_host/fs.rs:216` precedent), not in a central document.
- **D-04:** Pruning filters at event-dispatch time: events whose path falls under `GENERATED_DIRS` are dropped when they arrive. Registration-time exclusion is rejected because directories created after registration would stay unpruned until restart. — **Reversibility:** costly — switching strategy later means reworking the registration path of all five watcher modules.
- **D-05:** The shared matching predicate is a common helper in `src-tauri/src/paths.rs`, next to `GENERATED_DIRS` itself — the Phase 2 SSOT precedent: policy in one place, consumers reference it.
- **D-06:** All five recursive-watch sites are in scope: `vault_watcher.rs`, `inbox_watcher.rs`, `scratchpad_watcher.rs`, `ops_catalog/watcher.rs`, and `terminal_hooks.rs` — the ROADMAP success criterion's wording ("a recursive filesystem watcher") is generic, and the scope is fixed here so the plan does not re-litigate it.
- **D-07:** The guard judges tracing by a module allowlist: the list of modules that export DOMPurify-backed helpers is pinned in the guard script, and a sink's `__html` value must reference an identifier imported from an allowlisted module. Name-pattern matching is rejected (spoofable by naming) and AST parsing is rejected (leaves the `scripts/check-*.mjs` idiom the requirement mandates).
- **D-08:** Local aliases (e.g. `sanitizedHtml` in `HwpxViewer`) are not followed. The direct reference must pass; a file-local helper is registered in the guard as an explicit `file + function name` pair.
- **D-09:** The existing scratchpad exclusion is widened into a shared "non-document roots" list with `inbox/` added, referenced by all three call sites (`scan_vault`, `scan_vault_paths`, the `read_vault_cache` rel-prefix filter). A future non-document root is a one-line change. — **Reversibility:** costly — splitting the list back apart touches all three call sites again.
- **D-10:** The shared list constant lives in `src-tauri/src/vault.rs` beside the scan functions, not in `paths.rs`: it is document-index policy owned by the scan domain, while `paths.rs` keeps filesystem-level policy (`GENERATED_DIRS`, `ensure_within`).

### Claude's Discretion

- **Lock recovery mechanism per lock** (user delegated): the planner decides `into_inner()` vs rebuild-from-disk per lock, bounded by the requirement that each lock carries its own justification (D-03) and by REQUIREMENTS.md's exclusion of blanket `into_inner()` across invariant-bearing state.
- Guard failure message shape and the deliberate red-then-green proof mechanics for the SEC-02 guard (the proof itself is locked by ROADMAP success criterion 3).
- Watcher test fixture mechanics and the per-lock poison test harness design.
- DOMPurify helper export surface adjustments needed to make the six existing sinks pass under D-07/D-08 without weakening them.

### Deferred Ideas (OUT OF SCOPE)

None — discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PERF-03 | Panic under the six named process-global locks leaves the feature usable; each lock carries its own recorded justification; no recovery extended to locks outside the six | All six lock sites read verbatim (store.rs:45/2618, jobs.rs:16/95, dot_sync.rs:14/347, evidence_binder.rs:24/265/653, terminal/mod.rs:31/40/873/903); std poison semantics and recovery API confirmed from official docs; in-tree precedent at fs.rs:212-217 |
| PERF-04 | Recursive watchers emit no events for paths under the shared generated-directory prune list | Five watch sites confirmed on `recommended_watcher` + `RecursiveMode::Recursive`; `GENERATED_DIRS` (14 entries) confirmed at paths.rs:42-57; zero watcher modules reference it today; dispatch-time filter precedent (`relevant_path`) exists in vault_watcher.rs:21,89-91 |
| SEC-02 | `make verify` fails when a `dangerouslySetInnerHTML` value in `src/` does not trace to a DOMPurify-backed helper; guard is a static check in the `check-*.mjs` family | All six sinks and their four helper origins traced verbatim; guard idiom from check-select-chrome.mjs; `make verify` composition read at Makefile:355; test files contain the sink literal as source-text assertions and must be excluded |
| PERF-06 | Document index excludes the inbox root across `scan_vault`, `scan_vault_paths`, and `read_vault_cache`; Inbox pane / Files browser / content search still resolve `inbox/` paths; Inbox view removed from the switcher | All three call sites read verbatim (vault.rs:306/417/491); scratchpad exclusion shape read (vault.rs:254-269); inbox root is settings-driven (`DEFAULT_INBOX_ROOT = "inbox/downloads"`, inbox_settings.rs:19); frontend view switcher pieces located (documentIndex.ts:5,273-274; Sidebar.tsx:88-97; App.tsx:1303); inbox.rs reads the same `.maruignore` (inbox.rs:869,881), confirming the REQUIREMENTS rationale for not using ignore rules |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Lock poison recovery (PERF-03) | API / Backend (Rust core, `src-tauri/src`) | — | The locks are process-global Rust statics guarding on-disk state; recovery is a backend concern with no UI surface (D-01: one `warn` log line) |
| Watcher event pruning (PERF-04) | API / Backend (Rust core, `src-tauri/src/paths.rs` + five watcher modules) | — | Events are dropped in the watcher callback/drain thread before Tauri emit; frontend receives no change of contract |
| Sanitizer static guard (SEC-02) | Build / CI (plain-node script + Makefile wiring) | Browser / Client (the sinks it protects) | The guard is a build-time static check; its subject is frontend rendering code, but it lives in the verify pipeline, not the app |
| Inbox index exclusion (PERF-06) | API / Backend (`vault.rs` scan/cache policy) | Browser / Client (view switcher cleanup) | Exclusion is scan-domain policy (D-10); the frontend only removes the Inbox view from the switcher and its count badge |

## Standard Stack

### Core

No new packages. Every capability is built from what the repo already depends on:

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| (Rust std) `std::sync::Mutex` / `PoisonError` | pinned toolchain 1.98.0 | Poison recovery via `PoisonError::into_inner()`; `Mutex::clear_poison()` (1.77.0+) as an alternative | The std-documented recovery shape; the in-tree precedent at fs.rs:216 uses exactly `unwrap_or_else(\|poisoned\| poisoned.into_inner())` |
| `notify` (crate) | in Cargo.lock (existing) | The five watchers already use `recommended_watcher` + `RecursiveMode::Recursive`; PERF-04 only adds a path predicate at dispatch | Already the project's watcher stack; no API change needed |
| `dompurify` | `^3.4.1` [VERIFIED: package.json:58] | The sanitizer every sink must trace to | Already the project's sanitizer; the guard enforces its use, it adds nothing |

### Supporting

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| `marked` | `^18.0.2` [VERIFIED: package.json:63] | Markdown render upstream of DOMPurify inside `renderMarkdown` | Context only — sinks trace to the DOMPurify wrapper, not to marked |
| `vitest` | `^4.1.5` [VERIFIED: package.json:90] | TS unit tests, incl. source-text assertion style already used in EditorPane.test.tsx | SEC-02/PERF-06 frontend regression tests |
| `cargo test --lib` | via Makefile:196-197 | Rust unit tests for predicate, exclusion, and poison recovery | PERF-03/04/06 backend tests |

### Alternatives Considered

None — CONTEXT.md locks the shape of every requirement (no new lint framework per REQUIREMENTS.md "Out of Scope"; no registration-time watcher exclusion per D-04; no `.maruignore` route per REQUIREMENTS.md).

**Installation:** none. `npm install` / `cargo build` prerequisites unchanged.

**Package Legitimacy Audit**

> Not required — this phase installs no external packages. No `## Package Legitimacy Audit` table; nothing to gate behind `checkpoint:human-verify`.

## Architecture Patterns

### System Architecture Diagram

```
                        Phase 7: four independent guardrails
 ┌─────────────────────────────────────────────────────────────────────────┐
 │ PERF-03                          PERF-04                                │
 │ Tauri command ──► guard fn        notify callback ──► debounce/drain    │
 │   ├─ REGISTRY_LOCK  (store.rs)      ├─ vault_watcher                    │
 │   ├─ JOBS_LOCK      (jobs.rs)       ├─ inbox_watcher                    │
 │   ├─ DOT_ACTION_LOCK(dot_sync)      ├─ scratchpad_watcher               │
 │   ├─ BINDER_WRITE_LOCK(evidence)    ├─ ops_catalog/watcher (per-BU)     │
 │   └─ terminal registry + killer     └─ terminal_hooks                   │
 │        lock().map_err(poisoned)          │                              │
 │            ▼                             ▼                              │
 │   poisoned.into_inner() + warn     is_under_generated_dir(path)?        │
 │   + per-lock justification ──yes──► drop event (no emit)                │
 │                                     no ──► emit as today                │
 │ SEC-02                             PERF-06                              │
 │ make verify ──► node scripts/      scan_vault (walk filter)             │
 │   check-dom-sanitizer.mjs          scan_vault_paths (containment test)  │
 │     │ scan src/**/*.tsx            read_vault_cache (rel-prefix filter) │
 │     │ find dangerouslySetInnerHTML        │                             │
 │     │ trace __html value ──►               ▼                            │
 │     │   import from allowlisted module  non_document_roots (vault.rs)   │
 │     │   OR registered file+function      = scratchpad root + inbox root │
 │     ▼                                     (settings-driven)             │
 │   violation ──► exit 1 ──► verify red    frontend: remove Inbox view    │
 │                                            from switcher + count badge  │
 └─────────────────────────────────────────────────────────────────────────┘
```

### Recommended Project Structure

No new directories. Changes are in place:

```
src-tauri/src/
├── paths.rs              # + is_under_generated_dir() predicate beside GENERATED_DIRS (D-05)
├── vault.rs              # + shared non-document-roots list beside the scan fns (D-09/D-10); widen 3 call sites
├── skill_host/store.rs   # REGISTRY_LOCK poison recovery + justification (D-03)
├── jobs.rs               # JOBS_LOCK poison recovery + justification
├── dot_sync.rs           # DOT_ACTION_LOCK poison recovery + justification
├── evidence_binder.rs    # BINDER_WRITE_LOCK poison recovery + justification
├── terminal/mod.rs       # terminal registry + killer lock recovery (D-02)
├── vault_watcher.rs      # dispatch-time GENERATED_DIRS prune
├── inbox_watcher.rs      # dispatch-time GENERATED_DIRS prune
├── scratchpad_watcher.rs # dispatch-time GENERATED_DIRS prune
├── ops_catalog/watcher.rs# dispatch-time GENERATED_DIRS prune
└── terminal_hooks.rs     # dispatch-time GENERATED_DIRS prune
scripts/
└── check-dom-sanitizer.mjs   # new SEC-02 guard (name per check-*.mjs family convention)
src/
├── lib/documentIndex.ts    # drop "inbox" from BuiltInDocumentView + its match case
├── components/Sidebar.tsx  # drop inbox entry from builtInViews
└── App.tsx                 # drop the inbox view count (line 1303 region)
Makefile                    # wire check-dom-sanitizer into `verify`
```

### Pattern 1: Poison recovery at guard acquisition

**What:** Replace `lock().map_err(|_| "..._poisoned")` with a match/unwrap_or_else that logs one `warn` and recovers the guard from the `PoisonError`.

**When to use:** All six named locks. The unit mutexes (`Mutex<()>`) guard data that lives on disk and is re-read after acquisition, so the in-memory unit value carries no invariant — that is the justification skeleton, but each lock needs its own comment per D-03.

**Example:**

```rust
// Source: https://doc.rust-lang.org/std/sync/struct.Mutex.html (Poisoning section)
let mut guard = match lock.lock() {
    Ok(guard) => guard,
    Err(poisoned) => poisoned.into_inner(),
};
```

```rust
// In-tree precedent (test-only today) [VERIFIED: src-tauri/src/skill_host/fs.rs:211-217]
pub(crate) fn test_maru_home_lock() -> MutexGuard<'static, ()> {
    MARU_TEST_HOME_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
```

Std semantics that bound the design [CITED: doc.rust-lang.org/std/sync/struct.Mutex.html]:
- "Poisoning is only advisory: the `PoisonError` type has an `into_inner` method which will return the guard that would have been returned on a successful lock."
- "Once a mutex is poisoned, all other threads are unable to access the data by default as it is likely tainted (some invariant is not being upheld)." — this is exactly why REQUIREMENTS.md forbids blanket recovery and D-03 demands per-lock justification.
- `Mutex::clear_poison()` (stabilized 1.77.0) is the alternative when recovery overwrites the guarded value with a known-good one — relevant only if a lock's discretion choice is rebuild-from-disk.

### Pattern 2: Dispatch-time event pruning

**What:** In each watcher's event callback or drain thread, drop any event path whose components intersect `GENERATED_DIRS` before any emit.

**When to use:** All five recursive watchers (D-06). Fargment vs whole-event: a notify `Event` carries `paths: Vec<PathBuf>` — prune offending paths from the set, keep the rest of the event (D-04 says "events whose path falls under GENERATED_DIRS are dropped"; per-path filtering matches the vault watcher's existing per-path filter shape).

**Example shape (new helper, per D-05):**

```rust
// New in src-tauri/src/paths.rs, beside GENERATED_DIRS:
// true when any component of `path` is a generated directory name.
pub fn is_under_generated_dir(path: &Path) -> bool {
    path.components().any(|component| {
        matches!(component, Component::Normal(name) if GENERATED_DIRS.contains(&name.to_string_lossy().as_ref()))
    })
}
```

The predicate mirrors the already-shipping component-matching logic [VERIFIED: src-tauri/src/vault.rs:226-234]:

```rust
        for component in rel.components() {
            let Component::Normal(value) = component else {
                continue;
            };
            let name = value.to_string_lossy();
            if generated_dirs.iter().any(|dir| name == *dir) {
                return true;
            }
```

Note the existing `ScanFilter::is_excluded_path(path, root, generated_dirs)` (vault.rs:219) is root-relative; watchers have multiple roots (ops_catalog registers one recursive watch per business-unit directory, ops_catalog/watcher.rs:149-166), so the new helper must be root-agnostic absolute-path matching, not a `ScanFilter` reuse.

### Pattern 3: Static guard in the `check-*.mjs` family

**What:** Plain-node script: walk `src/`, regex-scan for sinks, apply a tracing rule, `process.exit(1)` on violations; wired as a Makefile `verify` prerequisite like the siblings.

**When to use:** SEC-02 exactly; REQUIREMENTS.md names the family as the mandated shape.

**Idiom anchors** [VERIFIED: scripts/check-select-chrome.mjs]:
- ESM node script, `node:fs` / `node:path` only, no dependencies (lines 12-16).
- Collect files recursively, skip nothing except `node_modules` (lines 18-29).
- Violations accumulate, then: `console.error(...); process.exit(1);` (lines 71-76).
- Makefile wiring: `check-select-chrome: ... $(NODE) scripts/check-select-chrome.mjs` [VERIFIED: Makefile:174-176]; `verify` at Makefile:354-355 already chains `check-select-chrome check-type-tokens`.

### Anti-Patterns to Avoid

- **Blanket `into_inner()` recovery:** REQUIREMENTS.md "Out of Scope" — "applied to an invariant-bearing structure it converts a loud panic into silent corruption". Every recovery needs its own comment (D-03). Do not touch `INSPECTION_CACHE` (evidence_binder.rs:25-26) or `MARU_TEST_HOME_LOCK` — neither is one of the six.
- **Registration-time watcher exclusion (watch-time filtering):** rejected by D-04 — directories created after registration would stay unpruned until restart.
- **Name-pattern tracing in the guard:** rejected by D-07 (spoofable by naming). **AST parsing:** rejected (leaves the `check-*.mjs` idiom).
- **Following local aliases:** rejected by D-08 — a file-local helper is registered as an explicit `file + function name` pair.
- **`.maruignore` route for PERF-06:** REQUIREMENTS.md "Out of Scope" — inbox.rs reads the same file [VERIFIED: src-tauri/src/inbox.rs:869 `let ignore_patterns = load_maruignore(vault);`, :881 `!matches_maruignore(rel, &ignore_patterns)`], so an ignore rule that clears the documents list also empties the Inbox queue.
- **Hardcoding `"inbox/"` in the exclusion:** the inbox root is settings-driven — see Pitfall 1.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Mutex poison recovery | A custom lock wrapper type | `PoisonError::into_inner()` (std) at each guard site, per std docs and the fs.rs:216 precedent | Poisoning is std-defined, advisory behavior; a wrapper would obscure the per-lock justification comments D-03 requires |
| Generated-dir matching | A glob library or regex matcher | Component-wise exact-name check against `GENERATED_DIRS` (same shape as `ScanFilter::is_excluded_path`, vault.rs:226-234) | Exact component match is what every scanner already does; a new matcher semantics would diverge from the SSOT list's meaning |
| HTML sanitization | Any new sanitizer or sink-side escaping | The existing DOMPurify-backed helpers (`renderMarkdown`, `renderScratchpadMarkdown`, `sanitizeHtml`, HwpxViewer's inline sanitize) | The phase enforces the existing boundary; it does not extend it |
| Sink detection | AST parser or eslint plugin | Line/regex-level tracing in the `check-*.mjs` idiom (D-07 forbids both alternatives) | REQUIREMENTS.md: "One grep-shaped script in the existing `check-*.mjs` family suffices" |

**Key insight:** every "don't hand-roll" here is a CONTEXT.md/requirement lock, not a preference. The phase's entire risk budget goes into making the mandated simple shapes correct.

## Runtime State Inventory

> Phase 7 is behavior-hardening, not rename/migration, but PERF-06 touches a stored artifact — answered explicitly per category:

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | Existing on-disk vault caches may already contain `inbox/...` entries (issue #309 measured 11,488 index entries). The `read_vault_cache` rel-prefix filter is the designated stale-cache defense [VERIFIED: src-tauri/src/vault.rs:493-494 — "A cache written before scratchpad exclusion still holds those entries; drop them here"]. | Code edit only: the widened rel-prefix filter must cover the inbox root so old caches self-heal at read, exactly as the scratchpad precedent does. No cache migration task needed. |
| Live service config | None — no external services in scope. | — |
| OS-registered state | None — watcher registrations are in-process; a poisoned lock clears on app restart. | — |
| Secrets/env vars | None touched. | — |
| Build artifacts | `make verify` output and CI; the SEC-02 guard becomes a new permanent gate the moment it lands. Its red-then-green proof must run before the wiring commit (STATE.md precedent: GATE-02's deliberate break-and-revert). | The proof commit sequence itself is the task. |

**Nothing found in category:** verified by reading each call site's persistence path (locks guard `.maru/jobs.json`, the skill registry on disk, `.maru/binder/` state, and in-memory terminal maps; nothing is written under the renamed/changed semantics).

## Common Pitfalls

### Pitfall 1: The inbox root is settings-driven, not a literal `inbox/`
**What goes wrong:** The plan hardcodes a `inbox/` prefix exclusion; a workspace whose `inbox_root` is retargeted (the feature exists for exactly this — inbox_settings.rs:3 comment: "retarget the inbox root (`inbox/downloads` by default)") still leaks its actual spool tree into the index, or — worse — a workspace with an authored folder literally named `inbox/` (not the Maru inbox) gets wrongly pruned.
**Why it happens:** ROADMAP and the issue speak of `inbox/...` rows; the frontend view matches the literal prefix [VERIFIED: src/lib/documentIndex.ts:273-274 — `case "inbox": return record.entry.relPath.startsWith("inbox/");`], but the backend root is resolved through settings.
**How to avoid:** Resolve the exclusion root the same way inbox.rs does [VERIFIED: src-tauri/src/inbox.rs:858 — `let inbox_root = resolve_inside_vault(&vault.to_string_lossy(), settings.inbox_root.as_str())?;`] with `DEFAULT_INBOX_ROOT: &str = "inbox/downloads"` [VERIFIED: src-tauri/src/inbox_settings.rs:19]. Mirror `excluded_scratchpad_root`'s fail-open shape [VERIFIED: src-tauri/src/vault.rs:254-257] so settings trouble keeps listing rather than bricking the scan. Also match the scratchpad containment-vs-prefix asymmetry: `scan_vault` skips the root dir in the walk filter (vault.rs:350-352), `scan_vault_paths` tests `path.starts_with(root)` (vault.rs:456-460), `read_vault_cache` filters by rel-prefix with trailing slash (vault.rs:261-269, 495-501).
**Warning signs:** A plan task that mentions `"inbox/"` as a string literal in Rust scan code.

### Pitfall 2: The sink literal also lives in test files
**What goes wrong:** The SEC-02 guard scans `src/` and flags `src/components/EditorPane.test.tsx`, which asserts the sink as source text [VERIFIED: src/components/EditorPane.test.tsx:102-103 — `expect(source).toContain("const previewMarkup = useMemo(() => ({ __html: previewHtml }), [previewHtml]);"); expect(source).toContain("dangerouslySetInnerHTML={previewMarkup}");`].
**Why it happens:** A naive file walk collects `*.test.tsx` like any other file; check-select-chrome.mjs's collector does not special-case tests (it has none to avoid).
**How to avoid:** Exclude `*.test.*` / `__tests__/` in the collector; prove the exclusion with the red-then-green drill. (The existing test's source-assertion style is a good model for the guard's own regression test.)
**Warning signs:** Guard first run reports EditorPane.test.tsx.

### Pitfall 3: EditorPane's sink traces through a dynamic import and a local decorator
**What goes wrong:** The guard (D-07) requires the `__html` value to reference an identifier imported from an allowlisted module. EditorPane's `previewMarkup` derives from `previewHtml` → `decoratePreviewHtml(previewBaseHtml, ...)` (EditorPane's own exported helper, EditorPane.tsx:133), and `previewBaseHtml` is set from `import("../lib/markdown").then(({ renderMarkdown }) => ...)` — a dynamic import, not a top-level one [VERIFIED: src/components/EditorPane.tsx:328].
**Why it happens:** D-07/D-08 intentionally do not follow aliases; a pure import-line tracer fails this sink.
**How to avoid:** This is exactly the registered discretion item ("DOMPurify helper export surface adjustments"). Prescriptive path: register `("src/components/EditorPane.tsx", "decoratePreviewHtml")` as a D-08 file+function pair AND teach the tracer that `previewBaseHtml` is assigned from an allowlisted-module call inside a `.then(...)` (a narrow, explicit pattern — file-scoped assignment lookup, not general alias following). Alternative: hoist the dynamic import to a static `import { renderMarkdown } from "../lib/markdown"` if bundle behavior permits — but the dynamic import was chosen deliberately (lazy markdown stack), so expect the registration path.
**Warning signs:** First guard run flags EditorPane.tsx:1041; resist "fixing" it by weakening the rule.

### Pitfall 4: HwpxViewer sanitizes inline, not through an exported helper
**What goes wrong:** D-08 requires a registered `file + function` pair for file-local helpers, but HwpxViewer's `sanitizedHtml` is produced by an inline `DOMPurify.sanitize(...)` inside `useEffect` [VERIFIED: src/components/binaryViewers/HwpxViewer.tsx:37-40], not a named function. There is no function name to register.
**How to avoid:** Extract the inline sanitize into a named module-level function in the same file (e.g. `export function sanitizeHwpxPreviewHtml(html: string): string`) and register the pair; this is the "export surface adjustment" the discretion item names. Keeps D-08 honest (explicit registration, no alias following) without weakening anything.
**Warning signs:** A plan that registers a file alone without a function name — D-08 forbids that granularity.

### Pitfall 5: Poison tests against process-global statics interfere with the test harness
**What goes wrong:** `cargo test --lib` runs all tests in one process. Poisons `REGISTRY_LOCK`/`JOBS_LOCK`/etc. — which are `OnceLock`/`static` process-globals shared across every test — and never restores them, so unrelated tests that trip the poison path behave differently depending on execution order.
**Why it happens:** The obvious harness (lock the static in a thread, panic, join, assert recovery) permanently poisons a global.
**How to avoid:** Two acceptable shapes, planner's choice (discretion): (a) each poison test performs its assertion and then calls `Mutex::clear_poison()` [CITED: doc.rust-lang.org/std/sync/struct.Mutex.html — `clear_poison()` stabilized 1.77.0] in a `Drop`-guaranteed or `scopeguard`-free finally position; (b) factor the recovery decision into a pure helper (e.g. `fn recover<T>(result: LockResult<T>, lock_name: &str) -> MutexGuard<T>`) and unit-test the helper on a fresh local `Mutex`, with one integration-style test per lock at most. (b) is cheaper and order-independent; (a) proves the real static. Note the terminal locks are per-session (`session.killer`, `state.sessions` on `TerminalState`), so their tests build their own `TerminalState` — no global pollution at all.
**Warning signs:** A poison test without a cleanup story; a full-suite pass only when run with `--test-threads=1`.

### Pitfall 6: ops_catalog watches many roots; per-BU growth is the motivation
**What goes wrong:** Pruning only the single-root watchers and missing `ops_catalog/watcher.rs` — it registers one recursive watch per business-unit directory [VERIFIED: src-tauri/src/ops_catalog/watcher.rs:149-166, `fn register_bu_watch_paths`], which CONCERNS.md:176-177 flags as the growth case.
**How to avoid:** D-06 already fixes all five in scope; the plan just must not split D-06.
**Warning signs:** A task list with four watcher files.

### Pitfall 7: Dropping whole events instead of offending paths
**What goes wrong:** If a single notify `Event` carries multiple paths (it can — paths is a Vec) and one is under a generated dir, dropping the whole event loses legitimate sibling paths in the same event batch.
**Why it happens:** "events whose path falls under GENERATED_DIRS are dropped" reads naturally as per-event.
**How to avoid:** Filter per path (as vault_watcher's drain thread already does at the path level, vault_watcher.rs:89-97); drop only the offending path from the batch.
**Warning signs:** Guard-level test asserting zero emits for a mixed batch fails.

## Code Examples

Verified patterns from official sources and in-tree precedent (see Pattern 1-3 above for the primary shapes).

### SEC-02 tracing rule skeleton (prescriptive shape, not final code)

```javascript
// scripts/check-dom-sanitizer.mjs — idiom per check-select-chrome.mjs.
// 1. Collect src/**/*.tsx EXCLUDING *.test.* and __tests__/.
// 2. For each /dangerouslySetInnerHTML=\{\{\s*__html:\s*([^}]+?)\s*\}\}/
//    or dangerouslySetInnerHTML=\{([A-Za-z_$][\w$]*)\}:
//    - inline object: the __html expression must be a direct call of, or
//      identifier assigned from, an allowlisted import
//      (allowlist pinned here per D-07, e.g.
//      ["src/lib/markdown.ts", "src/lib/scratchpad.ts",
//       "src/lib/diagram/richText.ts"]).
//    - identifier: resolve its in-file definition; the defining expression
//      must (a) call an allowlisted import, or (b) call a function
//      registered as a [file, function] pair per D-08
//      (e.g. ["src/components/EditorPane.tsx", "decoratePreviewHtml"],
//      ["src/components/binaryViewers/HwpxViewer.tsx", <extracted name>]).
// 3. EditorPane.tsx only: previewBaseHtml assignment via
//    import("../lib/markdown").then(({ renderMarkdown }) => ...) counts
//    as allowlisted-module provenance (narrow explicit pattern).
// 4. violations -> console.error + process.exit(1).
```

### Sink inventory the guard must pass on day one (all read verbatim this session)

| Sink | Value expression | Provenance chain |
|------|------------------|------------------|
| `src/components/EditorPane.tsx:1041` | `dangerouslySetInnerHTML={previewMarkup}` | `previewMarkup = useMemo(() => ({ __html: previewHtml }), [previewHtml])` (asserted verbatim in EditorPane.test.tsx:102); `previewHtml = useMemo(() => decoratePreviewHtml(previewBaseHtml, {...}), ...)` (:423-435); `previewBaseHtml` from dynamic `import("../lib/markdown")` (:328) |
| `src/components/drafts/DraftsPane.tsx:968` | `dangerouslySetInnerHTML={{ __html: previewHtml }}` | `previewHtml = useMemo(() => (detail && !editing ? renderMarkdown(editContent) : ""), ...)` (:562-565); `renderMarkdown` imported from `../../lib/markdown` (:44) |
| `src/components/drafts/DraftsPane.tsx:1033` | `dangerouslySetInnerHTML={{ __html: renderMarkdown(ideaEditContent) }}` | direct call of the same allowlisted import |
| `src/components/ScratchpadPane.tsx:1360` | `dangerouslySetInnerHTML={{ __html: previewHtml }}` | `previewHtml = useMemo(() => (editor?.format === "markdown" ? renderScratchpadMarkdown(content) : ""), ...)` (:953-956); `renderScratchpadMarkdown` imported from lib/scratchpad (:57) |
| `src/components/InlineDocumentEditor.tsx:228` | `dangerouslySetInnerHTML={{ __html: previewHtml }}` | `previewHtml = useMemo(() => (isMarkdown ? renderMarkdown(content) : ""), ...)` (:77-80); `renderMarkdown` imported from `../lib/markdown` (:13) |
| `src/components/binaryViewers/HwpxViewer.tsx:95` | `dangerouslySetInnerHTML={{ __html: sanitizedHtml }}` | inline `DOMPurify.sanitize(preview.html, { USE_PROFILES: { html: true } })` in `useEffect` (:37-40) — needs the Pitfall 4 extraction |

Allowlisted helper origins (verbatim):
- `src/lib/markdown.ts:50` — `export function renderMarkdown(markdown: string): string {` → `return DOMPurify.sanitize(html, { ADD_ATTR: ["target", "data-wikilink"], ...` (:58)
- `src/lib/scratchpad.ts:187-188` — `export function renderScratchpadMarkdown(markdown: string): string { return DOMPurify.sanitize(renderMarkdown(markdown), { FORBID_TAGS: [...] ...`
- `src/lib/diagram/richText.ts:20-26` — `export function sanitizeHtml(html: string): string { return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, USE_PROFILES: { html: true } }); }` (currently no sink consumes it; keep allowlisted)
- `src/components/binaryViewers/HwpxViewer.tsx:37` — inline (to be extracted per Pitfall 4)

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Poisoned lock bricks the feature until restart (`map_err` → `"..._poisoned"` error string) | Recover the guard at acquisition + one warn log + per-lock justification comment | This phase (PERF-03) | Six error strings currently returned to users disappear from the panic path: `skills_registry_lock_poisoned` (store.rs:2622), `jobs_lock_poisoned` (jobs.rs:99), `dot_action_lock_poisoned` (dot_sync.rs:351), `evidence_binder_lock_poisoned` (evidence_binder.rs:267,655), `terminal_killer_poisoned` (terminal/mod.rs:877), `terminal_registry_poisoned` (terminal/mod.rs:904). Frontend readers of these strings, if any, become dead — the plan should grep the frontend for them before deleting. |
| Watchers forward every event under a heavy subtree | Dispatch-time prune against `GENERATED_DIRS` | This phase (PERF-04) | `GENERATED_DIRS` goes from six scanner consumers to eleven consumers (five watchers added); the list's edit cost stays one line |
| Sanitizer discipline by code review | Static guard wired into `make verify` | This phase (SEC-02) | Matches the GATE-02/eslint-gate precedent: a rule proven red-then-green before it gates |
| Scratchpad-only exclusion at three hand-rolled sites | Shared non-document-roots list at three referencing sites | This phase (PERF-06) | Adding a future non-document root becomes a one-line change (D-09) |

**Deprecated/outdated:** none discovered in this phase's scope. (The CSP `script-src 'self' blob:` at tauri.conf.json:35 is Phase 10 / SEC-01's question, explicitly out of scope per CONTEXT canonical refs.)

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | `log` (or `log::warn`) is available in all six lock modules for the D-01 warn line. Observed: the crates use `log` family widely, but I did not open each module's imports to confirm `log::warn` is already imported or reachable. | Pattern 1 | Trivial — an import line per file; no design change |
| A2 | The frontend has no reader of the six `*_poisoned` error strings that needs updating. Not grepped in src/ this session. | State of the Art | If a reader exists, a plan task must retire it; low risk either way |
| A3 | `notify` `Event.paths` can legitimately mix generated and non-generated paths in one event, making per-path filtering (Pitfall 7) the correct reading of D-04. Consistent with the Vec-shaped `paths` observed at every watcher callback. | Pattern 2 / Pitfall 7 | If whole-event dropping were intended, per-path filtering is still a strict improvement (never emits an offending path) |
| A4 | No sixth `dangerouslySetInnerHTML` sink hides outside `src/` in a location the guard's `src/` scope would miss — REQUIREMENTS.md says "in `src/`", and the full-repo grep found exactly the six sinks plus the test-file literal. Verified for `src/`; `e2e/` was not exhaustively read. | Code Examples | Requirement text pins the scope; a stray e2e literal is outside the guard's contract |
| A5 | Cargo toolchain resolves to 1.98.0 inside the project (rust-toolchain.toml pins it) despite the Homebrew cargo on PATH reading 1.97.1. | Environment Availability | If rustup is absent, builds use 1.97.1 — still >= 1.77.0, so `clear_poison()` remains available; no design impact |

**If A1-A5 resolve as expected:** no user confirmation needed; all are planner-level details.

## Open Questions

1. **HwpxViewer extraction name and registration**
   - What we know: the inline sanitize must become a named function to satisfy D-08 (Pitfall 4).
   - What's unclear: the planner's preferred name and whether it should be exported (consumed by the guard's pair registry as `"sanitizeHwpxPreviewHtml"`) or module-private (registration still names it).
   - Recommendation: export it; the existing helper modules all export theirs, and export makes the registration verifiable from the guard script.

2. **Whether `make verify` ordering matters for the new guard**
   - What we know: `verify` chains ~12 targets (Makefile:354-355); check-select-chrome and check-type-tokens run after lint-i18n, before tests.
   - What's unclear: whether the SEC-02 guard should run early (cheap static, fail fast) or alongside the other static guards.
   - Recommendation: place it adjacent to `check-select-chrome` — same cost class, same "static guard" semantic, and the family is already grouped there.

3. **Inbox view removal blast radius beyond the three located sites**
   - What we know: `BuiltInDocumentView` union (documentIndex.ts:5), its `case "inbox"` (:273-274), Sidebar `builtInViews` (:88-97), App.tsx:1303 count badge.
   - What's unclear: whether persisted workspace state (`documentFilterByVisibility` in workspaceStore.ts, `pruneCustomDocumentFiltersInState`) can hold `{ kind: "view", view: "inbox" }` across the removal and needs a prune/migration path; outlinePaneStore.test.ts:168,176 show the inbox filter shape in tests.
   - Recommendation: plan a task that resets a persisted `view: "inbox"` filter to the all-documents default on load (fail-open), plus updates the two test references. The planner should read workspaceStore.ts:212-232 before writing this task.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| node | SEC-02 guard script, vitest | ✓ | v24.18.1 | — |
| cargo/rustc | PERF-03/04/06 Rust tests, clippy | ✓ | rust-toolchain.toml pins 1.98.0 (A5) | — |
| pnpm + node_modules | vitest run, tsc | ✓ (per Makefile node_modules-gated targets) | — | — |
| notify crate (already in Cargo.lock) | PERF-04 | ✓ | existing lockfile | — |
| DOMPurify (already in package.json) | SEC-02 subject | ✓ | ^3.4.1 | — |
| `make verify` full chain | SEC-02 red-then-green proof | ✓ (Makefile:355) | — | Individual gates run standalone per STATE.md Phase 1 precedent if the shared checkout races |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** none.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | vitest 4.1.5 (TS) + cargo test --lib (Rust) [VERIFIED: package.json:90, Makefile:196-197] |
| Config file | vitest: package.json script `vitest run src scripts` (:29); Rust: inline `#[cfg(test)]` modules (project convention — e.g. vault.rs tests at :979+) |
| Quick run command | `pnpm test -- <file>` (TS) / `cargo test --lib <module>` (Rust) |
| Full suite command | `make verify` (Makefile:354-355) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PERF-03 | Each of the six locks recovers from poisoning; feature usable on next call | unit (Rust) | `cargo test --lib <module>` per lock (harness per Pitfall 5) | ❌ Wave 0 — new poison-recovery tests beside each guard fn |
| PERF-04 | No event emitted for a path under any GENERATED_DIRS entry; sibling paths in the same batch still emit | unit (Rust) | `cargo test --lib paths` (new predicate) + per-watcher drain/filter tests | ❌ Wave 0 — predicate tests; watcher files have existing test modules (vault_watcher.rs:131 etc.) to extend |
| SEC-02 | Guard exits 1 on an untraced sink; exits 0 on the six current sinks; red-then-green proven | unit (TS, source-assertion style per EditorPane.test.tsx) + shell drill | `node scripts/check-dom-sanitizer.mjs` (red/green via a temporary fixture file the drill adds and removes) | ❌ Wave 0 — script + drill + optional vitest wrapper |
| SEC-02 | `make verify` wires the guard | integration | `make verify` (or `make check-dom-sanitizer` standalone) | ❌ Wave 0 — Makefile target + verify chain edit |
| PERF-06 | Zero `inbox/...` entries from full scan, targeted rescan, and cache read; stale cache self-heals | unit (Rust) | `cargo test --lib vault` — mirrors `scan_vault_skips_scratchpad_root` (vault.rs:1223-1235) and `read_vault_cache_drops_stale_scratchpad_entries` (:1237-1257) | ❌ Wave 0 — inbox twins of those two tests + `scan_vault_paths` containment test |
| PERF-06 | Inbox pane still lists pending/drop items; Files browser + content search resolve `inbox/` paths | unit (Rust) + e2e | `cargo test --lib inbox` (existing coverage) + Playwright inbox spec (e2e/inbox*.spec.ts exists in repo) | ⚠️ Partial — existing inbox/content_search/workspace_files tests must be *run and kept green*; they are the regression watch |
| PERF-06 | Inbox view gone from the documents switcher | unit (TS) | `vitest run src/lib/documentIndex` — assert the union/case removal; workspaceStore persisted-filter reset test | ❌ Wave 0 — plus update outlinePaneStore.test.ts:168,176 and documentIndex.test.ts:111 references |

### Sampling Rate
- **Per task commit:** `cargo test --lib <touched module>` and/or `pnpm test -- <touched test>`
- **Per wave merge:** `make verify` minus the known shared-checkout races (STATE.md Phase 1 precedent: verify each owned gate individually if the checkout is concurrent; CI is the authoritative composite)
- **Phase gate:** full `make verify` green + the four success criteria demonstrated (including the SEC-02 red-then-green artifact) before `/gsd-verify-work`

### Wave 0 Gaps
- [ ] `scripts/check-dom-sanitizer.mjs` + `make check-dom-sanitizer` target + `verify` chain entry (SEC-02)
- [ ] Poison-recovery test harness decision (Pitfall 5 shape (a) or (b)) + tests for all six locks (PERF-03)
- [ ] `paths::is_under_generated_dir` predicate + unit tests incl. mixed-batch case (PERF-04)
- [ ] vault.rs inbox-exclusion twins of the scratchpad tests across all three call sites (PERF-06)
- [ ] Frontend: documentIndex/Sidebar/App.tsx removal + persisted-filter reset + test reference updates (PERF-06)

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V5 Input Validation / Output Encoding | yes (SEC-02) | DOMPurify sanitize as the single sanctioned path to `dangerouslySetInnerHTML`; static guard enforces traceability (this phase's deliverable IS the control) |
| V5 Input Validation | yes (PERF-06, boundary) | `resolve_inside_vault` containment for the settings-driven inbox root — same lexical-containment discipline as Phase 2's SCAN-03 |
| V6 Cryptography | no | — |
| V2/V3/V4 | no | Local single-user app; no auth/session surface in this phase |

Threat model context [VERIFIED: src-tauri/tauri.conf.json:34-43]: CSP ships `"script-src": "'self' blob:"` and `"object-src": "'none'"` — the CSP narrowing (dropping `blob:`) is Phase 10 / SEC-01, out of scope here, but SEC-02's guard is the compensating control that keeps untrusted-content XSS from entering the DOM while the CSP discussion is pending. CONCERNS.md:100-101 names the ingestion surface: "Maru ingests content the user did not author (Telegram, KakaoTalk, Gmail, Outlook, inbox drops) and renders it through `dangerouslySetInnerHTML`".

### Known Threat Patterns for the stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Stored/reflected XSS via ingested chat/mail/drop content reaching a sink | Tampering | DOMPurify sanitize (existing) + SEC-02 traceability guard (this phase) so the boundary cannot silently drift during Phases 8-10 churn |
| Sanitizer bypass by sink-provenance spoof (naming a function `sanitizedHtml`) | Elevation of privilege (code exec in webview) | D-07's module-allowlist + D-08's explicit pair registration — name-pattern matching rejected precisely because it is spoofable |
| Path traversal via settings-driven inbox root | Tampering | `resolve_inside_vault` lexical containment (inbox.rs:858 pattern reused for the exclusion root) |

## Sources

### Primary (HIGH confidence)
- In-repo source-of-truth files read verbatim this session: `src-tauri/src/skill_host/store.rs`, `src-tauri/src/skill_host/fs.rs`, `src-tauri/src/jobs.rs`, `src-tauri/src/dot_sync.rs`, `src-tauri/src/evidence_binder.rs`, `src-tauri/src/terminal/mod.rs`, `src-tauri/src/paths.rs`, `src-tauri/src/vault.rs`, `src-tauri/src/inbox.rs`, `src-tauri/src/inbox_settings.rs`, `src-tauri/src/vault_watcher.rs`, `src-tauri/src/inbox_watcher.rs`, `src-tauri/src/scratchpad_watcher.rs` (grep-verified shape), `src-tauri/src/ops_catalog/watcher.rs` (grep-verified shape), `src-tauri/src/terminal_hooks.rs` (grep-verified shape), `src/components/EditorPane.tsx`, `src/components/EditorPane.test.tsx`, `src/components/drafts/DraftsPane.tsx`, `src/components/ScratchpadPane.tsx`, `src/components/InlineDocumentEditor.tsx`, `src/components/binaryViewers/HwpxViewer.tsx`, `src/lib/markdown.ts`, `src/lib/scratchpad.ts`, `src/lib/diagram/richText.ts`, `src/lib/documentIndex.ts` (grep-verified lines), `src/components/Sidebar.tsx`, `package.json`, `Makefile`, `src-tauri/tauri.conf.json`, `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, `.planning/STATE.md`, `.planning/codebase/CONCERNS.md`
- [std::sync::Mutex — Poisoning](https://doc.rust-lang.org/std/sync/struct.Mutex.html) — fetched this session: poisoning semantics, `PoisonError::into_inner`, `clear_poison()` (1.77.0), official recovery example

### Secondary (MEDIUM confidence)
- None — all claims are in-repo or std-doc.

### Tertiary (LOW confidence)
- None.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new packages; everything verified against package.json/Cargo usage in-repo
- Architecture: HIGH — every lock site, sink, call site, and constant read verbatim with line citations; only cross-module frontend state (Open Question 3) is unverified
- Pitfalls: HIGH — Pitfalls 1-7 each derive from a verbatim-read fact (settings-driven root, test-file literal, dynamic import, inline sanitize, process-global test hazard, per-BU growth, Vec-shaped paths)

**Research date:** 2026-09-05
**Valid until:** 2026-10-05 (stable codebase-internal phase; refresh only if Phases 8-10 land first and move the cited lines)

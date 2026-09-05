# Phase 7: Guardrails Before Churn - Pattern Map

**Mapped:** 2026-09-05
**Files analyzed:** 19 (13 modified Rust/TS, 1 new script, 1 Makefile edit, 4 frontend edits)
**Analogs found:** 19 / 19

> Correction to RESEARCH.md assumption A1: the crate has **no `log` or `tracing`
> dependency**. The de-facto warn idiom is `eprintln!("[<module>] ...")`
> (verified: `hub_client/mod.rs:127`, `ops_catalog/watcher.rs:91`,
> `maru_migration.rs:38-64`). D-01's single warn line should use this idiom
> (e.g. `eprintln!("[jobs] JOBS_LOCK was poisoned; recovering guard")`), not
> `log::warn!`.

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src-tauri/src/skill_host/store.rs` | service (guard fn) | concurrency | `src-tauri/src/skill_host/fs.rs:212-217` (`test_maru_home_lock`) | exact |
| `src-tauri/src/jobs.rs` | service (guard fn) | concurrency | `jobs.rs:95-100` own shape + fs.rs idiom | exact |
| `src-tauri/src/dot_sync.rs` | service (inline guard) | concurrency | `dot_sync.rs:347-351` own shape + fs.rs idiom | exact |
| `src-tauri/src/evidence_binder.rs` | service (inline guard x2) | concurrency | `evidence_binder.rs:265-267,653-655` + fs.rs idiom | exact |
| `src-tauri/src/terminal/mod.rs` | service (command + helper) | concurrency | `terminal/mod.rs:873-879,900-908` own sites + fs.rs idiom | exact |
| `src-tauri/src/paths.rs` | utility | transform (path predicate) | `vault.rs:219-240` (`ScanFilter::is_excluded_path` component loop) + `paths.rs:42-57` | exact |
| `src-tauri/src/vault.rs` | service (scan policy) | file-I/O / batch | `vault.rs:249-269` (`excluded_scratchpad_root` + rel-prefix) | exact |
| `src-tauri/src/vault_watcher.rs` | service (event-driven) | event-driven | own `relevant_path` filter at `vault_watcher.rs:21-43,89-97` | exact |
| `src-tauri/src/inbox_watcher.rs` | service (event-driven) | event-driven | `vault_watcher.rs` drain-thread shape; per-path loop at `inbox_watcher.rs:128` | role-match |
| `src-tauri/src/scratchpad_watcher.rs` | service (event-driven) | event-driven | own `relevant_path` at `:59-76` + drain filter at `:209-217` | exact |
| `src-tauri/src/ops_catalog/watcher.rs` | service (event-driven) | event-driven | `is_catalog_relevant` gate at `:69` | exact |
| `src-tauri/src/terminal_hooks.rs` | service (event-driven) | event-driven | filename gate at `:207-211` | exact |
| `scripts/check-dom-sanitizer.mjs` | utility (build guard) | static scan | `scripts/check-select-chrome.mjs` (whole file) | exact |
| `Makefile` | config | build | `Makefile:174-176` (`check-select-chrome` target) + `:354-355` (`verify`) | exact |
| `src/lib/documentIndex.ts` | utility/model (frontend) | transform | own `BuiltInDocumentView` union `:5` + `matchesBuiltInView` `:267-284` | exact |
| `src/components/Sidebar.tsx` | component | render | own `builtInViews` memo `:88-97` | exact |
| `src/App.tsx` | component | render | own `builtInDocumentViewCounts` memo `:1301-1309` | exact |
| `src/lib/workspaceStore.ts` | store (frontend) | CRUD (persisted state) | `pruneCustomDocumentFiltersInState` `:224-240` | exact |
| `src/components/binaryViewers/HwpxViewer.tsx` | component | render + transform | module-level helper pattern from `src/lib/diagram/richText.ts:20-26` | exact |

## Pattern Assignments

### PERF-03: Lock poison recovery (6 files)

**Analog:** `src-tauri/src/skill_host/fs.rs:211-217` (the only in-tree recovery idiom today, test-only)

```rust
// fs.rs:211-217 — the recovery shape every guard site copies
pub(crate) fn test_maru_home_lock() -> MutexGuard<'static, ()> {
    MARU_TEST_HOME_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
```

Per-site current shapes to replace (each gets the idiom above + one
`eprintln!("[<module>] ...")` warn + a D-03 justification comment at the
`static` declaration):

**`skill_host/store.rs:45` + `:2618-2623`** — OnceLock guard fn:
```rust
static REGISTRY_LOCK: OnceLock<Mutex<()>> = OnceLock::new();          // :45
fn registry_guard() -> Result<MutexGuard<'static, ()>, String> {      // :2618
    REGISTRY_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "skills_registry_lock_poisoned".to_string())   // :2622
}
```
Justification skeleton: the unit mutex guards the on-disk skill registry, which
is re-read from disk after acquisition — the in-memory `()` carries no invariant.
Note the guard fn returns `Result`; recovery converts the error path to
`Ok(guard)`.

**`jobs.rs:16` + `:95-100`** — identical OnceLock guard-fn shape
(`jobs_guard()`, error `"jobs_lock_poisoned"`). Guards `.maru/jobs.json`,
re-read after acquisition (see `load_jobs` at `:106-115`).

**`dot_sync.rs:14` + `:347-351`** — inline acquisition (no guard fn):
```rust
let _guard = DOT_ACTION_LOCK
    .get_or_init(|| Mutex::new(()))
    .lock()
    .map_err(|_| "dot_action_lock_poisoned".to_string())?;
```
Serializes dot CLI invocations; guarded state is the external dotfiles repo on
disk, not in-memory invariants.

**`evidence_binder.rs:24` + `:265-267` and `:653-655`** — plain `static Mutex<()>`
(not OnceLock), two inline acquisitions, both `.map_err(|_| "evidence_binder_lock_poisoned")`.
Guards `.maru/binder/` state read from disk. Do **not** touch
`INSPECTION_CACHE` at `:25-26` (not one of the six).

**`terminal/mod.rs:873-879` (killer) and `:900-908` (registry)** — per-session
locks, struct fields not statics:
```rust
// :873-879 — poisoned killer currently latches `closing` back and errors
let mut killer = match session.killer.lock() {
    Ok(killer) => killer,
    Err(_) => {
        session.closing.store(false, Ordering::Release);
        return Err("terminal_killer_poisoned".to_string());
    }
};
// :900-908 — registry lookup
state.sessions.lock().map_err(|_| "terminal_registry_poisoned".to_string())?
```
D-02: on recovery, keep `closing` latched semantics identical to the success
path — existing PTY sessions stay and new commands keep working. `killer` is
`Arc<Mutex<ChildKiller>>` wrapping a process handle; the killer value survives
poisoning (only the guard flag is tainted), which is the per-lock justification.
Note `:889` already recovers silently from a poisoned registry with
`if let Ok(mut guard) = ...` — the recovery philosophy already exists at this
site.

**Warn idiom (D-01), verified convention:**
```rust
// ops_catalog/watcher.rs:91 / hub_client/mod.rs:127 shape
eprintln!("[terminal] session registry lock was poisoned; recovering guard");
```

**Test harness analog:** fs.rs's `BundleTestHome` (`:224-232`) shows the
fixture pattern for process-global locks (guard field, drop order). Per
RESEARCH Pitfall 5, prefer shape (b): factor recovery into a pure helper
(e.g. `fn recover_guard<T>(result: LockResult<T>, name: &str) -> MutexGuard<T>`)
and unit-test it on a fresh local `Mutex`; terminal locks can be tested
against a locally built `TerminalState` with no global pollution.

---

### PERF-04: Watcher dispatch-time pruning (6 files: 1 predicate + 5 consumers)

**Analog for the predicate:** `vault.rs:219-240` component-matching loop +
`paths.rs:42-57` `GENERATED_DIRS` constant it must live beside (D-05).

```rust
// vault.rs:226-234 — the matching loop the new predicate mirrors
for component in rel.components() {
    let Component::Normal(value) = component else { continue };
    let name = value.to_string_lossy();
    if generated_dirs.iter().any(|dir| name == *dir) {
        return true;
    }
```

**New predicate shape** (root-agnostic, absolute path, per D-04/Pitfall 7 —
must NOT take a root like `ScanFilter::is_excluded_path` does, because
ops_catalog watches many roots):

```rust
// New in src-tauri/src/paths.rs, beside GENERATED_DIRS:
/// True when any component of `path` is a generated-directory name.
/// Root-agnostic: consumers watch multiple roots, so this matches on
/// absolute path components (PERF-04).
pub fn is_under_generated_dir(path: &Path) -> bool {
    path.components().any(|component| {
        matches!(component, Component::Normal(name)
            if GENERATED_DIRS.contains(&name.to_string_lossy().as_ref()))
    })
}
```
Test-module analog: `paths.rs:129-195` (`mod tests` colocated, plain
`#[test]` fns, `Path::new("/work/...")` literals — no TempDir needed for a
pure predicate; include the mixed-component case).

**Consumer insertion points** (each is a per-path filter, NOT whole-event drop):

- `vault_watcher.rs:89-97` — drain thread already filters per path:
  ```rust
  let mut rel_paths: Vec<String> = paths
      .into_iter()
      .filter(|path| relevant_path(path, &root_for_thread))
      .filter_map(|path| { ... strip_prefix ... })
      .collect();
  ```
  Add `.filter(|path| !paths_mod::is_under_generated_dir(path))` ahead of
  `relevant_path`. Note `relevant_path` (`:21-43`) hardcodes only
  `.git|node_modules|target|dist|build` — the new predicate replaces that
  hand-rolled list's first arm (keep the `.maru/cache`, `.maruignore`, and
  extension arms).
- `inbox_watcher.rs:128` — callback loops `for path in event.paths` with
  `continue` filters (`:129-137`); add generated-dir `continue` in the same
  loop body.
- `scratchpad_watcher.rs:209-217` — same drain-filter shape as vault_watcher
  (`.filter(|path| relevant_path(path, &root_for_thread))`); insert alongside.
- `ops_catalog/watcher.rs:66-71` — callback takes `event.paths.into_iter().next()`
  (`:66`) then gates on `is_catalog_relevant(&path, &root_clone)` (`:69`); add
  the generated-dir check next to that gate.
- `terminal_hooks.rs:207-211` — callback loops `for path in event.paths` and
  `continue`s on filename mismatch (`:208-210`); add generated-dir `continue`.

Existing watcher test analogs to extend: `vault_watcher.rs:131-156` (pure
`relevant_path` tests), `ops_catalog/watcher.rs:214-242`
(`relevant_*` tests).

---

### SEC-02: Static sanitizer guard (new `scripts/check-dom-sanitizer.mjs` + Makefile)

**Analog:** `scripts/check-select-chrome.mjs` (full file, 77 lines).

**Imports / collector pattern** (`:12-29`):
```javascript
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const srcRoot = join(dirname(fileURLToPath(import.meta.url)), "../src");

function collectCssFiles(dir) {           // -> collectTsxFiles: skip node_modules,
  ...                                   // PLUS *.test.* / __tests__ (Pitfall 2)
}
```

**Violation accumulation + exit** (`:46,71-77`):
```javascript
const violations = [];
...
if (violations.length > 0) {
  console.error(
    `select-chrome: ...:\n  ${violations.join("\n  ")}`,
  );
  process.exit(1);
}
console.log("select-chrome: all select rules preserve the base chevron");
```

**Makefile wiring analog** (`Makefile:174-176` target + `:354-355` verify chain):
```make
.PHONY: check-select-chrome
check-select-chrome: ## Static guard: select rules must not wipe the base chevron via background shorthand
	$(NODE) scripts/check-select-chrome.mjs
```
Add `check-dom-sanitizer` adjacent (RESEARCH Open Question 2 recommendation:
same cost class as `check-select-chrome`) and append it to the `verify`
prerequisite list at `:355`.

**Sink / helper inventory the guard must pass day one** (all verified this
session):

| Sink | Provenance |
|------|-----------|
| `EditorPane.tsx:1041` `dangerouslySetInnerHTML={previewMarkup}` | `previewMarkup = useMemo(() => ({ __html: previewHtml }), [previewHtml])`; `previewHtml` via `decoratePreviewHtml` (own export); `previewBaseHtml` assigned inside `import("../lib/markdown").then(({renderMarkdown}) => ...)` at `:328-330` — the narrow dynamic-import pattern the guard must recognize (Pitfall 3). Register `["src/components/EditorPane.tsx", "decoratePreviewHtml"]` per D-08. |
| `DraftsPane.tsx:968,1033` | `renderMarkdown` imported from `../../lib/markdown` (`:44`) — allowlisted module. |
| `ScratchpadPane.tsx:1360` | `renderScratchpadMarkdown` imported from `../../lib/scratchpad` (`:57`) — allowlisted. |
| `InlineDocumentEditor.tsx:228` | `renderMarkdown` imported from `../lib/markdown` (`:13`) — allowlisted. |
| `HwpxViewer.tsx:95` `dangerouslySetInnerHTML={{ __html: sanitizedHtml }}` | inline `DOMPurify.sanitize` in `useEffect` (`:37-40`) — needs extraction (below). |

**Allowlisted helper origins (D-07 pin list):**
- `src/lib/markdown.ts:50-66` — `export function renderMarkdown` → `DOMPurify.sanitize(html, { ADD_ATTR: ["target", "data-wikilink"] })` (fail-open to escaped plain text on error, `:61-66`).
- `src/lib/scratchpad.ts:187-...` — `export function renderScratchpadMarkdown` → `DOMPurify.sanitize(renderMarkdown(...), { FORBID_TAGS: [...] })`.
- `src/lib/diagram/richText.ts:20-26` — `export function sanitizeHtml` → `DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, USE_PROFILES: { html: true } })` (no current sink; keep allowlisted).
- `src/components/binaryViewers/HwpxViewer.tsx` — after extraction.

**Extraction analog (Pitfall 4):** module-level exported helper, same shape as
`richText.ts:15-26`:
```typescript
// HwpxViewer.tsx, module level (mirrors richText.ts sanitizeHtml):
export function sanitizeHwpxPreviewHtml(html: string): string {
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}
```
Then `useEffect` calls `sanitizeHwpxPreviewHtml(preview.html)`, and the guard
registers `["src/components/binaryViewers/HwpxViewer.tsx", "sanitizeHwpxPreviewHtml"]`.

**Red-then-green proof mechanics:** per STATE.md GATE-02 precedent — the
Makefile wiring commit must be preceded by a deliberate-break run (temporary
fixture sink file added, guard run, exit 1 observed, fixture removed).

---

### PERF-06: Inbox index exclusion (`vault.rs`) + frontend view removal

**Analog:** `vault.rs:249-269` — the scratchpad exclusion pair:
```rust
// :249-257 — fail-open resolver
fn excluded_scratchpad_root(vault: &Path) -> Option<PathBuf> {
    assert_scratchpad_workspace_access(vault).ok()?;
    resolve_scratchpad_root(vault).ok()
}
// :259-269 — rel-prefix form for cache filtering
fn excluded_scratchpad_rel_prefix(vault: &Path) -> Option<String> {
    let root = excluded_scratchpad_root(vault)?;
    let rel = root.strip_prefix(vault).ok()?;
    let rel = rel.to_string_lossy().replace('\\', "/");
    if rel.is_empty() { return None; }
    Some(format!("{rel}/"))
}
```

**Settings-driven root resolution analog** (Pitfall 1 — do NOT hardcode
`"inbox/"`): `inbox.rs:853-867` + `inbox_settings.rs:19`:
```rust
// inbox.rs:858 — resolve exactly the way the inbox scanner does
let inbox_root = resolve_inside_vault(&vault.to_string_lossy(), settings.inbox_root.as_str())?;
```
with `DEFAULT_INBOX_ROOT: &str = "inbox/downloads"` (`inbox_settings.rs:19`).
The new `excluded_inbox_root` should mirror `excluded_scratchpad_root`'s
fail-open shape (`.ok()?`-style) and be collapsed with it into the shared
non-document-roots list (D-09/D-10: lives in `vault.rs`, NOT `paths.rs`).

**Three call sites to widen** (each currently references only the scratchpad
root; all three become consumers of the shared list):
- `scan_vault` walk filter — `:350-352` (`if scratchpad_root.as_deref() == Some(path) { return false }`) beside `:353` `is_excluded_path`.
- `scan_vault_paths` containment — `:456-461` (`path.starts_with(root)`).
- `read_vault_cache` rel-prefix filter — `:493-504` (prefix filter with the
  stale-cache self-heal comment at `:493-494`).

**Test analogs:** `vault.rs:1222-1256` — twin these two tests for inbox:
```rust
#[test]
fn scan_vault_skips_scratchpad_root() {          // :1222-1234
    let tmp = TempDir::new().unwrap();
    write_file(root, "scratchpad/ideation/seeds/idea.md", "# Idea\n");
    ...
}
#[test]
fn read_vault_cache_drops_stale_scratchpad_entries() {   // :1236-1256
    // builds a stale cache via write_vault_cache, asserts read filters it
}
```
Add the `scan_vault_paths` containment twin (no existing direct analog — new
test). Regression watch: existing `cargo test --lib inbox` coverage must stay
green (Inbox pane still lists pending/drop items).

**Frontend removal analogs (three coordinated edits):**
- `src/lib/documentIndex.ts:5` — drop `"inbox"` from `BuiltInDocumentView`
  union and delete `case "inbox":` at `:273-274` in `matchesBuiltInView`.
- `src/components/Sidebar.tsx:88-97` — delete the `{ view: "inbox" as const, icon: <Inbox ... /> }` entry from `builtInViews`.
- `src/App.tsx:1301-1309` — delete the `inbox:` line from
  `builtInDocumentViewCounts` (its `Record<BuiltInDocumentView, number>` type
  self-updates once the union narrows).
- **Persisted-filter reset (Open Question 3):** analog is
  `workspaceStore.ts:224-240` `pruneCustomDocumentFiltersInState` — extend the
  same prune pass to reset a persisted `{ kind: "view", view: "inbox" }` filter
  to `{ kind: "all" }` (fail-open). Update `outlinePaneStore.test.ts:168,176`
  and `documentIndex.test.ts:111` references.

## Shared Patterns

### Process-global unit-mutex guard shape
**Source:** every lock site follows `static(OnceLock)<Mutex<()>>` +
`get_or_init` (or direct `.lock()` for plain statics). Guard fns return
`Result<MutexGuard<'static, ()>, String>` (`store.rs:2618`, `jobs.rs:95`);
commands acquire inline (`dot_sync.rs:348`, `evidence_binder.rs:265,653`,
`terminal/mod.rs:873,902`). Recovery idiom at all sites: fs.rs:216
`unwrap_or_else(|poisoned| poisoned.into_inner())`.

### Warn logging (D-01)
**Source:** `eprintln!("[<module>] ...")` — the crate's only logging
convention (no `log`/`tracing` deps; verified by grep). One line per recovery,
prefix matches the module's existing tags (`[catalog-watcher]`, `[hub_client]`).

### Component-wise generated-dir matching
**Source:** `vault.rs:226-234` + `GENERATED_DIRS` at `paths.rs:42-57`.
Exact-name component equality against the SSOT list; no globs/regex. The new
predicate is the root-agnostic generalization.

### Fail-open `Option<PathBuf>` exclusion resolvers
**Source:** `vault.rs:254-257`. Resolution trouble keeps listing instead of
erroring; rel-prefix form carries the trailing slash and `\\`→`/` replacement
(`:261-268`).

### Watcher drain/debounce architecture
**Source:** `vault_watcher.rs:77-111`, `inbox_watcher.rs:177-197`,
`scratchpad_watcher.rs:151-234`. mpsc channel → drain thread coalesces with a
quiet-window deadline (`Duration::from_millis(120|150|DEBOUNCE_MS)`) → per-path
filter → sort+dedup → single emit. Pruning inserts at the per-path filter
stage before emit; whole-event dropping is wrong (Pitfall 7).

### `check-*.mjs` guard family
**Source:** `check-select-chrome.mjs`. ESM, `node:fs`/`node:path` only,
recursive collector skipping `node_modules`, regex scan, violations array →
`console.error` + `process.exit(1)`, success `console.log`. Makefile: one
`.PHONY` target per guard + entry in the `verify` chain at `:355`.

### DOMPurify helper export surface
**Source:** `markdown.ts:50`, `scratchpad.ts:187`, `richText.ts:20`. Named
exports, doc comment stating the sanitization contract, DOMPurify called
inside the helper (never at the sink). Sinks pass `{ __html: <helper output> }`
directly.

### Rust test conventions
**Source:** colocated `#[cfg(test)] mod tests` (e.g. `paths.rs:129`,
`vault.rs:1222+`, `vault_watcher.rs:131`); `TempDir` + `write_file` fixture
helpers in `vault.rs` tests; pure predicates tested with `Path::new` literals,
no fixture dirs.

## No Analog Found

None — every file in scope has an exact in-tree analog. (The closest to
"new ground" is `scripts/check-dom-sanitizer.mjs`, but the
`check-select-chrome.mjs` idiom covers 100% of its structure; only the
tracing rule itself is new logic.)

## Metadata

**Analog search scope:** `src-tauri/src/` (locks, watchers, paths, vault,
inbox), `scripts/check-*.mjs`, `Makefile`, `src/lib/`, `src/components/`
**Files scanned:** 30+ (all phase-touched files plus their analogs read verbatim)
**Pattern extraction date:** 2026-09-05

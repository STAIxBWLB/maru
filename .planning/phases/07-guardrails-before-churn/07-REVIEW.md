---
phase: 07-guardrails-before-churn
reviewed: 2026-09-05T10:35:00Z
depth: standard
files_reviewed: 29
files_reviewed_list:
  - Makefile
  - scripts/check-dom-sanitizer.behavior.test.ts
  - scripts/check-dom-sanitizer.mjs
  - scripts/check-dom-sanitizer.test.ts
  - src-tauri/src/dot_sync.rs
  - src-tauri/src/evidence_binder.rs
  - src-tauri/src/inbox_watcher.rs
  - src-tauri/src/jobs.rs
  - src-tauri/src/lib.rs
  - src-tauri/src/lock_recovery.rs
  - src-tauri/src/ops_catalog/watcher.rs
  - src-tauri/src/paths.rs
  - src-tauri/src/scratchpad_watcher.rs
  - src-tauri/src/skill_host/store.rs
  - src-tauri/src/terminal/mod.rs
  - src-tauri/src/terminal_hooks.rs
  - src-tauri/src/vault.rs
  - src-tauri/src/vault_watcher.rs
  - src/App.tsx
  - src/components/Sidebar.tsx
  - src/components/binaryViewers/HwpxViewer.tsx
  - src/lib/documentIndex.test.ts
  - src/lib/documentIndex.ts
  - src/lib/i18n/locales/en.ts
  - src/lib/i18n/locales/ko.ts
  - src/lib/outlinePaneStore.test.ts
  - src/lib/outlinePaneStore.ts
  - src/lib/workspaceStore.test.ts
  - src/lib/workspaceStore.ts
findings:
  critical: 1
  warning: 1
  info: 4
  total: 6
status: issues_found
---

# Phase 07: Code Review Report

**Reviewed:** 2026-09-05T10:35:00Z
**Depth:** standard
**Files Reviewed:** 29
**Status:** issues_found

_Note on role dispatch: this review was produced under the generic-agent workaround (typed gsd-code-reviewer dispatch unavailable in this runtime); the role definition at `~/.claude/agents/gsd-code-reviewer.md` was read and followed, including the REVIEW.md format and severity classification._

## Summary

Reviewed the five PERF/SEC guardrail landings: the SEC-02 DOM-sanitizer static
guard (`scripts/check-dom-sanitizer.mjs` + two pin tests + Makefile wiring),
PERF-03 poison recovery (`lock_recovery.rs::recover_guard` across six locks),
PERF-04 generated-dir pruning (`paths.rs::is_under_generated_dir` across five
watchers), and PERF-06 inbox-root document-index exclusion plus the frontend
built-in Inbox view removal (vault.rs, documentIndex.ts, Sidebar.tsx, App.tsx,
workspaceStore.ts prune, i18n key removal).

The Rust work is solid: lock justifications are co-located per D-03, the
recovery contract is correctly scoped to unit mutexes with disk-derived state,
the shared predicate is exact-name (no prefix over-match) and has direct
unit tests, and the three PERF-06 exclusion call sites share one derivation
with consistent fail-open semantics. The frontend removal is type-consistent
(Record<BuiltInDocumentView, number> shrinks cleanly) and the persisted-filter
prune is a genuine fail-open reset covered by a dedicated test.

One critical defect undermines the SEC-02 gate: the guard matches sinks
line-by-line, so a multi-line `dangerouslySetInnerHTML` attribute is never
seen and the guard passes an untraced sink (reproduced live — see CR-01).
One warning: the watcher prune regresses the single-root watchers when the
watched root's own directory name collides with GENERATED_DIRS (the old code
stripped the root; the new predicate does not).

## Verification performed

- `pnpm vitest run` on the five touched/new TS test files: 54 passed.
- `cargo test --lib -- paths:: lock_recovery vault_watcher scratchpad_watcher inbox_watcher terminal_hooks ops_catalog vault::tests`: 107 passed, 0 failed.
- `pnpm typecheck`: exit 0.
- `node scripts/lint-i18n.mjs`: 3738 keys in parity (inbox key removal kept ko/en symmetric).
- Live red/green probes against `scripts/check-dom-sanitizer.mjs` (single-line untraced sink fails closed as claimed; multi-line untraced sink passes — CR-01).

## Critical Issues

### CR-01: Sanitizer guard fails open on multi-line `dangerouslySetInnerHTML` sinks

**File:** `scripts/check-dom-sanitizer.mjs:178-188`
**Issue:** The sink extraction iterates `source.split("\n")` and matches each
line independently. Both patterns require `dangerouslySetInnerHTML={{` and
`__html:` (and the closing `}}`) on the *same line*. Any JSX formatted across
lines — which Prettier itself produces once the expression exceeds the print
width — is never matched, so `sinkCount` never increments and the file passes
without any tracing. Reproduced live: dropping the following into `src/` makes
the guard print "all 6 dangerouslySetInnerHTML sinks trace" and exit 0:

```tsx
export function Probe({ untrustedInput }: { untrustedInput: string }) {
  return (
    <div
      dangerouslySetInnerHTML={{
        __html: untrustedInput,
      }}
    />
  );
}
```

The guard's stated contract — "every dangerouslySetInnerHTML sink in src/ must
trace to a DOMPurify-backed helper" — and its own header comment ("Everything
else fails closed with exit 1") are both violated by formatting alone. This is
the exact Phase 8-10 churn scenario the gate exists to catch: a developer adds
a sink, Prettier wraps it, the build gate stays green. The behavior test only
proves fail-closed for the single-line shape, so the regression is invisible
to CI.

**Fix:** Fail closed on unparseable shapes instead of silently skipping them.
Minimal change that keeps the line-based idiom: count raw occurrences and
reconcile.

```js
// after the per-line scan, per file:
const rawOccurrences = (source.match(/dangerouslySetInnerHTML/g) ?? []).length;
if (rawOccurrences > matchedInThisFile) {
  violations.push(`${rel}: dangerouslySetInnerHTML occurrences (${rawOccurrences}) exceed traced sinks (${matchedInThisFile}) — multi-line or unrecognized sink shape must be traced explicitly`);
}
```

(Comments and test files are already excluded or asserted-on, so raw-count
reconciliation only fires on real, unshaped sinks.) A stronger fix is a
multiline regex with the `s` flag plus balanced-brace extraction over the
whole source, but the occurrence reconciliation preserves the no-AST design
decision (D-07) at a fraction of the complexity.

## Warnings

### WR-01: Single-root watchers silently die when the watched root's own name collides with GENERATED_DIRS

**File:** `src-tauri/src/vault_watcher.rs:25-26` (also `scratchpad_watcher.rs:211`, `inbox_watcher.rs:129`, `terminal_hooks.rs:208`)
**Issue:** `is_under_generated_dir` matches on *all* absolute path components,
including the watch root itself (`paths.rs:59-65` documents this as
"root-agnostic on purpose" for the multi-root ops_catalog case). But
`vault_watcher::relevant_path` previously stripped the root before checking
(`rel.components()`), so this phase is a behavior regression for the
single-root watchers: if the vault directory itself is named `dist`, `build`,
`target`, `.cache`, `.context`, `.omc`, `.omx`, `__pycache__`, etc., every
event path contains that component and the watcher prunes 100% of events —
the documents pane silently stops refreshing, with no error anywhere. The
scratchpad and inbox roots are settings-driven (`resolve_scratchpad_root`,
`InboxSettings.inbox_root`), so a user pointing either at a directory named
`dist`/`build` gets the same silent dead watcher. The trigger is uncommon but
the failure mode is silent and total.

**Fix:** Strip the known root before applying the predicate in the
single-root watchers:

```rust
// vault_watcher.rs::relevant_path — rel is already computed above
if crate::paths::is_under_generated_dir(&rel) {
    return false;
}
```

`scratchpad_watcher.rs` and `inbox_watcher.rs` can do the same via
`strip_prefix(root)`; `ops_catalog/watcher.rs` should keep the absolute-path
check (genuinely multi-root) — optionally by passing a root-stripped path for
the single-root BU surfaces. At minimum, add a test pinning that a root named
`dist` still dispatches events.

## Info

### IN-01: Self-referential leftover sentence in recover_guard doc comment

**File:** `src-tauri/src/lock_recovery.rs:30-33`
**Issue:** The doc says "emits one warn line carrying the module tag and lock name (see the module docs for the exact shape)" — the parenthetical points back at the very module docs it sits in, a leftover from an edit. Harmless but confusing for the next reader of the D-03 contract.
**Fix:** Replace the parenthetical with the actual shape, e.g. `[{module_tag}] {lock_name} was poisoned; recovering guard`.

### IN-02: Guard import resolution breaks on Windows path separators

**File:** `scripts/check-dom-sanitizer.mjs:71-82`
**Issue:** `resolveAllowlistedModule` builds candidates with `join`/`normalize`, which emit backslashes on Windows; the pinned allowlist uses forward slashes, so no import ever resolves and every import-traced sink fails closed (exit 1) on a Windows dev box. Acceptable while Maru is macOS-only (Tauri + Homebrew), but it is a trap if the guard is ever run in Windows CI.
**Fix:** Normalize the candidate before lookup: `const base = normalize(join(dirname(fileRel), specifier)).split(sep).join("/");` (or `path.posix.normalize` on the already-relative input).

### IN-03: Behavior-test probe file can be left behind on test crash

**File:** `scripts/check-dom-sanitizer.behavior.test.ts:15-18,30-38`
**Issue:** The test writes `src/__dom_sanitizer_probe__.tsx` into the live tree and relies on `afterEach` for cleanup. If the vitest process is killed mid-test (SIGKILL, power loss), the probe persists and every subsequent `make verify` fails with a violation naming `__dom_sanitizer_probe__.tsx` — a confusing red herring far from the cause.
**Fix:** Write the probe to a temp directory and run the guard with an optional root override (the script already centralizes `srcRoot`), or have the guard ignore files matching a `__dom_sanitizer_probe__` prefix with an explicit comment.

### IN-04: Duplicated built-in-view ordering between two sources

**File:** `src/lib/documentIndex.ts:10-14` vs `src/components/Sidebar.tsx:87-95`
**Issue:** `BUILT_IN_DOCUMENT_VIEWS` (new runtime list for the prune) and Sidebar's local `builtInViews` array are two hand-maintained lists of the same views; nothing ties switcher order to the prune list, so a future reorder or addition can drift silently. The `BuiltInDocumentView` type catches removal at compile time but not order/addition asymmetry between the two.
**Fix:** Have Sidebar derive its entries from `BUILT_IN_DOCUMENT_VIEWS` (icon map keyed by view), making the document-index module the single source.

---

_Reviewed: 2026-09-05T10:35:00Z_
_Reviewer: gsd-code-reviewer (generic-agent workaround dispatch)_
_Depth: standard_

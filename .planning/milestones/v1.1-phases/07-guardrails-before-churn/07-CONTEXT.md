# Phase 7: Guardrails Before Churn - Context

**Gathered:** 2026-09-05
**Status:** Ready for planning

<domain>
## Phase Boundary

Four guardrails land before the milestone's later churn stresses them: the six
named process-global locks recover from poisoning instead of bricking their
feature (PERF-03), recursive filesystem watchers stop emitting events for
`GENERATED_DIRS` subtrees (PERF-04), `make verify` gains a static guard that
fails when a `dangerouslySetInnerHTML` value in `src/` does not trace to a
DOMPurify-backed helper (SEC-02), and the document index excludes the inbox
root across all three exclusion-carrying paths (PERF-06). This phase changes no
user-facing capability; it changes how existing surfaces behave after failure
and under load.

</domain>

<decisions>
## Implementation Decisions

### Lock poison recovery (PERF-03)

- **D-01:** Recovery visibility is a single `warn`-level log line at the
  recovery point; the user surface shows nothing. Recovery is normal operation,
  not an event the user acts on.
- **D-02:** When the terminal registry or killer lock is recovered from
  poisoning, existing PTY sessions are kept and new commands against them keep
  working. — **Reversibility:** reversible — only the panic-path behavior
  changes if revisited.
- **D-03:** Each lock's recorded justification for why recovery is safe lives
  as a co-located code comment at the lock's `static` declaration / guard
  acquisition site (same position as the `skill_host/fs.rs:216` precedent),
  not in a central document.

### Watcher pruning (PERF-04)

- **D-04:** Pruning filters at event-dispatch time: events whose path falls
  under `GENERATED_DIRS` are dropped when they arrive. Registration-time
  exclusion is rejected because directories created after registration would
  stay unpruned until restart. — **Reversibility:** costly — switching strategy
  later means reworking the registration path of all five watcher modules.
- **D-05:** The shared matching predicate is a common helper in
  `src-tauri/src/paths.rs`, next to `GENERATED_DIRS` itself — the Phase 2 SSOT
  precedent: policy in one place, consumers reference it.
- **D-06:** All five recursive-watch sites are in scope: `vault_watcher.rs`,
  `inbox_watcher.rs`, `scratchpad_watcher.rs`, `ops_catalog/watcher.rs`, and
  `terminal_hooks.rs` — the ROADMAP success criterion's wording ("a recursive
  filesystem watcher") is generic, and the scope is fixed here so the plan
  does not re-litigate it.

### Sanitizer guard (SEC-02)

- **D-07:** The guard judges tracing by a module allowlist: the list of
  modules that export DOMPurify-backed helpers is pinned in the guard script,
  and a sink's `__html` value must reference an identifier imported from an
  allowlisted module. Name-pattern matching is rejected (spoofable by naming)
  and AST parsing is rejected (leaves the `scripts/check-*.mjs` idiom the
  requirement mandates).
- **D-08:** Local aliases (e.g. `sanitizedHtml` in `HwpxViewer`) are not
  followed. The direct reference must pass; a file-local helper is registered
  in the guard as an explicit `file + function name` pair.

### Inbox index exclusion (PERF-06)

- **D-09:** The existing scratchpad exclusion is widened into a shared
  "non-document roots" list with `inbox/` added, referenced by all three call
  sites (`scan_vault`, `scan_vault_paths`, the `read_vault_cache` rel-prefix
  filter). A future non-document root is a one-line change. — **Reversibility:**
  costly — splitting the list back apart touches all three call sites again.
- **D-10:** The shared list constant lives in `src-tauri/src/vault.rs` beside
  the scan functions, not in `paths.rs`: it is document-index policy owned by
  the scan domain, while `paths.rs` keeps filesystem-level policy
  (`GENERATED_DIRS`, `ensure_within`).

### Claude's Discretion

- **Lock recovery mechanism per lock** (user delegated): the planner decides
  `into_inner()` vs rebuild-from-disk per lock, bounded by the requirement
  that each lock carries its own justification (D-03) and by REQUIREMENTS.md's
  exclusion of blanket `into_inner()` across invariant-bearing state.
- Guard failure message shape and the deliberate red-then-green proof
  mechanics for the SEC-02 guard (the proof itself is locked by ROADMAP
  success criterion 3).
- Watcher test fixture mechanics and the per-lock poison test harness design.
- DOMPurify helper export surface adjustments needed to make the six existing
  sinks pass under D-07/D-08 without weakening them.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements and goals
- `.planning/ROADMAP.md` §Phase 7 — goal, four success criteria, and the Note
  that the inbox exclusion lives at three call sites, not two
- `.planning/REQUIREMENTS.md` PERF-03, PERF-04, SEC-02, PERF-06 — locked
  requirement text, including the Out-of-Scope exclusions (no blanket
  `into_inner()`, no new lint framework, no `.maruignore` route)
- Issue #309 (PERF-06 source) — measured reference-workspace figures: 11,488
  index entries to about 9,582

### Evidence and prior analysis
- `.planning/codebase/CONCERNS.md` §2 "Global process-wide locks can be
  poisoned into a broken feature" — lock inventory and the `fs.rs` recovery
  idiom precedent
- `.planning/codebase/CONCERNS.md` §2 "The webview renders untrusted
  third-party content" — the six sinks, the four DOMPurify helpers, the CSP
  context, and the "no automated guard" gap this phase closes
- `.planning/codebase/CONCERNS.md` §3 "Recursive filesystem watchers have no
  generated-directory guard" — the five recursive-watch sites and the
  `ops_catalog` per-BU growth note

### Configuration and gates
- `src-tauri/tauri.conf.json` — CSP (context for SEC-02's threat model; the
  CSP change itself is Phase 10 / SEC-01, out of scope here)
- `scripts/check-*.mjs` family — the idiom the SEC-02 guard must follow
- `Makefile` — `verify` target where the SEC-02 guard wires in

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src-tauri/src/skill_host/fs.rs:216` —
  `.unwrap_or_else(|poisoned| poisoned.into_inner())` recovery idiom, the
  shape D-03's justifications sit next to.
- `src-tauri/src/paths.rs:42` — `GENERATED_DIRS` constant (Phase 2 SSOT,
  14-entry union, six consumers); D-05 extends this file with the matching
  predicate.
- `scripts/check-select-chrome.mjs` et al. — plain-node, fail-the-build guard
  idiom the SEC-02 script follows (D-07/D-08 pin its tracing model).

### Established Patterns
- The six locks are `OnceLock<Mutex<()>>` (or plain `static Mutex`) unit
  mutexes; poisoning marks the mutex while the guarded data lives elsewhere —
  which is exactly why per-lock justification (D-03) is required rather than a
  blanket idiom.
- Phase 2 precedent: path/directory policy centralizes in `paths.rs` with
  consumers referencing it; document-domain policy stays in its owning module
  (D-09/D-10 mirror that split).
- Verification culture from Phases 6 and 10: guards are proven by deliberate
  red-then-green breaks, and claims are proven against the artifact that
  actually ships.

### Integration Points
- Lock sites: `src-tauri/src/skill_host/store.rs:45,2619` (REGISTRY_LOCK),
  `src-tauri/src/jobs.rs:16,96` (JOBS_LOCK),
  `src-tauri/src/dot_sync.rs:14,348` (DOT_ACTION_LOCK),
  `src-tauri/src/evidence_binder.rs:24,265,653` (BINDER_WRITE_LOCK),
  `src-tauri/src/terminal/mod.rs:859-877` (terminal registry and killer locks).
- Watcher sites: `src-tauri/src/vault_watcher.rs`, `inbox_watcher.rs`,
  `scratchpad_watcher.rs`, `ops_catalog/watcher.rs`, `terminal_hooks.rs`.
- Sanitizer sinks (6): `src/components/EditorPane.tsx:1041`,
  `drafts/DraftsPane.tsx:968,1033`, `ScratchpadPane.tsx:1360`,
  `InlineDocumentEditor.tsx:228`, `binaryViewers/HwpxViewer.tsx:95`.
- DOMPurify helpers (4): `src/lib/markdown.ts:50`, `src/lib/scratchpad.ts:188`,
  `src/lib/diagram/richText.ts:21`, `HwpxViewer.tsx:37` — the seed of the D-07
  allowlist.
- PERF-06 call sites (3): `scan_vault`, `scan_vault_paths`, and the
  `read_vault_cache` rel-prefix filter in `src-tauri/src/vault.rs`.

</code_context>

<specifics>
## Specific Ideas

- ROADMAP Phase 7 Note (fixed scope input): covering only `scan_vault` and the
  cache filter leaves `scan_vault_paths` able to re-inject inbox rows a full
  scan just pruned — all three call sites are mandatory, and D-09 makes that
  structural rather than conventional.
- PERF-06's regression watch is explicit in the requirement: the Inbox pane
  must still list pending items and drop/auto arrivals, and the Files browser
  plus content search must still resolve `inbox/` paths — the documents pane's
  built-in Inbox view is removed with the rows it listed (locked by ROADMAP
  success criterion 4, not re-decided here).
- The two newer preview surfaces (`InlineDocumentEditor.tsx:228`,
  `ScratchpadPane.tsx:1360`) pass a fresh `{ __html: previewHtml }` literal
  every render, reassigning innerHTML — that memoization defect is a separate
  CONCERNS.md item, out of this phase's scope; the SEC-02 guard must classify
  them by their sanitizer provenance, not reject them.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 07-Guardrails Before Churn*
*Context gathered: 2026-09-05*

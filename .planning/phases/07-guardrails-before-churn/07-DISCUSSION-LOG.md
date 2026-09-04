# Phase 7: Guardrails Before Churn - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-09-05
**Phase:** 07-Guardrails Before Churn
**Areas discussed:** Lock poison recovery, Watcher pruning, Sanitizer guard tracing model, Inbox exclusion list shape

---

## Lock poison recovery (PERF-03)

| Option | Description | Selected |
|--------|-------------|----------|
| Uniform into_inner | All six locks get the same idiom + per-lock justification comment; simplest, matches fs.rs:216 precedent, but inherits possibly-torn in-memory state | |
| Rebuild disk-backed locks | REGISTRY/JOBS reload from disk on poison; terminal locks (process-only handles) get into_inner; strongest alignment with the filesystem-SSOT core value, highest implementation cost | |
| Claude decides | Mechanism decided at research/planning time, bounded by the per-lock-justification requirement | ✓ |

**User's choice:** Claude decides (delegated to planner; D-03 still mandates the recorded justification per lock).
**Notes:** REQUIREMENTS.md Out of Scope already excludes blanket `into_inner()` over invariant-bearing state, which bounds the delegation.

| Option | Description | Selected |
|--------|-------------|----------|
| Log only | Single warn-level log line at the recovery point; user surface unaffected | ✓ |
| Fully silent | No record of the recovery itself | |
| User-visible | Toast or surface notification on recovery | |

**User's choice:** Log only.

| Option | Description | Selected |
|--------|-------------|----------|
| Keep sessions | Existing PTY sessions stay usable and new commands keep working after terminal-lock recovery | ✓ |
| Invalidate all sessions | Clean slate after recovery, but one panic closes every open terminal tab | |
| Read-only transition | Existing sessions readable, new writes/spawns blocked | |

**User's choice:** Keep sessions.

| Option | Description | Selected |
|--------|-------------|----------|
| Code comment | Justification co-located at each lock's static declaration / guard acquisition site | ✓ |
| Central document | All justifications collected beside a central constant/document | |
| Both | One-line summary in code + detailed rationale in a document | |

**User's choice:** Code comment.

---

## Watcher pruning (PERF-04)

| Option | Description | Selected |
|--------|-------------|----------|
| Event-time filter | Drop events under GENERATED_DIRS when they arrive; covers directories created after registration | ✓ |
| Registration-time exclusion | Never descend into generated dirs when building the watch tree; no OS watch handles at all, but post-registration dirs stay unpruned until restart | |
| Hybrid | Registration-time exclusion + periodic/detected rescan | |

**User's choice:** Event-time filter. (Note: OS watch-handle cost of this choice is mostly a Linux-inotify concern; macOS FSEvents watches at root level.)

| Option | Description | Selected |
|--------|-------------|----------|
| paths.rs helper | Shared predicate next to GENERATED_DIRS, extending the Phase 2 SSOT precedent | ✓ |
| Per-module duplication | Each watcher module owns its own matching logic | |

**User's choice:** paths.rs helper.

| Option | Description | Selected |
|--------|-------------|----------|
| All five sites | vault_watcher, inbox_watcher, scratchpad_watcher, ops_catalog/watcher, terminal_hooks — matches the generic wording of ROADMAP success criterion 2 | ✓ |
| Four sites only | The ones CONCERNS.md names, excluding terminal_hooks | |

**User's choice:** All five sites — scope fixed here to prevent re-litigation at planning time.

---

## Sanitizer guard tracing model (SEC-02)

| Option | Description | Selected |
|--------|-------------|----------|
| Module allowlist | Guard pins the list of modules exporting DOMPurify-backed helpers; sink `__html` must reference an identifier imported from an allowlisted module | ✓ |
| Name-pattern matching | Matches helper-name patterns (sanitize/purify); zero maintenance but spoofable by naming | |
| AST parsing | Parses imports precisely; most accurate but leaves the check-*.mjs idiom the requirement mandates | |

**User's choice:** Module allowlist.

| Option | Description | Selected |
|--------|-------------|----------|
| Direct reference only | Local aliases not followed; file-local helpers registered as explicit file+function-name pairs in the guard | ✓ |
| One-level alias tracing | Guard follows one variable-assignment hop; less registration burden, more script complexity | |

**User's choice:** Direct reference only.

---

## Inbox exclusion list shape (PERF-06)

| Option | Description | Selected |
|--------|-------------|----------|
| Shared list extension | Widen the scratchpad exclusion into a "non-document roots" list with inbox/ added, referenced by all three call sites | ✓ |
| Inbox-specific exclusion | Scratchpad exclusion untouched; separate inbox exclusion added at the same three sites | |
| Per-call-site composition | Common list + each call site composes its own filter combination | |

**User's choice:** Shared list extension.

| Option | Description | Selected |
|--------|-------------|----------|
| vault.rs | Constant beside the scan functions; document-index policy stays in its owning domain | ✓ |
| paths.rs | All path-policy constants in one file, matching the GENERATED_DIRS precedent | |

**User's choice:** vault.rs — paths.rs keeps filesystem-level policy only.

---

## Claude's Discretion

- Per-lock recovery mechanism (into_inner vs rebuild-from-disk) — user delegated; bounded by the per-lock justification requirement and the blanket-into_inner exclusion in REQUIREMENTS.md.
- Guard failure message shape and red-then-green proof mechanics (proof itself locked by ROADMAP success criterion 3).
- Watcher test fixture and per-lock poison test-harness design.
- DOMPurify helper export-surface adjustments needed for the six existing sinks to pass under the allowlist model.

## Deferred Ideas

None — discussion stayed within phase scope.

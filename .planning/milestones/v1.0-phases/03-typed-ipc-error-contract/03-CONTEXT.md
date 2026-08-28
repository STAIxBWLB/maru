# Phase 3: Typed IPC Error Contract - Context

**Gathered:** 2026-08-23
**Status:** Ready for planning

<domain>
## Phase Boundary

Give the errors the frontend branches on a stable machine-readable `code`, so a
rename breaks the build on both sides instead of silently breaking a recovery
path. Covers ERR-01..04: a typed `{ code, message }` contract over IPC for the
branch-on set, a two-sided rename-fails-the-build mechanism, migration of the
existing `message.includes(...)` matchers, and zero touch to the ~1,138
display-only `Result<T, String>` signatures (measured baseline; CONCERNS.md's
1,118 is stale).

</domain>

<decisions>
## Implementation Decisions

### Wire format
- **D-01:** The commands whose errors the frontend branches on switch to
  `Result<T, IpcError>` where `IpcError { code, message }` is a Serialize
  struct. This is the direction CONCERNS.md prescribes. The wire becomes a
  real object for those commands only; every other command keeps
  `Result<T, String>`. — **Reversibility:** costly — once callers branch on
  the object shape, reverting means touching every migrated call site again.
- **D-02:** The existing `code: message` string-prefix convention
  (`today_store.rs`, parsed by `todayErrorCode` at `src/lib/today.ts:698`) is
  the shape being formalized, not a convention to preserve. Migrated commands
  stop emitting the prefix string.

### Two-sided rename failure (ERR-02)
- **D-03:** No codegen. A Rust unit test asserts the canonical code list as
  constants, and the TypeScript side carries an exhaustive union/`satisfies`
  mirror in `src/lib/types.ts` over the same list. Renaming on either side
  fails that side's build/test, and the Phase 1 gate set (`make verify` =
  typecheck + cargo test) catches both. — **Reversibility:** reversible —
  swapping to codegen later is additive.

### Contract scope (ERR-03)
- **D-04:** Exactly four codes enter the contract — the set the frontend
  actually branches on, measured by grep: `evidence_binder_revision_conflict`
  (`src/components/evidence/EvidenceBinderPane.tsx:174`),
  `document_conflict` (`src/lib/diagram/reportInsert.ts:93` and
  `src/components/today/TodayReview.tsx:176`), `today_conflict` and
  `task_conflict` (`src/lib/today.ts:710,716`).
- **D-05:** The Rust-internal prefix families `unknown_source:`,
  `install_target_exists:`, `terminal_kill_failed:` are NOT in the contract —
  no frontend code branches on them (verified by grep; only
  `src-tauri/src/web_actions.rs:858` reads one, via `starts_with`). Including
  them would violate ERR-04's minimality. Their internal use stays as-is.
- **D-06:** `clipboard.ts:30`'s `"clipboard is empty"` match is a local
  (non-IPC) error — out of the contract. The diagram ribbon table string
  matches (`RibbonTable.tsx:84-86`) are internal diagram-logic messages, also
  out.

### Toast / catch compatibility
- **D-07:** The `src/lib/api.ts` facade normalizes: for migrated commands it
  catches the serialized `IpcError` object and rethrows an `Error` carrying
  the human `message` plus a `.code` property. Existing catch sites keep
  working unchanged (`err.message` still reads right, the toast path through
  `src/lib/errorStore.ts` is untouched). Branching migrates from
  `message.includes("<code>")` to `err.code === "<code>"` (or a typed helper).
- **D-08:** `todayErrorCode` (`src/lib/today.ts:698`) is retired for the
  migrated codes — `today_conflict`/`task_conflict` read `.code` directly.
  The helper may stay for unmigrated legacy strings only if a caller still
  needs it; otherwise delete it (planner verifies callers).

### Serde blind spot (carried from Phase 1)
- **D-09:** Every new boundary struct gets a `serde_json::from_value`
  round-trip test asserting the wire shape the TypeScript caller actually
  receives — the cheap mitigation REQUIREMENTS.md names for the
  `native-tauri-e2e-runner-missing` gap this phase inherits.

### Claude's Discretion
- Where `IpcError` lives in Rust (a shared module vs. per-domain), its exact
  Serialize field naming (camelCase per existing struct convention).
- Whether the TS mirror is a union type, a const array + `satisfies`, or both.
- The exact shape of the Rust-side code list assertion test.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Scope and requirements
- `.planning/REQUIREMENTS.md` §Typed IPC Errors — ERR-01..04 verbatim, plus
  the Phase 1 note on the IPC serde blind spot and the `serde_json::from_value`
  round-trip mitigation
- `.planning/ROADMAP.md` §Phase 3 — success criteria and planning notes
  (smaller-diff principle, existing enum shapes, toast constraint)

### Evidence
- `.planning/codebase/CONCERNS.md` §Tech Debt — "Stringly-typed IPC errors":
  the 1,118 signatures (stale as written; the measured baseline is 1,138 —
  RESEARCH Pitfall 6), the two existing error enums
  (`src-tauri/src/agent_host/status.rs:351`, `src-tauri/src/hub_client/http.rs:19`),
  and the prescribed `{ code, message }` struct + `types.ts` mirror approach

### Existing convention being formalized
- `src/lib/today.ts:698` — `todayErrorCode`, the `code: message` prefix parser
- `src-tauri/src/today_store.rs:513` — the `today_conflict: ...` emit side

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/lib/today.ts:698-718` — `todayErrorCode` / `isTodayConflict` /
  `isTaskConflict`: the de-facto convention this phase formalizes.
- `src-tauri/src/agent_host/status.rs:351` and `src-tauri/src/hub_client/http.rs:19`
  — the two existing error enums; reuse their shape idioms rather than
  inventing a third convention (roadmap note).
- `src/lib/errorStore.ts` — the global toast path; D-07 keeps it untouched.

### Established Patterns
- Tauri commands return `Result<T, E>`; `Err(E: Serialize)` rejects the
  frontend promise with the serialized value. Structs use
  `#[serde(rename_all = "camelCase")]` (ARCHITECTURE.md).
- Frontend errors flow through facade functions in `src/lib/api.ts`
  (192 invoke call sites) — the normalization point D-07 adds lives there.

### Integration Points
- The four matcher sites to migrate: `EvidenceBinderPane.tsx:174`,
  `reportInsert.ts:93`, `TodayReview.tsx:176` (already via `todayErrorCode`),
  `today.ts:710,716`.
- `src/lib/types.ts` — home of the mirrored code union.
- Phase 1's `make verify` gates (typecheck + cargo test + lint) are the
  mechanism D-03's two-sided failure rides on.

</code_context>

<specifics>
## Specific Ideas

- ERR-04's guard is a count: `Result<T, String>` stays within a few of the
  pre-migration baseline 03-01 measures (planning-time figure 1,138) —
  the four migrated commands are the only signature changes.
- The phase's own proof of ERR-02 is a deliberate rename drill: rename a code
  on one side, watch `make verify` go red on the other, revert (the Phase 1
  break-it-and-watch-it-fail method, D-13 there).

</specifics>

<deferred>
## Deferred Ideas

- **Typing the Rust-internal prefix families** (`unknown_source:`,
  `install_target_exists:`, `terminal_kill_failed:`) — no frontend consumer
  today; revisit if one appears.
- **Native Tauri E2E runner** — remains the v2 ledger entry; D-09's round-trip
  tests are this milestone's cheaper stand-in.

</deferred>

---

*Phase: 3-typed-ipc-error-contract*
*Context gathered: 2026-08-23*

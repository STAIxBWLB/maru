# Phase 3: Typed IPC Error Contract - Research

**Researched:** 2026-08-23
**Domain:** Tauri 2 IPC error typing (Rust serde ↔ TypeScript union mirror)
**Confidence:** HIGH

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Wire format**
- **D-01:** The commands whose errors the frontend branches on switch to
  `Result<T, IpcError>` where `IpcError { code, message }` is a Serialize
  struct. The wire becomes a real object for those commands only; every other
  command keeps `Result<T, String>`. (Reversibility: costly.)
- **D-02:** The existing `code: message` string-prefix convention
  (`today_store.rs`, parsed by `todayErrorCode` at `src/lib/today.ts:698`) is
  the shape being formalized, not a convention to preserve. Migrated commands
  stop emitting the prefix string.

**Two-sided rename failure (ERR-02)**
- **D-03:** No codegen. A Rust unit test asserts the canonical code list as
  constants, and the TypeScript side carries an exhaustive union/`satisfies`
  mirror in `src/lib/types.ts` over the same list. Renaming on either side
  fails that side's build/test, and the Phase 1 gate set (`make verify` =
  typecheck + cargo test) catches both. (Reversibility: reversible.)

**Contract scope (ERR-03)**
- **D-04:** Exactly four codes enter the contract:
  `evidence_binder_revision_conflict` (`src/components/evidence/EvidenceBinderPane.tsx:174`),
  `document_conflict` (`src/lib/diagram/reportInsert.ts:93` and
  `src/components/today/TodayReview.tsx:176`), `today_conflict` and
  `task_conflict` (`src/lib/today.ts:710,716`).
- **D-05:** The Rust-internal prefix families `unknown_source:`,
  `install_target_exists:`, `terminal_kill_failed:` are NOT in the contract.
  Their internal use stays as-is.
- **D-06:** `clipboard.ts:30`'s `"clipboard is empty"` match is a local
  (non-IPC) error — out of the contract. The diagram ribbon table string
  matches (`RibbonTable.tsx:84-86`) are internal diagram-logic messages, also
  out.

**Toast / catch compatibility**
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

**Serde blind spot (carried from Phase 1)**
- **D-09:** Every new boundary struct gets a `serde_json::from_value`
  round-trip test asserting the wire shape the TypeScript caller actually
  receives.

### Claude's Discretion
- Where `IpcError` lives in Rust (a shared module vs. per-domain), its exact
  Serialize field naming (camelCase per existing struct convention).
- Whether the TS mirror is a union type, a const array + `satisfies`, or both.
- The exact shape of the Rust-side code list assertion test.

### Deferred Ideas (OUT OF SCOPE)
- Typing the Rust-internal prefix families (`unknown_source:`,
  `install_target_exists:`, `terminal_kill_failed:`) — revisit only if a
  frontend consumer appears.
- Native Tauri E2E runner — remains the v2 ledger entry
  (`native-tauri-e2e-runner-missing`); D-09's round-trip tests are this
  milestone's cheaper stand-in.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| ERR-01 | A frontend caller can read a stable machine-readable `code` from any error it needs to branch on, alongside the human-readable message | `IpcError { code, message }` Serialize struct (D-01) + facade normalization to `Error` with `.code` (D-07); emitter/consumer map in §Architecture Patterns §"The branch-on set" |
| ERR-02 | Renaming an error code fails the build on both the Rust and TypeScript side | D-03 mechanism: Rust const-list unit test (fails `cargo test` ⊂ `make verify`) + TS union in `src/lib/types.ts` (fails `tsc -b` ⊂ `make verify`); rename drill per CONTEXT specifics |
| ERR-03 | Every existing `message.includes("<code>")` matcher branches on the typed code instead | Complete matcher inventory below — exactly 2 raw `.includes` sites + 3 helper-based sites; grep verified |
| ERR-04 | Display-only errors untouched — `Result<T, String>` count stays within a few of today's 1,118 | Baseline re-measured today: **1,138** via the pinned grep command (CONCERNS.md's 1,118 is stale — see Pitfall 6); migration set is 7 commands + shared helpers |
</phase_requirements>

## Summary

This phase formalizes an existing de-facto convention. The Rust side already
emits machine-readable codes as `code: message` string prefixes from a small
set of optimistic-concurrency guards; the frontend already parses them with
`todayErrorCode` (`src/lib/today.ts:698-706`) and raw `.includes` matchers.
The work is mechanical and well-bounded: introduce one `IpcError { code,
message }` Serialize struct, switch the ~7 commands whose errors are actually
branched on to `Result<T, IpcError>`, mirror the four-code union in
`src/lib/types.ts`, pin both sides with tests so a rename goes red in
`make verify`, and migrate five frontend branch sites to `err.code`.

The research value is not "what library to use" (none — zero new
dependencies) but the **complete emitter/consumer inventory** and the
**hidden blast radius**: e2e fixtures and one e2e assertion hard-code the
`code: message` string shape, five existing Rust unit tests assert on the
prefix strings, and `today_apply_plan_result` calls `today_mutate` as a plain
Rust function so a signature change propagates. All are enumerated with line
numbers below.

**Primary recommendation:** Implement D-01..D-09 as decided, with two
refinements: (1) the facade-normalized `Error` message should be
`"${code}: ${message}"` so every user-visible string (toast, e2e assertion)
stays byte-identical to today; (2) migrate the full measured branch-on set of
**7 commands**, not the 4 named in CONTEXT specifics — see Open Question 1.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Error taxonomy (the four codes, emit sites) | API / Backend (Rust) | — | Codes originate at Rust concurrency guards; they are the source of truth |
| Wire serialization of errors | Tauri bridge (serde) | — | `Err(E: Serialize)` rejects the frontend promise with the serialized value — framework behavior, not code to write |
| Canonical code list assertion | API / Backend (Rust unit test) | — | D-03: `cargo test` inside `make verify` is the Rust-side rename gate |
| Code union mirror | Frontend lib (`src/lib/types.ts`) | — | Type-only construct; `tsc -b` is the TS-side rename gate |
| Error normalization (`{code,message}` → `Error` + `.code`) | Frontend lib (invoke funnels) | — | Three funnels exist: `todayInvoke` (`src/lib/today.ts:12`), `api.ts` invoke sites, `src/lib/evidenceBinder.ts:127` |
| Branch-on-code recovery logic | Browser / Client (components) | — | The five call sites being migrated |
| Toast rendering | Browser / Client (`errorStore.ts`) | — | Untouched per D-07; reads `err.message` strings |

## Standard Stack

**No new packages.** This phase installs nothing; it uses only what is
already in the tree.

### Core (already present)
| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `serde` / `serde_json` | per `src-tauri/Cargo.toml` (workspace-pinned) | `#[derive(Serialize)]` on `IpcError`; `serde_json::from_value` round-trip tests (D-09) | Every boundary struct in the repo already serializes this way; `#[serde(rename_all = "camelCase")]` is the established convention (ARCHITECTURE.md via CONTEXT.md) |
| `tauri` | 2.10.0 [VERIFIED: src-tauri/Cargo.toml:48] | `Result<T, E>` command returns; `Err` rejects the `invoke` promise with `E` serialized | Framework behavior the whole app already depends on |
| `@tauri-apps/api` | ^2.10.1 [VERIFIED: package.json:48] | `invoke<T>` — rejection value is the raw serialized error | 192 existing call sites |
| TypeScript | ~5.9.3 [VERIFIED: package.json:77] | String-literal union + `satisfies` for the mirror | Strict mode already on; union idiom already used in `types.ts:52-60` |
| vitest | ^4.1.5 [VERIFIED: package.json:80] | Unit tests for the normalization helper | `pnpm test` = `vitest run src scripts` [VERIFIED: package.json:22] |

**Installation:** none.

## Package Legitimacy Audit

**No external packages are installed by this phase.** The gate is vacuous —
nothing to check, nothing to flag. If the planner is tempted to add a
codegen tool (e.g. `ts-rs`, `specta`), D-03 explicitly locks "no codegen";
do not introduce one.

## Architecture Patterns

### System Architecture Diagram

```
Rust concurrency guards                     Tauri bridge                Frontend
─────────────────────────                   ─────────────               ─────────────────────────────
today_store.rs:513 check_revision ─┐
today_store.rs:623,:1060 (inline) ─┤
today_lifecycle.rs:92 load_context ├─ Err(IpcError{code,message})
document.rs:122 assert_expected_   ├─═══════════ serialize ══════════▶  invoke() rejects with
  revision                         │                                    { code, message }
evidence_binder.rs:262 (inline) ───┘                                         │
                                                                             ▼
                                        ┌────────────────────────────────────────────────────┐
                                        │ invoke funnels (normalization point, D-07)          │
                                        │  • todayInvoke  src/lib/today.ts:12                 │
                                        │  • api.ts invoke sites (saveDocument :1076)         │
                                        │  • evidenceBinder.ts:127 mutateEvidenceBinder       │
                                        │  catch {code,message} → throw Error(`${code}:       │
                                        │  ${message}`) with .code = code                     │
                                        └──────────────┬─────────────────────────────────────┘
                                                       ▼
                              branch sites read err.code          display sites read err.message
                              (5 sites, migrated)                 (errorStore toast — untouched)
```

### The branch-on set (measured, complete)

Four codes, **seven commands**, five frontend branch sites:

| Code | Rust emit site [VERIFIED, read this session] | Command(s) | Frontend branch site [VERIFIED] |
|------|----------------------------------------------|------------|--------------------------------|
| `today_conflict` | `src-tauri/src/today_store.rs:513` (`check_revision`, verbatim: `"today_conflict: expected revision {expected_revision}, found {}"`); `:623` and `:1060` (inline same format) | `today_mutate` (:604), `today_finalize_setup` (:666, via `check_revision` at :710), `today_calendar_publish` (`today_calendar.rs:414`, via `check_revision` at :427) | `TodayPane.tsx:253,271` (`isTodayConflict` on `todayMutate`), `TodayPane.tsx:294` (on `todayFinalizeSetup`), `useTodayCalendarSync.ts:51` (on `todayCalendarPublish`) |
| `task_conflict` | `src-tauri/src/today_lifecycle.rs:92` (`load_context`, verbatim: `"task_conflict: expected hash {expected_task_hash}, found {actual_hash}"`) | `task_transition` (:368), `task_trash` (:448) — both share `load_context` | `TodayExecute.tsx:259` (`isTaskConflict`) |
| `document_conflict` | `src-tauri/src/document.rs:127,151,186` (verbatim: `"document_conflict: expected revision {expected}, found {actual}"` / `"... file is missing"`) | `save_document` (:135) | `TodayReview.tsx:176` (`todayErrorCode(err) === "document_conflict"` on `saveDocument`), `reportInsert.ts:93` (`message.includes("document_conflict")` on `deps.saveTarget` → `saveDocument`) |
| `evidence_binder_revision_conflict` | `src-tauri/src/evidence_binder.rs:262` (verbatim: `Err("evidence_binder_revision_conflict".to_string())` — **no message suffix today**) | `evidence_binder_mutate` (:249) | `EvidenceBinderPane.tsx:174` (`message.includes("evidence_binder_revision_conflict")`) |

**Explicitly NOT migrated (display-only emitters of contract codes):**
- `graph_link_apply` (`src-tauri/src/graph_authoring.rs:204`) emits
  `document_conflict: graph relationship preview is stale` at :213
  [VERIFIED: graph_authoring.rs:213], but its only consumer
  (`GraphRelationReviewDialog.tsx:80`) does `setError(String(reason))` —
  display-only, no branch [VERIFIED: GraphRelationReviewDialog.tsx:70-85].
  Migrating it would violate ERR-04 minimality. It keeps
  `Result<_, String>` and keeps its prefix string (it is not one of the
  migrated commands, so D-02 does not apply to it).
- `today_apply_plan_result` (`today_ai.rs:270`) propagates `today_conflict`
  but **calls `today_mutate` as a plain Rust function** (`today_ai.rs:293`)
  and has no active frontend branch (its AI-runtime wiring "lands in a later
  commit group" per `useTodayPlanner.ts:4`). It needs only a `.map_err`
  adaptation, not migration — see Pitfall 4.

### Pattern 1: The `IpcError` struct (D-01, D-02)

**What:** One shared Serialize struct for contract errors.
**When to use:** Only at the seven migrated commands and their shared helpers.

```rust
// Source: shape prescribed by .planning/codebase/CONCERNS.md §Tech Debt
// ("serializable { code, message } struct"); field names are single lowercase
// words so no serde rename attribute is load-bearing.
#[derive(Debug, Clone, serde::Serialize)]
pub struct IpcError {
    pub code: &'static str,
    pub message: String,
}

impl std::fmt::Display for IpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Preserves today's "code: message" user-visible string exactly.
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for IpcError {}
```

**Placement (discretion):** a shared module (e.g. `src-tauri/src/ipc_error.rs`)
is recommended over per-domain copies — three domains (today, document,
evidence) consume it, and D-03's canonical code list naturally co-locates
with it.

**Shared-helper conversion:** the three guards become the only constructors:
- `check_revision` (`today_store.rs:507-518`) → `Result<(), IpcError>`
- `load_context`'s hash check (`today_lifecycle.rs:91-94`) → `IpcError`
- `assert_expected_revision` (`document.rs:122-132`) → `Result<(), IpcError>`
- `today_mutate`'s two inline checks (`today_store.rs:623`, `:1060`) and
  `evidence_binder.rs:262` construct `IpcError` directly.
- Message text drops the `"<code>: "` prefix (D-02); the code moves to the
  `code` field.

### Pattern 2: Facade normalization (D-07)

**What:** One helper, called from the three invoke funnels, that converts the
rejection value.

```typescript
// Home: src/lib/types.ts (type) + a small helper module or api.ts.
// Follows the existing union idiom at src/lib/types.ts:52-60.
export type IpcErrorCode =
  | "today_conflict"
  | "task_conflict"
  | "document_conflict"
  | "evidence_binder_revision_conflict";

export interface IpcErrorBody { code: IpcErrorCode; message: string; }

/** Error subclass so `err instanceof Error`, `err.message`, and
 *  `err.code` all read correctly at existing catch sites. Message keeps
 *  the legacy "code: message" text so toasts/e2e stay byte-identical. */
export class IpcError extends Error {
  readonly code: IpcErrorCode;
  constructor(body: IpcErrorBody) {
    super(`${body.code}: ${body.message}`);
    this.name = "IpcError";
    this.code = body.code;
  }
}

export function normalizeIpcError(reason: unknown): unknown {
  if (
    typeof reason === "object" && reason !== null &&
    typeof (reason as { code?: unknown }).code === "string" &&
    typeof (reason as { message?: unknown }).message === "string"
  ) {
    return new IpcError(reason as IpcErrorBody);
  }
  return reason;
}
```

Funnel wiring: `todayInvoke` (`src/lib/today.ts:12-16`) wraps its
`invoke<T>` call; `saveDocument`/`readDocument` in `api.ts` (:1076, :1061);
`mutateEvidenceBinder` (`src/lib/evidenceBinder.ts:127-145`). Catch, normalize,
rethrow — or equivalently `.catch((e) => { throw normalizeIpcError(e); })`
only on the migrated commands' paths.

### Pattern 3: Two-sided rename failure (D-03)

**Rust side** — constants used at every emit site, plus a literal-pinning test:

```rust
pub const TODAY_CONFLICT: &str = "today_conflict";
pub const TASK_CONFLICT: &str = "task_conflict";
pub const DOCUMENT_CONFLICT: &str = "document_conflict";
pub const EVIDENCE_BINDER_REVISION_CONFLICT: &str = "evidence_binder_revision_conflict";

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ipc_error_codes_are_stable() {
        // Renaming a code must fail here AND in the TS typecheck.
        assert_eq!(TODAY_CONFLICT, "today_conflict");
        assert_eq!(TASK_CONFLICT, "task_conflict");
        assert_eq!(DOCUMENT_CONFLICT, "document_conflict");
        assert_eq!(EVIDENCE_BINDER_REVISION_CONFLICT, "evidence_binder_revision_conflict");
    }

    #[test]
    fn ipc_error_wire_shape_round_trips() {
        // D-09: assert the exact JSON the TS caller receives.
        let err = IpcError { code: TODAY_CONFLICT, message: "expected revision a, found b".into() };
        let value = serde_json::to_value(&err).unwrap();
        assert_eq!(value, serde_json::json!({
            "code": "today_conflict",
            "message": "expected revision a, found b"
        }));
        let back: serde_json::Value = serde_json::from_value(value).unwrap();
        assert_eq!(back["code"], "today_conflict");
    }
}
```

**TS side** — the union above. A rename on the TS side fails `tsc -b` at
every `err.code === "..."` site; a rename on the Rust side fails
`cargo test`. Both gates run in `make verify`
[VERIFIED: Makefile:321 — `verify: typecheck lint ... test-ts test-rust fmt-check clippy build-frontend`].

**Rename drill (from CONTEXT specifics):** the plan's own ERR-02 proof —
rename one code on one side, watch `make verify` go red, revert. Same
break-it-and-watch-it-fail method Phase 1 used (D-13 there).

### Anti-Patterns to Avoid
- **Codegen (`ts-rs`, `specta`, hand-rolled generators):** explicitly
  rejected by D-03. Adds a build step and a dependency for a four-item list.
- **Converting display-only commands:** 1,131+ `Result<T, String>`
  signatures stay. The two existing internal enums
  (`agent_host/status.rs:351` `UsageProbeError`, `hub_client/http.rs:19`
  `HubFetchError`) are *not* IPC error types — they never cross the bridge
  as-is; copy their match-on-variant idiom only if a per-domain enum is
  wanted, not their placement.
- **Keeping prefix parsing for migrated codes:** after migration
  `todayErrorCode` must not be the mechanism for the four codes (D-08).
- **Special-casing toasts at call sites:** the normalized `Error.message`
  carries the full text; `errorStore.ts` stays untouched (D-07).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Error serialization over IPC | A custom channel/event payload | `Result<T, E: Serialize>` command return — `Err` rejects the `invoke` promise with `E` serialized [CITED: https://v2.tauri.app/develop/calling-rust/] | Framework behavior; the app's 356 commands already rely on it |
| Wire-shape drift detection | A schema validator | One `serde_json::json!` equality assertion per struct (D-09) | The repo already uses `serde_json::from_value` in tests (`terminal/mod.rs:1464`, `tasks.rs:1227`) |
| Cross-language constant sync | Codegen | Literal-pinning test (Rust) + union type (TS) | Four items; D-03 locked |

**Key insight:** the entire "contract" is ~60 lines of Rust + ~30 lines of
TypeScript + funnel wiring. Anything larger is over-engineering a four-code
list.

## Runtime State Inventory

This phase changes wire format, not persisted state. All five categories
checked explicitly:

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | None — error codes are transient rejection values, never persisted (verified: the four codes appear only in `src-tauri/src/**` emit/test sites, `src/**` branch sites, and `e2e/**` fixtures — no `.maru` state file, snapshot JSON, or SQLite schema references them) | none |
| Live service config | None — no external service consumes these errors | none |
| OS-registered state | None | none |
| Secrets/env vars | None | none |
| Build artifacts | None — no generated code exists (D-03: no codegen); `dist/`/`target/` rebuild from source | none |

The closest thing to "runtime state" is the **e2e mock layer**
(`window.__MARU_E2E_INVOKE__` handlers) — but those are in-repo code,
covered under Pitfalls 1–2.

## Common Pitfalls

### Pitfall 1: The `document_conflict` e2e assertion hard-codes the prefix string
**What goes wrong:** `e2e/smoke.spec.ts:1266-1268` mocks `save_document` with
`throw new Error("document_conflict: revision changed")` and `:1281` asserts
`toContainText("document_conflict")` on the rendered alert
[VERIFIED: smoke.spec.ts:1261-1286, read this session]. CONCERNS.md flags the
same assertion. If the facade rethrows `Error(message)` where the Rust
message no longer carries the prefix (D-02), the alert text loses
`document_conflict` and the e2e goes red.
**How to avoid:** make the normalized message `"${code}: ${message}"`
(Pattern 2) — toast text stays byte-identical, the e2e passes unmodified.
This is also the behavior-preserving-milestone rule (Phase 2 kept
`ensure_within`'s message byte-identical for the same reason).
**Warning signs:** `make test-e2e` red on `smoke.spec.ts` "keeps a Files
draft intact when revision-checked save conflicts" after facade work.

### Pitfall 2: e2e today fixtures throw prefix-string Errors
**What goes wrong:** `e2e/helpers/todayFixtures.ts:748-792` mocks
`today_mutate` / `today_finalize_setup` by throwing
`new Error("today_conflict: expected revision ...")`
[VERIFIED: todayFixtures.ts:748-792, read this session]. After migration the
frontend branches on `err.code`, which these mock Errors lack — today-mode
e2e specs silently stop exercising the conflict-recovery path (or fail).
**How to avoid:** update the fixtures in the same change to throw
`Object.assign(new Error("today_conflict: ..."), { code: "today_conflict" })`
— matching the normalized shape — or throw the raw `{ code, message }`
object if the mock bypasses the funnel (check: `todayInvoke` consults
`invokeE2EOverride` *before* `invoke` [VERIFIED: today.ts:12-16], so the
override return/throw path must also pass through normalization, or the
fixture must throw the already-normalized shape).
**Warning signs:** today e2e specs green but the conflict retry path never
taken (assertion counts), or red with `isTodayConflict` never true.

### Pitfall 3: Existing Rust unit tests assert on the prefix strings
**What goes wrong:** These all break the moment emit sites switch to
`IpcError` (and they're inside `make verify`):
- `today_lifecycle.rs:574`, `:789` — `assert!(err.starts_with("task_conflict: expected hash bogus, found "))`
- `document.rs:738` — `assert!(error.starts_with("document_conflict:"))`; `:1227` constructs the literal
- `today_store.rs:788`, `:1038` — `assert!(err.starts_with("today_conflict..."))`
- `evidence_binder.rs:1722` — `assert_eq!(error, "evidence_binder_revision_conflict")`
[all VERIFIED via grep this session]
**How to avoid:** migrate each to assert `err.code == <CONST>` (and
`err.to_string()` for the display form) in the same commit as the emit-site
change. They are the natural home for the Pattern-3 assertions.

### Pitfall 4: `today_apply_plan_result` calls `today_mutate` as a plain fn
**What goes wrong:** `today_ai.rs:293` calls `today_mutate(...)` directly
[VERIFIED: today_ai.rs:285-296, read this session]. Changing `today_mutate`'s
error type to `IpcError` breaks compilation of `today_apply_plan_result`,
which returns `Result<TodaySnapshot, String>`.
**How to avoid:** add `.map_err(|e| e.to_string())` at the call site (keeps
`today_apply_plan_result` display-only per ERR-04 — its `today_conflict`
propagation is documented at `today_ai.rs:268` but has no active frontend
branch). Do NOT migrate its signature without a frontend consumer.
**Similarly:** `check_revision` has exactly two callers
(`today_store.rs:710`, `today_calendar.rs:427`) and `load_context` has two
(`task_transition`, `task_trash`) — all four commands are in the migration
set, so no String-typed straggler forces a compat shim.

### Pitfall 5: `String(err)` vs `err.message` at existing catch sites
**What goes wrong:** Today, Tauri rejections for `Result<_, String>` arrive
as **raw strings**, not `Error` objects (which is why `todayErrorCode`
accepts `string | Error` [VERIFIED: today.ts:698-706]). Rethrowing an
`IpcError extends Error` changes `String(err)` output from `message` to
`Error: message` (or `IpcError: message` unless `name` is managed).
**How to avoid:** audit the migrated commands' catch sites:
`EvidenceBinderPane.tsx:172` uses `err instanceof Error ? err.message :
String(err)` — safe. `TodayPane.tsx:271,295` use `console.warn` /
`err instanceof Error ? err.message : String(err)` — safe.
`GraphRelationReviewDialog.tsx:80` uses `String(reason)` — but
`graph_link_apply` is NOT migrated, so unaffected. Keep it that way.
**Warning signs:** a toast reading `Error: today_conflict: ...` (double
prefix).

### Pitfall 6: The ERR-04 baseline number is stale
**What goes wrong:** CONTEXT/CONCERNS cite 1,118 `Result<T, String>`
signatures (measured at v0.4.62 mapping). Re-measured today with
`grep -roE "Result<.*, String>" src-tauri/src --include="*.rs" | wc -l` the
count is **1,138** [VERIFIED: measured this session]. A plan that guards
against 1,118 fails on arrival.
**How to avoid:** the plan must pin the exact grep command and record the
baseline measured at execution time; the guard is "delta ≤ small number of
the migration set", not an absolute. Note the count includes `#[cfg(test)]`
lines; that is fine as long as baseline and post-check use the same command.

### Pitfall 7: CONTEXT says "four migrated commands"; measurement says seven
**What goes wrong:** CONTEXT specifics states "the four migrated commands are
the only signature changes", but the branch-on set (D-04's own criteria)
spans **7 commands**: `today_mutate`, `today_finalize_setup`,
`today_calendar_publish`, `task_transition`, `task_trash`, `save_document`,
`evidence_binder_mutate`. Migrating only 4 leaves live branch sites
(`useTodayCalendarSync.ts:51`, `TodayPane.tsx:294`, `TodayExecute.tsx:259`)
on string parsing — failing ERR-01/ERR-03.
**How to avoid:** migrate the code at the **shared-helper level** plus all
commands emitting contract codes to branch-on callers; the delta against the
1,138 baseline is still ~10 signatures ≈ "essentially unchanged". See Open
Question 1 — this needs user confirmation since it deviates from CONTEXT
specifics wording (though it follows D-04's intent).

## Code Examples

### Migrated branch site (ERR-03 before/after)

```typescript
// Before — src/lib/today.ts:709-717 [VERIFIED, read this session]
export function isTodayConflict(err: unknown): boolean {
  return todayErrorCode(err) === "today_conflict";
}

// After — reads the typed code; todayErrorCode retires for migrated codes (D-08)
export function isTodayConflict(err: unknown): boolean {
  return err instanceof IpcError && err.code === "today_conflict";
}
```

```typescript
// Before — src/components/evidence/EvidenceBinderPane.tsx:174 [VERIFIED]
if (message.includes("evidence_binder_revision_conflict")) void load();

// After
if (err instanceof IpcError && err.code === "evidence_binder_revision_conflict") void load();
```

### Migrated emit site (before/after)

```rust
// Before — src-tauri/src/today_store.rs:511-516 [VERIFIED, read this session]
if snapshot.revision != expected_revision {
    return Err(format!(
        "today_conflict: expected revision {expected_revision}, found {}",
        snapshot.revision
    ));
}

// After — code moves to the struct field; message loses the prefix (D-02)
if snapshot.revision != expected_revision {
    return Err(IpcError {
        code: TODAY_CONFLICT,
        message: format!("expected revision {expected_revision}, found {}", snapshot.revision),
    });
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| `thiserror`/`anyhow` for app-wide error enums | Single serializable struct for the branch-on subset | Repo convention (CONCERNS.md fix approach) | No new deps; display-only errors stay `String` |
| Codegen type sharing (`ts-rs`, `specta`) | Literal-pinned test + TS union | D-03 (this phase) | Zero build pipeline changes; revertible |
| `Error` subclassing discouraged in TS | `class IpcError extends Error` with own field | Needed here | Only way to keep `err instanceof Error` + add `.code` without a wrapper object every catch site must unwrap |

**Deprecated/outdated:**
- The `code: message` prefix *as a wire format* for migrated commands (D-02)
  — it survives only as the `Display` impl / toast text, not as the parse
  target.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | No frontend code branches on `today_apply_plan_result`'s `today_conflict` today (wiring incomplete per `useTodayPlanner.ts:4` comment) | Branch-on set | If a consumer exists, an 8th command needs migration — small additive change |
| A2 | `assert_expected_revision` (`document.rs:122`) is called only by `save_document` | Pattern 1 | If shared with another command, that command needs a `map_err` — compile error surfaces it immediately, low risk |
| A3 | The ERR-04 tolerance ("within a few") absorbs a ~10-signature delta (7 commands + 3 shared helpers) | Pitfall 7 | If interpreted strictly as "4", Open Question 1 must go back to the user |
| A4 | Tauri 2.10 rejects `invoke` with the raw serialized `Err` value (not wrapped) | Pattern 2 | Confirmed by docs [CITED: https://v2.tauri.app/develop/calling-rust/] and by the repo's own string-parsing code working today; if wrapping existed, `todayErrorCode` could not function |

## Open Questions (RESOLVED)

Dispositions: OQ1 → 03-01's blocking human-verify checkpoint ratifies the measured 7-command set. OQ2 → 03-03 deletes `todayErrorCode` and its tests (D-08). OQ3 → grep guard omitted at planner's discretion; the regression risk is covered by 03-04's rename drill plus typecheck.

1. **Seven commands, not four — confirm scope with the user.**
   - What we know: CONTEXT specifics says "the four migrated commands are the
     only signature changes"; the measured branch-on set is 7 commands
     (Pitfall 7). D-04 locks *codes* (four), not *commands*.
   - What's unclear: whether "four commands" was shorthand for "four codes"
     or a deliberate scope cut that accepts leaving
     `useTodayCalendarSync.ts:51` / `TodayPane.tsx:294` on string parsing.
   - Recommendation: proceed with the 7-command set (it is what D-04's
     branch-on criterion measures), note the deviation in the plan, and
     surface it at the first checkpoint. ERR-04's guard is a *count*, and
     ~10 of 1,138 is within "essentially unchanged".

2. **Does `todayErrorCode` get deleted outright?**
   - What we know: after migration its three remaining production callers
     (`TodayReview.tsx:176`, `isTodayConflict`, `isTaskConflict`) all read
     `.code` instead. D-08 permits deletion if no caller remains.
   - What's unclear: nothing technical — planner greps for residual callers
     (including unmigrated legacy prefix errors like `today_state_missing`,
     which no frontend code branches on per D-05's grep verification).
   - Recommendation: delete it and its tests; the prefix convention it
     served is being retired (D-02).

3. **Should a grep guard (`scripts/check-ipc-error-codes.mjs`) join `verify`?**
   - What we know: the repo has the idiom — `check-select-chrome.mjs`,
     `check-type-tokens` are grep guards in `make verify` [VERIFIED:
     Makefile:321]. A guard asserting no `.includes("<code>")` for the four
     codes in `src/` would make ERR-03 self-enforcing.
   - What's unclear: whether it earns a permanent gate slot for a one-time
     migration (GATE-07-style ledger hygiene argues against gate bloat).
   - Recommendation: planner's discretion; the rename drill + typecheck
     already cover the regression risk. Cheap to add, cheap to omit.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Node | typecheck, vitest, vite build | ✓ | v25.9.0 (engines: >=22) | — |
| pnpm | all frontend gates | ✓ | 9.15.0 (matches `packageManager` pin) | — |
| cargo/rustc | cargo test, clippy, fmt | ✓ | 1.98.0 (matches Phase 1 `rust-toolchain.toml` pin) | — |
| GNU Make | `make verify` | ✓ | 3.81 | — |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** none.

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework (TS) | vitest ^4.1.5 [VERIFIED: package.json:80]; `pnpm test` = `vitest run src scripts` |
| Framework (Rust) | `cargo test --lib` via `make test-rust` [VERIFIED: Makefile:192] |
| Config file | `vite.config.ts` (vitest inline config); no separate vitest.config |
| Quick run command | `pnpm vitest run src/lib/today.test.ts src/lib/evidenceBinder.test.ts src/lib/diagram/reportInsert.test.ts` |
| Full suite command | `make verify` (typecheck + lint + test-ts + test-rust + fmt-check + clippy + build-frontend) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| ERR-01 | normalization yields `Error` with `.code` + readable `.message` | unit | `pnpm vitest run src/lib/ipcError.test.ts` | ❌ Wave 0 (new file; or extend `src/lib/today.test.ts`, which already tests `todayErrorCode`) |
| ERR-02 | Rust rename fails `cargo test`; TS rename fails `tsc -b` | unit + typecheck + drill | `cargo test --lib ipc_error` + `pnpm typecheck` + rename drill (plan verification step) | ❌ Wave 0 (new Rust test module) |
| ERR-03 | five branch sites read `.code`; zero `.includes("<code>")` remain | unit + grep | `pnpm vitest run src/lib/diagram/reportInsert.test.ts src/components/today` + `grep -rn '\.includes("today_conflict"\|...' src/` | ✅ tests exist (`reportInsert.test.ts`, `today.test.ts`, `TodayExecute.test.tsx` reference the codes today) |
| ERR-04 | `Result<T, String>` count within tolerance | grep baseline | `grep -roE "Result<.*, String>" src-tauri/src --include="*.rs" \| wc -l` (baseline 1,138 today) | ✅ no new file |
| D-09 | wire shape round-trips | unit (Rust) | `cargo test --lib ipc_error` | ❌ Wave 0 (lands with the struct) |

### Sampling Rate
- **Per task commit:** targeted vitest files + `cargo test --lib <module>`
- **Per wave merge:** `pnpm test && cargo test --lib`
- **Phase gate:** full `make verify` green, plus the rename drill, plus
  `make test-e2e` (smoke.spec.ts conflict test is the e2e canary — Pitfall 1)

### Wave 0 Gaps
- [ ] `src/lib/ipcError.test.ts` (or equivalent) — normalization helper tests (ERR-01)
- [ ] Rust `ipc_error` module test module — code-list pin + `serde_json` round-trip (ERR-02, D-09)
- [ ] Update existing prefix-string assertions (Pitfall 3) — these exist and will go red on the emit-site change; they are migration targets, not new files

*(Frameworks, configs, and fixtures already exist — no install step.)*

## Security Domain

This phase has minimal security surface: it re-shapes error values that
already cross the IPC boundary; it does not add inputs, sinks, or trust
crossings.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|------------------|
| V2 Authentication | no | — |
| V3 Session Management | no | — |
| V4 Access Control | no | — |
| V5 Input Validation | partial | `normalizeIpcError` must not blindly trust the rejection shape — it type-guards `code`/`message` as strings before constructing `IpcError` (Pattern 2); the `IpcErrorCode` union constrains branch values at compile time |
| V6 Cryptography | no | — |
| V7 Error Handling & Logging | yes (spirit) | Messages shown to the user are unchanged in content (Pattern 2 keeps `"code: message"`); no new internal detail is exposed beyond what the prefix strings already leak today |

### Known Threat Patterns for {Tauri 2 + serde error boundary}

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Error-message information disclosure | Information Disclosure | Migrated messages are the same human text as today minus the code prefix; the code field adds nothing an attacker couldn't read from the binary |
| Frontend trusting forged rejection objects | Tampering / Spoofing | Type-guard in `normalizeIpcError`; the `code` union means a forged/unknown code simply never matches a branch (fails safe to generic error display) |

## Sources

### Primary (HIGH confidence)
- In-repo source of truth, read this session: `src/lib/today.ts:12-16,696-717`;
  `src-tauri/src/today_store.rs:506-518,604-720,1055-1075`;
  `src-tauri/src/today_lifecycle.rs:75-100,368,448`;
  `src-tauri/src/document.rs:118-193`; `src-tauri/src/evidence_binder.rs:249-275`;
  `src-tauri/src/graph_authoring.rs:204-225`; `src-tauri/src/today_ai.rs:260-300`;
  `src/components/evidence/EvidenceBinderPane.tsx:150-185`;
  `src/components/today/TodayReview.tsx:166-189`;
  `src/components/today/TodayPane.tsx:240-300`; `src/components/today/TodayExecute.tsx:245-275`;
  `src/components/graph/GraphRelationReviewDialog.tsx:60-100`;
  `src/lib/diagram/reportInsert.ts:70-115,195-214`;
  `src/lib/errorStore.ts` (full); `src/lib/e2eInvoke.ts` (full);
  `src/lib/api.ts:1061-1100`; `src/lib/evidenceBinder.ts:127-145`;
  `e2e/smoke.spec.ts:1261-1286`; `e2e/helpers/todayFixtures.ts:730-800`;
  `src/lib/types.ts:1-60`; `Makefile:187-192,321`; `package.json` (scripts/deps);
  `src-tauri/Cargo.toml:48`; `.planning/codebase/CONCERNS.md` (full)
- Grep-verified inventories (this session): all four codes' emit/branch/test
  sites; `Result<.*, String>` count = 1,138

### Secondary (MEDIUM confidence)
- Tauri v2 error rejection semantics — [CITED: https://v2.tauri.app/develop/calling-rust/]
  ("returning Err rejects the promise with E as the error... your error type
  gets serialized"), corroborated by the repo's working string-prefix parsing

### Tertiary (LOW confidence)
- None. No unverified external claims.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — zero new dependencies; all versions verified in manifests
- Architecture: HIGH — every emitter and consumer located and read at line level; the one external behavior (Tauri rejection shape) is cited and corroborated by working repo code
- Pitfalls: HIGH — each pitfall cites a file:line read this session; the two scope surprises (Pitfalls 6–7) are measured, not inferred

**Research date:** 2026-08-23
**Valid until:** 2026-09-06 (fast-moving only if concurrent sessions touch `today_store.rs` / `today_lifecycle.rs` — re-run the Pitfall 6 count at plan execution)

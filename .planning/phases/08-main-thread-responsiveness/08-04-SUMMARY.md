---
phase: 08-main-thread-responsiveness
plan: "04"
subsystem: skills
tags: [rust, tauri, concurrency, evidence, node-test]
requires:
  - phase: 08-03
    provides: Synchronous Skills exports, owned IPC workers and staged admission obligations
provides:
  - Seven async environment/dispatch IPC wrappers with preserved synchronous exports
  - Held-worker and background-lifetime behavior tests using disposable fixtures
  - Fail-closed command evidence checker with staged and final integration gates
affects: [08-05, 08-06, 08-07, 08-16, 08-17, 08-25, 08-26, 08-27, 08-28, 08-29]
actuals:
  tokens: 33584
  tasks: 2
  commits: 3
tech-stack:
  added: []
  patterns: [spawn_blocking, dedicated background threads, Runtime-generic AppHandle, evidence drift gate]
key-files:
  created: [scripts/check-command-isolation.mjs, scripts/check-command-isolation.test.mjs, docs/performance/phase08-04.json]
  modified: [src-tauri/src/skill_host/env.rs, src-tauri/src/skill_host/dispatch.rs, src-tauri/src/mission_state.rs, src-tauri/src/lib.rs]
key-decisions:
  - Only finite setup occupies the blocking pool; child wait, stream pumps and idle watches retain their dedicated threads.
  - Command shards retain exclusive ownership; Plan29 integration evidence references existing command keys without adding rows.
  - Package-manager side effects remain existing delegated behavior, outside any claim of global filesystem exclusion.
requirements-completed: [PERF-01]
coverage:
  - id: env-dispatch-boundaries
    description: All seven actual IPC wrappers use a distinct blocking worker while same-runtime async progress continues; setup and event contracts survive.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_04
        status: pass
      - kind: other
        ref: cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli
        status: pass
    human_judgment: false
  - id: exhaustive-evidence-gate
    description: Exact command ownership, physical source references, nonzero behavior evidence and staged/final integration obligations fail closed.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: node --test scripts/check-command-isolation.test.mjs
        status: pass
      - kind: other
        ref: node scripts/check-command-isolation.mjs --plan 04
        status: pass
    human_judgment: false
duration: 14min
completed: 2026-09-05
status: complete
---

# Phase 08 Plan 04: Environment and Dispatch Blocking Boundaries Summary

All seven environment/dispatch commands now isolate finite filesystem and process setup in awaited blocking workers, while existing background threads retain child and event lifetime. The command evidence checker rejects incomplete ownership, source, test and integration records without presenting text scanning as runtime proof.

## Performance

- Started: approximately 2026-09-05T05:14Z, following the 08-03 state handoff.
- Completed: 2026-09-05T05:28Z.
- Tasks: 2; implementation, test and evidence files: 7.
- Actual tokens: 33584, rounded-up characters/4 over the realized seven-file diff from 649ae64 through dfa27c5. Three commits count the two task commits and this SUMMARY; shared-state tracking is separate.

## Accomplishments

- `env::ipc` owns `skills_env_status`, `skills_env_bootstrap`, `skills_env_repair`; `dispatch::ipc` owns `skills_runtime_status`, `skills_dispatch_compose`, `skills_dispatch_terminal`, `skills_dispatch_background`. The seven registrations now target qualified async wrappers. Original synchronous exports remain available to scheduler/domain/CLI callers. All seven rows finish `ISOLATED`, including the two original `AUDIT` rows.
- Owned AppHandle/input values enter `spawn_blocking` before defaults, registry reads/materialization, skill/cwd validation, environment construction, executable resolution or subprocess setup. Inner String results remain unchanged; only JoinError receives contextual `<command>_task_failed` text. Existing approval metadata, proposal-only defaults, plan/read-only terminal flags and explicit provider argv/environment remain intact.
- Existing dedicated threads continue to own environment scripts, dispatch child waits, stdin writers, output pumps and mission idle watches. Returning an invocation ID records acceptance, not completion. Actual completion remains status/event driven, with no new notification or retry path.
- Seven Rust cases cover all seven actual wrapper boundaries, successful local dry-run status/done payloads, a held synthetic repair script that exits 7 after IPC returns, blank-prompt and missing-skill rejection with zero provider launch, local composition/terminal argv/environment, and spawn failure without a completion event. Boundary tests compare invoking and blocking thread IDs, require a yielded probe on the same Tauri runtime before release, and verify contextual panic JoinError.
- The checker joins the research inventory, exact plan ownership and physical current registrations, resolving reexports and same-name IPC modules. It validates concrete source/helper/caller paths, symbols, behavior case names and passing nonzero selectors; rejects comments/strings masquerading as boundaries, blocking work before offload, missing/duplicate/unknown ownership, placeholders and empty evidence. Read-only empty write sets are accepted only with explicit positive read-only evidence.
- Seventy-two miniature fixture tests include both a fully valid final `--all` case and rejected final omissions. Native feature-only commands use a separate positive allowlist and require gated definitions/module plus registration. Production additions require explicit reconciliation, never an overlay duplicate. Existing 01/02/03 shards remain unchanged and pass their exact gates.

## Task Commits

1. Task 04-1: `a39cdb0`, `perf(08-04): isolate environment and dispatch setup from async workers`.
2. Task 04-2: `dfa27c5`, `test(08-04): enforce exhaustive command isolation evidence and staged integration`.

## Executed Checks

| Check | Actual result |
| --- | --- |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_04` | Final run 7 passed, 0 failed/ignored. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib mission_state::tests` | 4 passed, 0 failed/ignored. |
| `cargo test --manifest-path src-tauri/Cargo.toml --lib skill_host::dispatch::tests` | 9 passed, 0 failed/ignored; fake CLI probes only. |
| `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli` | Passed. |
| `cargo check --manifest-path src-tauri/Cargo.toml --lib` | Passed, including desktop command registration. |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings` | Passed. |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | Passed. |
| `node --test scripts/check-command-isolation.test.mjs` | Independently rerun: 72 passed, 0 failed/skipped, approximately 2.25 seconds. |
| `node scripts/check-command-isolation.mjs --plan 04` | Passed: 7 evidence rows, 365 production registrations, 0 native-only commands. |
| Checker `--plan 01`, `--plan 02`, `--plan 03`, each separately | Passed: 1, 1, 24 evidence rows; each reconciles all 365 current production registrations. |
| Checker `--all --expected-count 365` | Expected rejection: real 08-29 overlay is not yet produced. No phase-wide closure claimed. |
| GSD artifact verification | 5/5 passed. |
| JSON parse, source diff review and `git diff --check` | Passed. |

No new native app build/run was required by this plan. Existing native source/batch proof remains in 01/02; real two-worker saturation and production artifact closure remain 27/28.

## Deviations and Issues

1. **[Rule 2 - Testable existing lifecycle] Minimal `mission_state.rs` signature expansion.** Dispatch AppHandle flows through mission registration, output, finish/fail, emit and idle-watch helpers. Made only these six helpers generic over `tauri::Runtime`, enabling actual MockRuntime wrapper tests while preserving normal Wry behavior. Parent explicitly authorized this scope correction. Mission command ownership remains 16, event-store ownership remains 17. Their normal app/CLI compilation and four existing mission tests pass.
2. **[Audit clarification] Composition is not completely read-only.** `get_skill -> load_registry_unlocked` ensures the standard Skills source/cache directories. Recorded these writes for 29 rather than claiming a pure model boundary. The 03 diagnostic doctor genuinely uses its read-only loader, so its explicit empty write set is valid.
3. **[Audit clarification] Environment setup has delegated external effects.** Reviewed the tracked frozen `src-tauri/skills-bootstrap/envs/default/setup.sh` and `scripts/setup-node.sh` beneath that directory. The materialized script writes env target `.venv`, `node_modules`, `node`, input/output directories, temp/log directories, project uv/pnpm state and temporary node-download staging. Existing uv installation and brew/apt package operations can also affect package-manager caches/prefixes. No real package installer or provider was executed: the repair test replaces only its disposable materialized script. Plan29 must protect concrete application-owned env/project/output paths and retain this external-side-effect limitation. No global package-manager exclusion, arbitrary-script containment or broad system lock is claimed.
4. Existing test-build warnings in `today_ai.rs` and scheduler test-disabled code remain out of scope; library clippy passes. No unrelated files were changed or staged.

## Integration Contract for Later Plans

- Early shards 01-05 retain `integrationRequired: "08-29"` and `moduleIntegrationOwner: "08-29"`. Their focused `--plan` checks permit this explicit future dependency. Synchronous domain functions, background callback seams and original command ownership remain available for 29.
- `--integration 29` consumes only `docs/performance/phase08-29-integration.json`. It has seven module records and no `commands` collection. Store/env/dispatch/git/dot final owner is 29; mission_state stage owner is 29/final owner 16; event_store stage owner is 29/final owner 17. `commandRefs` are `{module,name}` references to existing inventory rows.
- Every produced integration `testCases` record includes `entryPair` with physical `path.rs::symbol` references, `orders: ["writer-first", "other-first"]`, `aliases: ["lexical", "symlink", "ancestor"]`, `failureRelease`, `outcome`, `module`, nonzero passing `tests`, and `evidence` containing real behavior-test names. Required parent pairs are Skills-save/Skills-sync/Git-pull versus rename/trash, all six combinations.
- `networkRegistryAvailability` declares `networkWork`. Store/git must declare true. Network records require `registryReleasedDuringNetwork`, `registryReleasedDuringAdmissionWait` and `listAndMetadataRemoveProgress` true, with physical source evidence; store also requires `sourceDuplicateReturnsBusy` and `batchBusySourceSkipped`. Positive non-network reasons apply only where appropriate.
- `lifetime` records `scope`, `admissionHeldThroughEffects`, `admissionHeldThroughRollback` and source evidence. Env/dispatch must use background scope and `backgroundCallbacksCovered: true`. Store/git `writeSetCoverage` requires `wholeCheckout`, `gitDirectory`, `gitCommonDirectory`, `stagingRollback`, `registrySidecars` true, backed by actual path/source/test records. These declarations support review and drift checks; they do not themselves prove exclusion.
- The overlay's `documentRaceConsumer` names plan 08-07 and selector `phase08_07_earlier_writer_document_races`, with required save/create counterparts and both orders/all alias variants. Focused 29 accepts the future obligation without requiring unproduced document wrappers. Final `--all` requires actual 07 `crossDomainConsumers` results.
- Final 16/17 `moduleIntegrations` handoffs contain `integrationId`, `status: "complete"`, `module`, physical `entrySymbols`, nonzero passing `tests` and `evidence` naming actual behavior cases. Status alone cannot close them.
- Final processing callers additionally require `classifier`, `successRetention`, `failureReasons`, `singleTerminalNoticeOwner: true`; caller closure remains 25/26/28. Native-only evidence goes in `phase08-native-allowlist.json`; explicitly reconciled production additions go in `phase08-registration-changes.json`. Comments above `WRITERS` and executable fixtures document exact shapes.

## Safety and Threat Dispositions

- T-08-04-01, tampering: owned validation and permission/argv/environment contracts remain inside the finite worker. Blank/missing skill dispatch never launches a process. Shared lexical/alias/parent admission and background path lifetime remain the explicit mandatory 29 integration obligation.
- T-08-04-02, denial of service: finite work leaves shared async workers; tests demonstrate distinct blocking-thread ownership and same-runtime progress. Dedicated background workers retain lifecycle. Native saturation and app-quit behavior are not claimed here.
- T-08-04-03, disclosure: all new behavioral fixtures use disposable roots, fake scripts, or deliberately absent executables. No credentials or real provider calls were used. Test hooks are `cfg(test)` only; no production native hook was added. Phase-wide final artifact proof remains 28.
- No automatic sync retry, duplicate queue, new job center, Phase9 quit/terminal escalation, new dependency, push, merge or external message was introduced.
- PERF-01 remains a shared requirement contribution; this SUMMARY does not close unfinished sibling plans or phase-wide native proof.

## Self-Check: PASSED

Both task commits exist, seven owned rows are final, all five required artifacts exist, all focused executed tests are nonzero and passing, and no unrelated dirty state was staged. Ready for 08-05.

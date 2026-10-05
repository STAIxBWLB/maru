# Issue 426: Bound proposal approvals

- Scope: the existing `agent.proposal.apply` path now requires a native prepared binding. Generic low-risk approval APIs remain available.
- Authority: a binding includes workspace logical targets, serialized proposal SHA-256, source run ID, source metadata/review revision, current target content hashes and current registry/legacy policy bytes. Rust computes it at preparation and recomputes it inside the admitted effect transaction.
- Remembering: migrated grants match the complete binding, including target, payload and revisions. Generic callers keep their existing session kind cache. The proposal checkbox describes the narrower scope.
- Audit: request, decision, consumed attempt and effect outcome live in `~/.maru/approvals/<canonical-workspace-sha256>/approval-<uuid>.json`. Writes use path transaction admission, an application-owned home path with directory/leaf symlinks rejected, private atomic replacement and Unix ancestor-directory fsync through the home parent. They do not consume provider document Create/Modify permissions; actual proposal effects still enforce those permissions. Readable history never restores grants after restart.
- Decisions: approved/rejected decisions are terminal. A repeat of the identical decision is idempotent; reversing it fails. A consumed grant cannot be re-recorded or consumed again.
- Failure: consume marks authority spent before publishing its durable event; publication failure blocks all proposal effects and permanently poisons the session grant. An outcome audit error returns `approval_effect_outcome_uncertain`, retains the spent grant and does not undo or retry attempted writes.
- Existing meeting source validation, protected write hashes, deliberate lexical symlinks and parent admission contracts continue to execute.
- Commands: no registered command was added. `prepare_approval` accepts optional `proposalContext` with `cwd`, `proposal` and `runId`. Its bound mode validates the kind; generic preparation cannot supply a reusable proposal grant. The synchronous generic Rust API retains its signature.
- UI: Skill Runs, Tasks review, Meetings review and Agent Chat send their exact selected proposal to preparation. Followup-only reviews use generic `agent.followups.dispatch` because they do not call proposal apply.

| Acceptance criterion | Hermetic regression evidence |
| --- | --- |
| AC1: payload, target, workspace, run and base/source/policy revision binding | `bound_proposal_rejects_payload_target_workspace_run_and_base_drift`; `bound_proposal_rejects_changed_source_and_policy_revision` |
| AC2: one effect attempt, terminal decisions and remembered scope | `bound_proposal_concurrent_consumes_and_restart_keep_history_without_authority`; `bound_remembered_grants_are_exactly_scoped_and_terminal_decisions_immutable`; `phase08_24_approval_record_serializes_same_target_both_orders` |
| AC3: readable restart history with no restored grants | `bound_proposal_concurrent_consumes_and_restart_keep_history_without_authority` tests both consumed and approved/unconsumed historical IDs |
| AC3: pre-effect audit failure and unusable spent grant | `bound_proposal_pre_effect_audit_failure_blocks_and_poisoned_grant_cannot_retry`; `bound_proposal_consume_cannot_publish_audit_blocks_effect` |
| AC3: outcome failure remains uncertain with committed output, no rollback/retry | `bound_proposal_outcome_failure_is_uncertain_without_rollback_or_retry` |
| AC4: generic kind cache and existing proposal/provenance/path contracts | Existing approval and proposal suites remain active; generic APIs keep signatures and kinds |
| Frontend forwarding and generic bypass | `src/lib/api.test.ts`, `bound proposal approvals` forwards exact context, rejects display-only high-risk requests before IPC and retains low-risk preparation |

- Verification execution belongs to the integrating session. No test/build success or installed-native proof is claimed by this implementation note until the command receipt is added to the PR.
- Limits: the binding scopes the supplied source-run identity and available durable source metadata; it does not establish new cryptographic provenance for legacy runs without source metadata. Source validation retains the documented legacy migration behavior. External network effects do not gain an exactly-once guarantee. Readable JSON audit history is inspectable local state, not a tamper-proof ledger.

- Cloud review followups: `bound_first_approval_survives_legacy_only_registry_migration` verifies policy migration occurs before the first approval pin. `bound_audit_is_application_owned_but_document_effects_keep_granular_capabilities` verifies Nextcloud create-only and modify-only successes and opposite-action denials. `bound_owned_audit_rejects_directory_and_leaf_symlink_escapes` preserves private metadata containment. Metadata moves from workspace storage to application storage to avoid coupling an allowed proposal effect to unrelated audit Create/Modify capabilities; no prior released audit data requires migration.

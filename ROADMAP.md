# Maru Roadmap

**Status date:** 2026-09-04
**Current product release:** v1.1.3 - Semantic Titles
**Planning state:** Milestone v1.1 Felt Quality and Native Proof active, phases 6-11

Maru brings Korean knowledge work, document operations, evidence, tasks,
communications, and AI-assisted workflows into one local-first desktop
workspace. The filesystem remains the authoring source of truth. Hub and cloud
systems provide bounded external capabilities; they do not replace local
ownership or bypass approval gates.

## How to Read This Roadmap

- **Shipped** means the behavior exists on `main` and is covered by repository
  verification or release evidence.
- **Partial** means useful primitives exist, but the named end-to-end user flow
  is incomplete.
- **Candidate** means the work is documented but is not an active commitment.
- The canonical active delivery plan is `.planning/ROADMAP.md`. It currently
  carries milestone v1.1, phases 6-11.
- A candidate becomes committed work only after `$gsd-new-milestone` promotes
  it into requirements and a phase roadmap.

The old W1-W26 labels remain below only as compatibility references for prior
plans and issues. They no longer imply an active weekly schedule.

## Current Baseline

| Area | Current state | Evidence |
|------|---------------|----------|
| Product distribution | v1.1.3 shipped for macOS ARM/Intel, Linux, and Windows | 21 non-empty release assets, 11-platform updater manifest, Homebrew cask and CLI formula |
| Planning milestone | v1.1 Felt Quality and Native Proof active | Phases 6-11; v1.0 closed at 5 phases, 32 plans, 24/24 requirements |
| Application surface | 18 top-level modes plus Settings overlay; Explorer is a right-pane tab, not a mode | Typed lazy mode registry on `main`; `RightPaneTab` in `src/lib/settings.ts` |
| Application shell | Store-backed facades; the flexible split workbench and the fail-closed macOS passkey path shipped in v0.4.41 | Static ceilings and render-isolation tests |
| Verification | Authoritative local and CI gates | Typecheck, ESLint, frontend/Rust tests, E2E, rustfmt, clippy, build, bundle budgets |
| Typed IPC | ERR-06 closed after milestone review | Conflict codes preserved across every emitting command; recursive Rust source guard |
| Security evidence | Phase 1, 3, 4, and 5 reports present; Phase 2 remains optional evidence debt | Phase 3 audit: seven threats closed, `threats_open: 0` |

The detailed milestone record is
`.planning/reports/MILESTONE_SUMMARY-v1.0.md`. Milestone numbering and release
versions are aligned: see the numbering rule in README's Release Process.

## Product Capability Map

| Module | Status | Shipped now | Remaining candidate work |
|--------|--------|-------------|--------------------------|
| M0 Application Shell and Workbench | Partial | 18 typed lazy modes, store-backed pane facades, editor/outline/terminal state extraction, mode adapters, render-isolation tests, the Explorer right-pane tab, the flexible split workbench, and the macOS passkey path (all v0.4.41) | Workbench render isolation for the surfaces added since the extraction |
| M1 Operations Catalog | Shipped | Workspace/BU scan, deadlines and approval signals, watcher refresh, Hub read/cache, drilldown, Reveal, queue status | Expand only when a new operational consumer requires it |
| M2 Document Studio | Shipped locally | Seven-step source, template, guideline, sections, HWP fields, export, and package flow; persistent state and frontmatter-safe body apply | Submission workflow, approval drawer, and finalize-to-Hub user flow |
| M3 Template and Form Filling | Partial | Workspace/Hub templates, HWPX slots, label detection, validated native fill, released `hwp` 0.12.1+ enforcement | Decide whether binary `.hwp` conversion and embedded HWP editor UI belong in a future milestone |
| M4 Export Pipeline | Shipped | Manifest planning, SHA-256 source binding, DOCX/HWPX/PDF dispatch, status transitions, lightweight format validation | Richer submission/certification validation and optional progress surfaces |
| M5 Evidence Binder | Partial | Local schema v2, full binary SHA-256 identity, explicit section/KPI/checklist targets, local verification, selection, undo, orphan handling | Hub evidence-index lookup, reuse hints, and certification integration |
| M6 Deck Studio | Candidate | Deck-related skills are discoverable, but no Deck Studio mode or job workflow exists | Plan, generate, regenerate, reorder, manifest, PPTX, and PDF workflow |
| M7 Hub Connector | Partial | Status, catalog read with ETag/offline cache, submit-gate POST, safety preflight, durable offline queue/drain, gate polling backend, Catalog queue controls | Studio integration, approval-route UI, frontmatter lifecycle updates, finalized document upload, and finalized-document browser |

## Shipped Foundation

### Trustworthy Change and Release Gates

The v1.0 structural milestone made verification a product capability rather
than a best-effort developer habit:

- repository-pinned Rust toolchain with rustfmt and clippy warnings denied
- four TypeScript projects covered by `tsc -b`
- ESLint correctness rules over application and E2E code
- frontend tests, Rust tests, Playwright E2E, production build, and gzip budgets
- exact-tree main CI reuse only after an identical PR head succeeds
- separate Release Preflight and four-platform Release Bundles workflows
- signed updater metadata, Developer ID notarization, stapled DMGs, Gatekeeper,
  and Homebrew finalization

### Shared Rust Invariants

- `GENERATED_DIRS` is the shared generated-directory exclusion list.
- `ensure_within` and `require_absolute` are the canonical helpers for new path
  boundaries.
- Containment stays lexical so deliberate in-workspace symlinks remain valid.
- Existing sound path checks were not mechanically rewritten.

### Typed IPC Errors

- Stable conflict codes cross Rust and Tauri as `{ code, message }`.
- Frontend normalizers accept only the known code union; forged codes degrade
  to a plain `Error` and cannot trigger recovery branches.
- ERR-06 removed the remaining conflict-code flattening commands.
- A recursive guard scans every Rust source file and permits only the documented
  internal `apply_receipt` exception.
- ERR-05 remains a candidate: replace public string construction with a closed
  Rust enum and generated TypeScript union.

### Store-Backed Application Shell

- Outline, Editor, Documents, and Terminal use small, least-authority facades.
- Shared state follows keyed module stores and `useSyncExternalStore`.
- All 18 modes route through typed lazy adapters.
- Terminal commands retain generation-bearing session handles.
- Preview DOM identity and unrelated-pane render isolation are regression-tested.

## Shipped Product and Side Tracks

| Track | State on v1.1.3 |
|-------|-----------------|
| Documents and Files | Markdown Rich/Source/Preview, HTML Visual/Source/Preview, multi-tabs, split panes, optimistic concurrency, snapshots, safe file operations, virtualized Explorer tree with in-file search |
| Inbox and communications | File drops, Gmail, Outlook/Microsoft 365, Telegram, Kakao staging/relay surfaces, classification, approval, processing, bounded provider commands |
| Today and Tasks | File-backed lifecycle, prepare/execute/review, capacity, explicit calendar selection/publish, provider outbox and recovery |
| Drafts and Gap | Durable ideation, scheduled draft production, approval-gated promotion, frozen baselines, revision-pattern logging |
| Agents and Terminal | Claude/Codex/Kimi/Kiro runtimes, named agents, chat/runs/schedules, native PTY, persistent Terminal/Graph panel |
| Diagram | Schema v8, typed report datasets, pattern views, codec registry, templates, history, managed report asset insertion/update |
| Graph | Sigma/Graphology canvas, worker layout, saved views, local focus controls, reviewed relationship writes, dense-graph LOD |
| HWP engine bridge | Backend read/render/edit/compose/validate/capabilities through `hwped_*`; UI embedding remains undecided |
| Skills OTA | Five ownership tiers, doctor/dirty/reconcile/sync, minisign-verified independent bundle channel |
| Sites and HTML | Embedded native browser, safe HTML editing/preview sandbox, scoped local assets, passkey distribution kept opt-in behind a separately provisioned entitled build |

## Historical W-Sequence

| Reference | Current interpretation |
|-----------|------------------------|
| W1-W6 | M1 Catalog and the Hub read/cache foundation are shipped |
| W7-W12 | M2 Studio, M3 HWPX field/fill support, and M4 export are shipped |
| W13-W14 | M5 local Evidence Binder schema v2 is shipped |
| W15 | Hub evidence-index integration is a candidate, not active work |
| W16-W18 | Deck Studio is a candidate track |
| W19-W22 | Approval/finalize integration is partially backed by shipped Hub commands but lacks the user workflow |
| W23-W26 | Certification and KPI bundle work is a candidate track |
| W27-W34+ | Graph phases 8a/8b/8c and subsequent visual hardening are shipped; Hub graph metadata sync remains deferred |

## Candidate Delivery Tracks

These tracks are intentionally unranked. The next milestone must choose one
coherent outcome rather than activating the entire backlog.

### Evidence Reuse and Hub Integration

Target outcome: a local evidence binding can query Hub by SHA-256, show verified
reuse hints, and keep binary ownership local.

Candidate work:

- connect Binder candidates to the existing `evidence_index` read resource
- send only SHA-256 and metadata for lookup/reuse
- keep local verification, sidecar status, and submission selection distinct
- add offline/cache behavior and stale-result protection

### Approval and Finalize to Hub

Target outcome: a Studio package can enter a visible approval route and only an
approved version can become a finalized Hub document.

Shipped primitives already available:

- `hub_submit_gate`
- `hub_queue_drain`
- `hub_poll_gate`
- public/private deployment safety preflight
- durable offline queue

Candidate work:

- Studio submission action and durable gate identity in frontmatter
- approval route status UI and explicit user actions
- exact-state transition rules with revision-checked frontmatter updates
- finalized markdown, rendered artifacts, and linked evidence upload only after
  approval
- finalized version browser and audit chain in Catalog

This track requires a separate production-data approval gate before any live Hub
write verification.

### Deck Studio

Target outcome: a first-class Deck mode turns a reviewed slide plan into a
reorderable, regeneratable, hash-manifested deck package.

Candidate work:

- plan artifact and 14-style browser
- image/provider/HTML generation strategies
- page-level regenerate and drag reorder
- image folder, HTML deck, PPTX, and PDF outputs
- manifest hashes and resumable job state

### Certification and KPI Bundle

Target outcome: certification requirements and KPI narratives resolve against
finalized documents and evidence, then produce an auditable PDF bundle.

This depends on the approval/finalize track. It should not start from local
draft bodies or upload evidence a second time.

### Reliability, Security, and Evidence Debt

Candidate inputs from the archived v1.0 requirements:

- ERR-05 closed typed-error construction
- PERF-01..04 UI-thread blocking, lock duration, poison recovery, watcher prune
  filtering
- SEC-01/02 CSP and sanitizer regression coverage
- REL-01 process-group escalation for SIGHUP-resistant terminal children
- TEST-01..04 native Tauri E2E, coverage, large-component tests, app-menu smoke
- deliberate failing-CI trace reproduction
- Phase 1-3 Nyquist metadata reconciliation
- Phase 2 security report

### Structured Knowledge Intelligence

The Semantica-inspired plan remains a pattern source, not an installed runtime
or active phase. Potential pieces include structured decision frontmatter,
stable provenance, proposal-only entity/relation extraction, duplicate/conflict
candidates, and read-only graph analytics.

Embedding/vector search remains out of scope.

## Persistent Invariants

- The filesystem is authoritative; caches and indexes are disposable.
- `src-tauri/src/frontmatter/ops.rs` is the only frontmatter write path.
- A single-field write preserves unrelated bytes, comments, order, and quoting.
- Managed writes are schema-gated, snapshotted, revision-checked, and atomic.
- Hub body/binary upload is allowed only for an approved finalized document.
- AI and skill automation is suggestion-first; protected writes require
  approval.
- Provider and converter subprocesses use fixed argv, bounded output, timeout,
  cancellation, and safe diagnostics.
- New frontend shared state uses the existing module-store pattern.
- Terminal session commands retain generation validation.
- UI strings maintain Korean/English key parity.
- Entry JavaScript and initial CSS stay within enforced budgets.
- Skills ownership changes update `docs/SSOT-TIERS.md` and
  `docs/BOUNDARIES.md` together.

## Verification Contract

| Change class | Required evidence |
|--------------|-------------------|
| Any source change | `make verify` |
| User workflow or layout | Targeted unit tests plus `pnpm test:e2e` |
| Native macOS behavior | Real-app observation or signed artifact verification; Chromium mocks are insufficient |
| AI runtime/provider integration | Hermetic tests plus `make verify-integration` when real binaries are affected |
| Hub read path | Enabled and disabled/cache behavior, malformed response handling, and stale-request protection |
| Hub write path | Explicit production approval, safety preflight, denied/queued behavior, idempotency, and audit evidence |
| Release | PR CI, exact-tree main CI, Release Preflight, Release Bundles, updater manifest, notarization, CLI, and Homebrew hashes |

## Deliberate Scope Boundaries

Maru v0.5.0 does not commit to:

- semantic or embedding search
- a Maru account or default telemetry
- a built-in cloud-sync engine
- mobile distribution
- iMessage or Slack ingestion
- multi-user collaboration, CRDT, or realtime editing
- PDF annotation or OCR
- a public skill marketplace server
- agent-autonomous writes as the default behavior
- unsigned updater feeds

Additional deferred decisions:

- Hub graph metadata sync waits for a real Hub graph consumer.
- Voice intake waits for a selected transcription capability.
- Embedded hwp-editor UI and a resident `hwp mcp` process require separate
  lifecycle and packaging decisions.
- Binary `.hwp` conversion must be planned from released hwp-cli capabilities,
  not inferred from HWPX fill support.

## Sources of Truth

| Source | Authority |
|--------|-----------|
| `README.md` | Current product, architecture, storage, safety, development, and release contracts |
| `CHANGELOG.md` | Release-by-release shipped changes |
| `.planning/ROADMAP.md` | Active GSD milestone and phases; currently v1.1 phases 6-11 |
| `.planning/MILESTONES.md` | Completed milestone record and post-close amendments |
| `.planning/reports/MILESTONE_SUMMARY-v1.0.md` | v1.0 outcome, decisions, evidence, and deferred work |
| `.planning/milestones/v1.0-*` | Archived requirements, roadmap, audit, and phase artifacts |
| `docs/*.md` | Feature-specific implementation and operating contracts |
| `~/workspace/work/_meta/rules/*.md` | Workspace-wide document, lifecycle, Hub, and evidence rules |

## Starting the Next Milestone

1. Select one user outcome from the candidate tracks.
2. Recheck the current code, connected service capability, and production data
   constraints.
3. Run `$gsd-new-milestone` to create requirements and a phase roadmap.
4. Keep unrelated candidates deferred; do not convert this document wholesale
   into active requirements.
5. Define release and live-verification gates before implementation begins.

# Semantica adoption plan

This document selects which capabilities of the semantica knowledge-graph
framework (v0.6.6) Maru should adopt, and lays out the implementation plan.
It is based on the codebase analysis under
`references/ai-tools/semantica/.planning/codebase/` (`ARCHITECTURE.md`,
`STRUCTURE.md`, `STACK.md`, `CONVENTIONS.md`, `INTEGRATIONS.md`, `TESTING.md`,
`CONCERNS.md`, refreshed 2026-08-23).

## Adoption mode

**Pattern-selective reimplementation.** The semantica package itself is not
installed: its core dependency set pulls in torch, transformers and spacy
(multi-GB), which contradicts Maru's local-first footprint. Instead, the
selected algorithms and design patterns are reimplemented on top of what Maru
already ships:

- the skills Python venv (`src-tauri/skills-bootstrap/envs/default/`), which
  already carries networkx, graspologic and graphifyy;
- the Claude-CLI delegation pattern used by `src-tauri/src/inbox_classifier.rs`
  (build prompt -> CLI subprocess -> parse typed result) for anything that
  needs language understanding;
- the existing approval/proposal gates (`src-tauri/src/approval.rs`,
  `src-tauri/src/graph_authoring.rs`, Hub `proposal_queue`) for every write.

**Excluded on purpose:**

- Embedding / vector semantic search. This is on the README v1 "Hard No" list
  ("keyword + wikilink + git-grep cover 10k notes") and stays excluded. All
  similarity features below use string similarity and graph neighborhoods only.
- Semantica's heavy pipeline machinery (PipelineBuilder, ExecutionEngine),
  REST/Explorer surfaces, the full W3C PROV-O model, and OWL/SHACL reasoning.

## Feature mapping

| # | Semantica source | Maru gap today | Adoption shape | Effort / risk |
|---|---|---|---|---|
| 1 | `semantica/context/decision_recorder.py`, `causal_analyzer.py` | Decision notes exist (`type: decision`) and `src/lib/graph/decisionChains.ts` renders supersedes chains, but the record model is informal: no category / scenario / reasoning / outcome / confidence fields, no causal edges beyond supersession | Structured decision frontmatter schema + causal-link field + decision query surface. Pure schema + read-side | Low / low |
| 2 | `semantica/provenance/` (+ the scattered-MD5 lesson in CONCERNS.md) | Provenance is real but fragmented: evidence sha256 (`evidence_binder.rs`), gap log (`gap.rs`), run events (`agent_host/event_store.rs`) each invented their own identity scheme | One provenance helper convention + a single stable-id/hashing utility; document how the three existing surfaces join on it | Low / low |
| 3 | `semantica/semantic_extract/` (NER, relation/triplet extraction) | `src-tauri/src/kg_refs.rs` matches other notes' titles/aliases by regex whole-phrase only; no typed relations, no entities that are not note titles | Claude-CLI extraction pass producing typed relation/entity proposals, applied only through `graph_authoring.rs` (relations stay `related \| supersedes \| superseded_by`) | Medium / medium |
| 4 | `semantica/deduplication/`, `kg/entity_resolver.py` | No content-similarity dedup; duplicate person/project/entity notes accumulate silently | Candidate detection via string similarity + shared graph neighborhoods; merge is a proposal behind the approval gate, never automatic | Medium / medium |
| 5 | `semantica/conflicts/` (conflict detection) | Nothing flags contradictory claims about the same entity across notes | LLM-assisted conflict candidates surfaced as review proposals only; no auto-resolution | Medium / medium |
| 6 | `semantica/ontology/` (schema generation/validation) | The vault's `type` / `domain` / `topics` vocabulary is a de-facto ontology, enforced at write time by `vault_guard.rs` but defined nowhere as a versioned artifact | Formalize the vocabulary into one versioned schema file; `vault_guard.rs` and vault-lint validate against it. No OWL/SHACL | Low / low |
| 7 | `semantica/change_management/` | Snapshot-before-write exists, but there is no queryable record of how the graph changed over time | Append-only graph mutation log beside the existing snapshots | Low / low |
| 8 | `mcp/tools/` (graph/decision MCP tools) | `sidecars/maru-mcp/index.mjs` exposes search/read/proposal tools only | Add read-only graph-analytics and decision-query tools. Writes stay `proposal.create`; per ROADMAP, no new MCP tool without a Hub `proposal_queue` counterpart | Low / low |

## Anti-pattern lessons (from CONCERNS.md)

Worth applying as conventions, independent of the features above:

- **No dual implementations.** Semantica ships two MCP servers and two FastAPI
  app factories that drifted and once nearly reverted a fixed CVE. Maru: one
  implementation per surface; the `agentCapabilities.test.ts` drift-guard
  pattern (parse the Rust source from TS tests) is the model to reuse when two
  views of one contract must exist.
- **No god files.** Their `cli.py` reached 4,422 lines. Keep new Rust modules
  focused (one file per capability, like `gap.rs` / `kg_refs.rs`).
- **No silent exception swallowing.** Their blanket `except Exception` hid
  security-validation errors. New extraction/resolution code must log
  degradation explicitly.
- **Tests must be collected.** They had regression tests pytest never picked
  up due to filenames. New vitest/cargo tests must be verified as actually
  running in the gate.

## Implementation plan

Four stages, in dependency order. Each stage is independently shippable and
follows the ROADMAP weekly-deliverable style.

### S1 — Foundations: decision records, provenance, change log

- Define the structured decision frontmatter schema (category, scenario,
  reasoning, outcome, confidence, causal links) as an extension of the
  existing `type: decision` note; validation in `src-tauri/src/vault_guard.rs`.
- Extend `src/lib/graph/decisionChains.ts` to consume the new fields (render
  outcome/confidence, causal edges distinct from supersession).
- Introduce the unified provenance helper: one stable-id/hashing utility used
  by `evidence_binder.rs`, `gap.rs` and `agent_host/event_store.rs`; document
  the join convention.
- Append-only graph mutation log next to the existing snapshot-before-write.
- Gate: `cargo test --lib`, `pnpm test`, `pnpm typecheck`, `pnpm lint:i18n`.

### S2 — Extraction: LLM-assisted entity/relation proposals

- New `src-tauri/src/entity_extract.rs` modeled on `inbox_classifier.rs`:
  build a prompt over a document (or a graph neighborhood), dispatch through
  the agent CLI runtime, parse a typed result (entities + typed relation
  candidates).
- Proposals flow through `graph_authoring.rs` propose/apply; nothing writes
  frontmatter outside `frontmatter/ops.rs`; byte-identity rule holds.
- Frontend: extend `src/lib/kgRefs.ts` / the references UI to show proposed
  (not just matched) references with accept/reject.
- Gate: S1 gates + e2e covering propose/apply/reject.

### S3 — Quality: entity resolution and conflict candidates

- New `src-tauri/src/entity_resolve.rs`: duplicate-candidate detection using
  string similarity (normalized titles/aliases, Korean-aware) + shared graph
  neighborhoods from the existing graph model. No embeddings.
- Merge flow as a proposal: preview of combined wikilink retargeting, applied
  only through the approval gate.
- Conflict detection: Claude-CLI pass over notes sharing an entity, emitting
  contradiction candidates as review items. No auto-resolution.
- Gate: S1 gates + focused cargo tests for the similarity/resolution logic.

### S4 — Surface: versioned vault schema + MCP read tools

- Extract the `type` / `domain` / `topics` vocabulary into a versioned schema
  artifact; `vault_guard.rs` and vault-lint validate against it; schema
  version bumps are explicit.
- Add read-only graph-analytics and decision-query tools to
  `sidecars/maru-mcp/index.mjs` (path-escape guards per the existing
  `safeJoin` pattern). Register the Hub `proposal_queue` counterpart before
  any write-capable tool is even proposed.
- Gate: S1 gates + `make verify`, real-workspace catalog smoke
  (`MARU_CATALOG_BENCH_WORKSPACE=~/workspace/work cargo test --lib --
  --ignored catalog_real_workspace_smoke`), MCP smoke (`scripts/e2e-mcp-smoke.mjs`).

## Invariants carried through every stage

1. Frontmatter byte-identity: all YAML mutation goes through
   `src-tauri/src/frontmatter/ops.rs`.
2. Proposal-only writes: every extraction/resolution/conflict output lands as
   a proposal behind `approval.rs`; nothing silent, nothing destructive.
3. `.maru/*` caches (extraction caches, candidate lists) stay disposable and
   gitignored; canonical state lives in the workspace.
4. Workspace path components stay ASCII (macOS NFD rule).
5. No embedding/vector store is introduced by any stage.

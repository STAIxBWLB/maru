# Phase 2: Shared Scanner and Path Invariants - Context

**Gathered:** 2026-08-23
**Status:** Ready for planning

<domain>
## Phase Boundary

Collapse five diverged directory prune lists and ~20 ad-hoc path-containment
checks into one of each, so a new command author has exactly one prune list and
one containment helper to reach for. Covers SCAN-01..05: one shared
`GENERATED_DIRS` honored by all five scanners, `.git`/`.venv` excluded from
workspace and vault scans, a canonical `ensure_within` importable outside
`maru_dir.rs`, a loud failure when a home-rooted path is joined against a
non-absolute base, and deletion of the stray `Users/` tree at the repo root.
No new user-facing capability; behavior preservation is proven by the Phase 1
gate set.

</domain>

<decisions>
## Implementation Decisions

### Module placement
- **D-01:** A new `src-tauri/src/paths.rs` module is the canonical home. Not a
  widened `workspace_files.rs` (a scanner module should not own path
  invariants), not `vault.rs` (also a scanner).
- **D-02:** `paths.rs` holds all three invariants together:
  `pub const GENERATED_DIRS`, `ensure_within`, and the absolute-base join
  guard. One module = "the one place to reach for" the phase goal names.
  — **Reversibility:** costly — once five scanners and new commands import it,
  moving the module touches every call site.

### Prune list union
- **D-03:** One flat `GENERATED_DIRS` constant, the full 14-entry union:
  `node_modules, target, dist, build, .next, .turbo, .cache, .git, .venv,
  .context, .omc, .omx, .pnpm-store, __pycache__`. No core+extras split — a
  per-scanner exception list re-opens the divergence this phase exists to
  close. — **Reversibility:** costly — splitting later means re-auditing every
  scanner's coverage expectations.
- **D-04:** All five scanners consume the union, including
  `evidence_binder.rs:1315`'s 4-entry `matches!`, which widens 4 → 14. The
  resulting scan-scope reduction (no `.git`/`.venv` descent anywhere) is the
  intended behavior change of SCAN-02, not a regression.
- **D-05:** `maru_dir.rs:79`'s twelve-entry `MARUIGNORE_DEFAULTS` stays
  separate and unchanged — it is a user-facing file format, not a scanner
  constant (locked from roadmap/CONCERNS).

### Canonical example strategy
- **D-06:** `ensure_within` is promoted to `paths.rs` with a module-level doc
  example and unit tests as the canonical demonstration. No existing caller is
  converted — `Component::ParentDir` checks, substring `..` checks, and
  `ensure_within`'s `starts_with` check are not equivalent, so converting a
  caller is a behavior change this phase must not smuggle in.
- **D-07:** Path containment stays lexical. No `canonicalize()` in
  `ensure_within` — user-created symlinks inside a workspace stay part of it
  (locked project constraint).

### SCAN-04 / SCAN-05 guard
- **D-08:** The non-absolute-base guard returns `Err`, matching the
  `Result<T, String>` command convention. No `assert!`/panic (release crash)
  and no `debug_assert!` (release unguarded).
- **D-09:** The guard lives inside `maru_home()` / `install_root_base()`
  (i.e., `home_dir()`-derived roots in `skill_host/fs.rs`), which validate
  `is_absolute` before returning. One check covers every join site; a
  join-site helper can be skipped by the next author.
- **D-10:** SCAN-05's delete of `Users/` ships in the same phase as the guard
  — deleting without the guard is cosmetic (locked from roadmap).

### Claude's Discretion
- Exact unit-test shapes, fixture layout, and how each scanner's call site is
  rewired to the shared constant (mechanical, planner-owned).
- Whether `ensure_within`'s error message ("Path escapes the .maru directory")
  is generalized now that it is no longer maru-dir-specific.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Scope and requirements
- `.planning/REQUIREMENTS.md` §Scanner and Path Invariants — SCAN-01..05 definitions
- `.planning/ROADMAP.md` §Phase 2 — success criteria and planning notes (union not intersection, no retrofit, lexical containment)

### Evidence and constraints
- `.planning/codebase/CONCERNS.md` §Tech Debt — the five diverged prune lists with line numbers, the ~20 containment checks, the stray `Users/` tree, and the prescribed fix approaches
- `.planning/PROJECT.md` §Constraints — lexical path containment, write gating, frontmatter invariants that plans must not violate

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src-tauri/src/workspace_files.rs:21` — `pub(crate) const GENERATED_DIRS` (7 entries); the base list the union extends.
- `src-tauri/src/maru_dir.rs:189` — `ensure_within(parent, child)`, the helper to promote. Uses `lexical_normalize`; keep it lexical.
- `src-tauri/src/vault.rs:581,618` — `resolve_inside_vault` / `lexical_normalize`; sibling lexical helpers whose conventions `paths.rs` should match.
- `src-tauri/src/skill_host/fs.rs:28,35` — `env_root` / `install_root_base`, the join sites behind the stray `Users/` tree; home of the D-09 guard.

### Established Patterns
- Rust modules are flat, one file per feature, re-exported from `src-tauri/src/lib.rs` — `paths.rs` follows this exactly.
- Commands return `Result<T, String>` — the D-08 guard conforms.
- Deliberate simplifications carry `ponytail:` comments — if the guard has a known ceiling, document it in that style.

### Integration Points
- Five prune-list call sites to rewire: `workspace_files.rs:21`, `vault.rs:22`, `secrets.rs:12`, `project_activity.rs:27`, `evidence_binder.rs:1315`.
- `src-tauri/src/lib.rs` module declarations — add `mod paths;`.
- Phase 1's `make verify` gate set (clippy `-D warnings`, fmt-check, eslint, typecheck, e2e) is live — every change must pass it.

</code_context>

<specifics>
## Specific Ideas

- The union must include `.git` and `.venv` (SCAN-02 is the user-visible win:
  workspace scans over repo-containing folders currently walk git object
  storage).
- The guard test from the roadmap stands: joining a `maru_home()`/`env_root()`
  result against a non-absolute base errors rather than creating a tree in the
  working directory.

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope.

</deferred>

---

*Phase: 2-shared-scanner-and-path-invariants*
*Context gathered: 2026-08-23*

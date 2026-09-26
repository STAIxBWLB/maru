# Review instructions

Read by `/codex:review`, `/code-review`, and human reviewers alike.

## Passes

Run these passes and tag every finding with its pass:

- **Bugs**: logic errors, broken edge cases, regressions. React hook dependencies and floating
  promises are lint-enforced; look for what lint cannot see.
- **Security**: HTML sinks that bypass the DOMPurify helper, subprocess calls that build a shell
  string instead of fixed argv, credentials reaching vault files, logs, localStorage, or fixtures,
  and writes that escape the workspace root.
- **Compliance**: the change matches the issue spec and the approved plan, and respects the
  contracts below.

## Repo focus (from README and docs/)

- **Filesystem is the source of truth**: durable user-authored workspace data (notes, tasks,
  drafts, evidence, diagrams) is derived from real files, and uninstalling Maru must not lose it.
  Transient app state such as loading flags, filters, selections, and error banners is component
  state and is not a finding.
- **Managed writes**: frontmatter changes go through `src-tauri/src/frontmatter/ops.rs` only, and
  managed writes validate, snapshot, and use revision-checked atomic replacement. Vault note
  deletion stays MCP-only.
- **IPC errors**: frontend-consumable conflicts cross IPC as a structured `IpcError`; an unknown or
  forged code must degrade to a plain error and must not satisfy a recovery branch.
- **Module boundaries**: `src/lib/` does not import components, **except for documented type-only
  legacy boundaries** (see `src/lib/knowledgeModeStore.ts`, `src/lib/terminalPanelStore.ts`);
  a value import from `src/components/` is a finding, a `import type` at a documented boundary is
  not. Nothing imports `src/App.tsx`, and shared state stays on keyed module stores with
  `useSyncExternalStore`.
- **Approval gates**: seeds never create schedules, and `metadata.origin` is never overwritten.
- **Release surfaces**: version changes touch all five surfaces and never go backwards.
- **Korean text**: no slicing with backend offsets in JS; IME behavior is not provable in Chromium
  e2e, so macOS-affecting changes need a real-app check.

## What Important means here

Reserve Important for findings that break behavior, lose or corrupt user files, leak credentials,
breach a safety contract above, or ship the `native-e2e` feature into a release. Style and naming
are nits.

## Cap the nits

Report at most 5 nits per review; summarize the rest as a count.

## Do not report

- Generated or tool-managed paths: `src-tauri/icons/`, `src-tauri/gen/schemas/`, `dist/`,
  `pnpm-lock.yaml`, `src-tauri/Cargo.lock`.
- The frozen `src-tauri/skills-bootstrap/` snapshot and `docs/performance/*.json` evidence files,
  unless the change forges gate input.
- Anything `make verify` or CI already enforces: typecheck, ESLint, i18n parity, icon freshness,
  DOM sanitizer, type tokens, select chrome, command isolation, `cargo fmt`, clippy, TS and Rust
  tests, the frontend bundle budget, and the version check.
- Missing DOM snapshots in a Playwright trace: they are disabled on purpose for CI cost.

## Feedback into AGENTS.md

When the same finding appears twice, the correction goes into `AGENTS.md` in the same PR.

---

Findings do not approve or block on their own. Human approval and the merge-on-instruction gate
stay as they are (`_meta/rules/development-lifecycle.md` §2, §6).

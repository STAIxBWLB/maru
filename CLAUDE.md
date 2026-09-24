# Maru

Local-first desktop workspace (React 19 + TypeScript over a Tauri 2 Rust core) where a folder on
disk is the workspace. App `Maru`, binaries `maru` (desktop) and `maru-cli` (standalone, installed
as `maru`).

**`README.md` is the source of truth** for structure, module boundaries, safety contracts, the
release process, and the scope rules. This file does not restate it: it carries the gate, the
conventions an agent needs before its first commit, and the traps that are not obvious from the
code. When a project rule changes, change `README.md`, not this file (same policy as `AGENTS.md`).

## Commands

- Install: `make install` (pnpm 9.15.0, Node >= 22; generates icons)
- Dev: `pnpm dev` (Vite on 127.0.0.1:5307), `pnpm tauri:dev` (real app)
- Build: `pnpm build` (typecheck + frontend), `pnpm tauri:build`
- Bare `make` prints the full target list.

## Verifying your work

```bash
make verify        # the gate CI runs: typecheck, lint, version/icon/i18n/DOM/type-token guards,
                   # TS + Rust tests, fmt, clippy, frontend build, command isolation
make test-e2e      # Playwright (chromium, own web server on 5307)
```

- `make` stops at the **first** failing target, so a run that reaches the end is the healthy signal;
  the failing target name is the diagnosis.
- **Run `make verify` before reporting a task complete, and paste the output.** Add `make test-e2e`
  when frontend behavior changed.
- When a test fails, fix the code, not the test. Do not weaken or delete a guard to make a run pass.
- `make test-e2e-native` (WebdriverIO against the real app) is macOS-only and not hermetic, so it is
  deliberately outside `verify`. CI compiles it per PR and runs it on `main`.
- Chromium e2e proves nothing about WKWebView, the native PTY, Korean IME, menus, or notarization.
  macOS-affecting changes need a real-app check.

## Conventions

- Conventional commits with a scope and the trailing PR number: `feat(meetings): ... (#321)`.
  Release commits are `chore(release): v<version> - <Release Name> (#PR)`.
- Branches `<type>/<kebab-topic>`; work lands through PRs, not direct pushes to `main`.
- Versions live on **five surfaces** that must stay in sync (`package.json`, `tauri.conf.json`,
  `src-tauri/Cargo.toml`, `src-tauri/maru-cli/Cargo.toml`, `src-tauri/Cargo.lock`);
  `make release-version-check` enforces it. Releases bump the patch; the minor comes from the
  milestone in `.planning/STATE.md`.
- Cross-repo ownership: `docs/BOUNDARIES.md`. Skill tiers: `docs/SSOT-TIERS.md`. Rationale for a
  given decision: the `D-xx` / `GATE-xx` IDs in `.planning/**/NN-CONTEXT.md`.

## Things the agent gets wrong

- **Stale native-e2e binary**: cargo does not track `dist/` as an input, so `make test-e2e-native`
  touches `src-tauri/build.rs` first. A webview stuck on `about:blank` is this.
- **`VITE_NATIVE_E2E=1` output is not shippable**: re-run `pnpm build:frontend` before inspecting a
  production artifact. The `native-e2e` cargo feature must never reach a release; three guards check.
- **Command isolation count**: `check-command-isolation` expects exactly **382** registered commands
  with recorded evidence. Adding or removing a `#[tauri::command]` means updating the evidence JSON
  under `docs/performance/`, which is input to the gate and must not be hand-forged.
- **No raw `font-size: Npx` in `src/styles.css`**: use the `--type-*` / `--read-*` scale in
  `src/foundations.css`.
- **Every `dangerouslySetInnerHTML` sink** must trace to the DOMPurify-backed helper, or
  `check-dom-sanitizer` fails.
- **Generated, do not hand-edit**: `src-tauri/icons/` (regenerate with `make icons` from
  `src/assets/brand/`), `src-tauri/gen/schemas/`, `dist/`, both lockfiles.
- **`src-tauri/skills-bootstrap/` is a frozen snapshot**, not the live OTA source; refresh only via
  `make skills-bootstrap-refresh`.
- **Never lower the version** in `package.json`: CI fails the PR, because a lower version overwrites
  `latest.json` and strands updaters. Release tags must start with `v`.
- **Module boundaries**: `src/lib/` must not import components, except for the documented type-only
  legacy boundaries (`import type` only, as in `knowledgeModeStore.ts` and `terminalPanelStore.ts`).
  Nothing imports `src/App.tsx`, and shared state uses keyed module stores with
  `useSyncExternalStore`, not a new state library.
- **Frontmatter writes go through `src-tauri/src/frontmatter/ops.rs` only**; vault note deletion
  stays MCP-only. Do not slice Korean text with backend offsets in JS.
- **Maru never writes `~/.claude/CLAUDE.md`, `~/.claude/settings*.json`, or `~/.claude/hooks/**`**
  (`docs/BOUNDARIES.md`).

---

Contract and update rule for this file: `_meta/rules/development-lifecycle.md` §6 in the workspace
repo. When the same mistake appears twice, add the correction here in the same PR.

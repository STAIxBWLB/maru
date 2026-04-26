# Anchor

Local-first markdown vault desktop app. Tauri 2 + Rust + React 19 + TypeScript.

> Vault-First Personal AI OS — combines a markdown vault (lifted from
> [tolaria](https://github.com/refactoringhq/tolaria)), an AI inbox model
> (informed by tidy), and a gesture/voice document-edit mode (absorbed
> from [anchor-editor](https://github.com/STAIxBWLB/anchor-editor)). See
> the implementation plan at `~/.claude/plans/kind-doodling-quill.md`.

## Status — Phase 0 (Hardening)

- ✅ git repo bootstrapped (origin remote pending — see Open Q8 in plan)
- ✅ Frontmatter line-by-line editor (lifted from tolaria) — preserves YAML
  key order and comments. Safe to point at existing Obsidian vaults.
- ✅ Multi-vault registry at `<config>/com.anchor.app/vaults.json` with
  optional `external_writer: "mcp-obsidian"` flag for Obsidian-managed
  vaults (anchor reads, write delegation lands in Phase 2).
- ✅ Filesystem walkdir with unlimited depth and `.anchorignore` support
  (gitignore-style segment matching).
- ✅ Korean filename safety (NFC/NFD round-trip is OS-handled; portable
  name validation lifted from tolaria).
- ✅ ko-KR and en-US as **equal** first-class locales — every UI string
  must exist in both dictionaries (`assertParityOrThrow` fails the build
  if they drift).
- 🚧 Phase 1: BlockNote editor + raw mode toggle, command palette, typed
  neighborhood navigation, git commit-from-app.

## Development

```bash
pnpm install

# Browser dev (mocked Tauri):
pnpm dev

# Native Tauri dev:
pnpm tauri:dev

# Type check:
pnpm typecheck

# Production build:
pnpm build

# Rust tests (frontmatter round-trip, vault scan, vault registry):
cd src-tauri && cargo test --lib
```

## What Phase 0 ships

- Open any folder as a vault. The user's existing `~/workspace/work` and
  `~/workspace/vault` are valid targets.
- List, read, edit, save markdown notes without mangling frontmatter.
- Create new notes with deterministic frontmatter ordering
  (`type → status → created_at → updated_at → id`).
- Create version snapshots under `<vault>/.anchor/versions/`.
- Switch between registered vaults; last-opened note per vault is
  remembered.
- Toggle UI language between Korean and English.

## What Phase 0 explicitly does NOT ship

- AI integrations (the prior `ai.rs` mock has been removed; Phase 2
  introduces real Claude Code CLI / Anthropic API dispatch).
- BlockNote rich editor (Phase 1).
- Multi-window, conflict resolver, semantic search (Phase 5+).
- Public skill marketplace (Phase 5+).
- Mobile (out of scope).

See the full roadmap in the plan file.

## Vault layout

A vault is any folder containing `.md` (or `.markdown`, `.html`, `.htm`)
files. anchor stores per-vault state at:

```
<vault>/
  .anchor/
    versions/        # snapshots created via the "Version" button
  .anchorignore      # optional, gitignore-style segment patterns
```

`.anchorignore` example for the user's `~/workspace/work`:

```
node_modules
.venv
dist
_sys/env
target
```

## License

UNLICENSED — internal RISE/Anchor work. Contains code lifted from
tolaria (refactoringhq) under tolaria's license; attribution preserved
in source headers.

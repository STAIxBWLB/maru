# Anchor / dotfiles-v2 Boundary

Anchor owns skills and runtime federation. `dotfiles-v2` owns environment and
tool settings. This file mirrors the workspace policy in
`~/workspace/work/_sys/rules/skills-ssot.md`.

## Anchor Owns

- `~/.anchor/**`
- `~/.anchor/skills/registry.json`
- `~/.anchor/skills/_builtin`, `_sources`, `_managed`
- `~/.anchor/env`
- `~/.anchor/skills/<name>` runtime symlinks
- `~/.claude/skills/<name>` and `~/.codex/skills/<name>` skill symlinks created
  through Anchor install actions

Anchor must not write:

- `~/.claude/CLAUDE.md`
- `~/.claude/settings.json`
- `~/.claude/settings.local.json`
- `~/.claude/hooks/**`
- non-skill global tool settings owned by `dotfiles-v2`

## dotfiles-v2 Owns

- AGENTS fan-out and global instruction targets
- Claude/Codex/Antigravity settings and status line integration
- shell setup and package/environment bootstrap
- read-only skill inventory reports

`dotfiles-v2` must not write `~/.claude/skills/**`; that directory is the
Anchor skill federation surface.

## Conflict Rule

If a change needs to alter this ownership table, update both repositories'
boundary documents in the same change set.

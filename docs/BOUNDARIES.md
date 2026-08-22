# Maru / dotfiles-v2 Boundary

Maru owns skills and runtime federation. `dotfiles-v2` owns environment and
tool settings. This file mirrors the workspace policy in
`~/workspace/work/_meta/rules/skills-ssot.md`.

## Maru Owns

- `~/.maru/**`
- `~/.maru/skills/registry.json`
- `~/.maru/skills/_builtin`, `_sources`, `_managed`
- `~/.maru/env`
- `~/.maru/skills/<name>` runtime symlinks
- `~/.claude/skills/<name>` and `~/.codex/skills/<name>` skill symlinks created
  through Maru install actions

Maru must not write:

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
Maru skill federation surface.

## Conflict Rule

If a change needs to alter this ownership table, update both repositories'
boundary documents in the same change set.

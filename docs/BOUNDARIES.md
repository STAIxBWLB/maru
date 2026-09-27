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
- Generic skill symlinks created through Maru install actions in Claude,
  Codex, Kimi, Qwen, Grok, and OpenCode skill roots; runtime environment overrides
  and recorded root ownership are respected (see README selected-agent federation)
- Existing external/native plugin skill directories remain owned by their
  installers and are never replaced by federation

Maru must not write:

- `~/.claude/CLAUDE.md`
- `~/.claude/settings.json`
- `~/.claude/settings.local.json`
- `~/.claude/hooks/**`
- non-skill global tool settings owned by `dotfiles-v2`

Maru may read `dot ai policy resolve --json` and apply its typed decision to
one invocation. The opt-in lives in Maru settings; native model, permission,
and profile configuration remains owned by dotfiles. Policy resolution never
accepts an arbitrary executable or unvalidated launch arguments.

## dotfiles-v2 Owns

- AGENTS fan-out and global instruction targets
- Claude/Codex/Antigravity settings and status line integration
- shell setup and package/environment bootstrap
- Read-only skill inventory reports and agent/tool/skill selection UI
- Orchestration of selected generic skill deployment through Maru's versioned
  CLI capability contract; Maru retains the actual write operations
- Agent CLI installation and updates, instructions, and native add-on installers;
  their native skill packages are separate from Maru-owned generic federation

`dotfiles-v2` must not directly copy or rewrite generic skill trees in any agent
root. It calls `maru skills capabilities --json` and selected `skills sync`;
unsupported Maru releases are reported as pending. Native installers may manage
their own plugin packages, but neither side may overwrite the other's entries.
Global instructions, authentication, trust, hooks and unrelated runtime settings
remain outside Maru federation.

## Conflict Rule

If a change needs to alter this ownership table, update both repositories'
boundary documents in the same change set.

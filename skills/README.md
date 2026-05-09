# STAI x BWLB Skills

Public skills catalog for Codex and Claude Code. This repo contains reusable skill packages plus the shared runtime/helpers they use.

## Layout

```
skills/<name>/SKILL.md     public skill packages
env/                       shared Python/Node runtime scaffold
lib/build-graph.py         shared graph builder
lib/vault_adapter.md       Obsidian MCP vault access rules
docs/                      shared reference catalogs
manifest.json              Anchor-compatible skills manifest
```

There is no category subdirectory split or legacy helper directory split in this repo.

## Catalog

- Document toolkits: `hwpx`, `pptx-toolkit`, `xlsx-toolkit`
- Korean writing: `gaejosik`
- Slide deck prompts: `canva-deck`, `notebooklm-deck`, `gpt-images-deck`
- Design system: `design-init`, `design-motion`, `design-system`, `design-review`, `design-a11y`
- Task and git: `task-management`, `git-sync`
- IO and inbox/outbox: `io-mso`, `io-gws`, `io-telegram`, `io-kakao`, `inbox-intake`, `inbox-process`, `meeting-notes`, `share-outbox`
- Vault workflows: `vault-extract`, `vault-connect`, `vault-sync`, `vault-learn`, `vault-lint`, `vault-graph`, `vault-pipeline`, `vault-refactor`, `vault-rename`, `vault-update`, `vault-next`, `vault-remember`, `vault-rethink`, `vault-stats`
- Skill analysis: `skill-mine`

## Install

```bash
# Claude Code
./install.sh
./install.sh -n

# Codex
./install-codex.sh
./install-codex.sh -n

# Anchor internal target
./install-anchor.sh -n

# Specific skills
./install.sh vault-lint vault-graph
./install-codex.sh task-management skill-mine
```

Both installers symlink only directories containing `SKILL.md` from `skills/`.
Anchor normally owns `~/.anchor/skills/registry.json`; `install-anchor.sh`
only creates optional symlinks under `~/.anchor/skills/installed/`.

Anchor can bootstrap this repo's shared runtime into its runtime root:

```bash
env/setup.sh --target ~/.anchor/env --dry-run
env/setup.sh --target ~/.anchor/env
```

## Runtime Values

Skill packages must not contain personal IDs, secrets, or workspace-only values. Runtime values belong in the caller's workspace configuration, usually `workspace.config.yaml`.

Vault-facing skills discover vault paths, project registry paths, and log paths from workspace config and use Obsidian MCP for vault markdown. See `lib/vault_adapter.md`.

## Contributing

Keep skills self-contained and reusable. Do not add private identities, real credentials, institution-specific internal details, or local absolute paths to public skill packages.

MIT — see `LICENSE`.

# Anchor Bundled Skills

Skills bundle embedded by Anchor. This directory is the T1 core source for
skills that must ship with the desktop app. Public/private extension skills
belong in the Anchor source checkouts under `~/.anchor/skills/_sources/`.

## Layout

```
skills/<name>/SKILL.md     Anchor-bundled T1 skill packages
envs/default/              shared Python/Node runtime scaffold
lib/build-graph.py         shared graph builder
lib/vault_adapter.md       Obsidian MCP vault access rules
docs/                      shared reference catalogs
manifest.json              Anchor-compatible skills manifest
```

There is no category subdirectory split or legacy helper directory split in
this bundle.

## Catalog

- Document toolkits: `hwpx`, `pptx-toolkit`, `xlsx-toolkit`
- Korean writing: `gaejosik`
- Slide deck prompts: `canva-deck`, `notebooklm-deck`, `gpt-images-deck`
- Design system: `design-init`, `design-motion`, `design-system`, `design-review`, `design-a11y`
- Project workflows: `business-unit-lifecycle`
- Task and git: `task-management`, `git-sync`
- IO and inbox/outbox: `io-mso`, `io-gws`, `io-telegram`, `io-kakao`, `inbox-intake`, `inbox-process`, `meeting-notes`, `share-outbox`
- Vault workflows: `vault-extract`, `vault-connect`, `vault-sync`, `vault-learn`, `vault-lint`, `vault-graph`, `vault-pipeline`, `vault-refactor`, `vault-rename`, `vault-update`, `vault-next`, `vault-remember`, `vault-rethink`, `vault-stats`
- Skill analysis: `skill-mine`

## Runtime Federation

Anchor materializes this bundle into `~/.anchor/skills/_builtin`, records it in
`~/.anchor/skills/registry.json`, and installs user-facing skill entrypoints as
symlinks:

```text
~/.anchor/skills/<name> -> ~/.anchor/skills/_builtin/skills/<name>
~/.claude/skills/<name> -> ~/.anchor/skills/<name>
```

Do not install these packages by copying files manually. Use Anchor's Skills UI
or `skill_host` commands so registry state and symlinks stay consistent.

Anchor can bootstrap this bundle's shared runtime into its runtime root:

```bash
envs/default/setup.sh --target ~/.anchor/env --dry-run
envs/default/setup.sh --target ~/.anchor/env
```

## Runtime Values

Skill packages must not contain personal IDs, secrets, or workspace-only values. Runtime values belong in the caller's workspace configuration, usually `workspace.config.yaml`.

Vault-facing skills discover vault paths, project registry paths, and log paths from workspace config and use Obsidian MCP for vault markdown. See `lib/vault_adapter.md`.

## Contributing

Keep bundled skills self-contained and reusable. Do not add private identities,
real credentials, institution-specific internal details, or local absolute paths
to T1 packages.

MIT — see `LICENSE`.

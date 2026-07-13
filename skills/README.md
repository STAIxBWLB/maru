# Maru Bundled Skills

This directory is the T1 core skill source, deployed as a signed OTA bundle
independently of app releases. Public/private extension skills belong in the
Maru source checkouts under `~/.maru/skills/_sources/`.

## Deployment (skills-channel OTA)

Merging a change under `skills/**` to `main` triggers
`.github/workflows/release-skills.yml`, which verifies (`make skills-verify`),
packages (`make skills-package`), signs with the Tauri updater key, and
uploads immutable assets (`maru-skills-r<run-id>-<sha>.zip` + metadata JSON +
`.sig` files) to the fixed `skills-channel` prerelease. No app, CLI, or
Homebrew build runs for skill-only changes.

The app checks the channel at launch and applies the newest bundle
automatically when the local copy is clean and runtime-compatible; manual
paths are the Skills UI and `maru skills update --check|--apply`.

A frozen snapshot of this tree lives at `src-tauri/skills-bootstrap/` and is
embedded in the binary ONLY as the offline first-run fallback. It is
deliberately not synced with `skills/`; refresh it explicitly when cutting an
app release that should seed newer skills offline.

## Layout

```
skills/<name>/SKILL.md     Maru-bundled T1 skill packages
envs/default/              shared Python/Node runtime scaffold
lib/build-graph.py         shared graph builder
lib/vault_adapter.md       Obsidian MCP vault access rules
docs/                      shared reference catalogs
manifest.json              Maru-compatible skills manifest
```

There is no category subdirectory split or legacy helper directory split in
this bundle.

## Catalog

- Document toolkits: `hwpx`, `pptx-toolkit`, `xlsx-toolkit`, `md2docx`
- Korean writing: `gaejosik`
- Slide deck prompts: `canva-deck`, `notebooklm-deck`, `gpt-images-deck`
- Project workflows: `business-unit-lifecycle`
- Task and git: `task-management`, `git-sync`
- IO and inbox/outbox: `io-mso`, `io-gws`, `io-telegram`, `io-kakao`, `inbox-intake`, `inbox-process`, `meeting-notes`, `share-outbox`
- Vault workflows: `vault-extract`, `vault-connect`, `vault-sync`, `vault-learn`, `vault-lint`, `vault-graph`, `vault-pipeline`, `vault-refactor`, `vault-rename`, `vault-update`, `vault-next`, `vault-remember`, `vault-rethink`, `vault-stats`
- Skill analysis: `skill-mine`

## Runtime Federation

Maru materializes this bundle into `~/.maru/skills/_builtin`, records it in
`~/.maru/skills/registry.json`, and installs user-facing skill entrypoints as
symlinks:

```text
~/.maru/skills/<name> -> ~/.maru/skills/_builtin/skills/<name>
~/.claude/skills/<name> -> ~/.maru/skills/<name>
```

Do not install these packages by copying files manually. Use Maru's Skills UI
or `skill_host` commands so registry state and symlinks stay consistent.

Maru can bootstrap this bundle's shared runtime into its runtime root:

```bash
envs/default/setup.sh --target ~/.maru/env --dry-run
envs/default/setup.sh --target ~/.maru/env
```

## Runtime Values

Skill packages must not contain personal IDs, secrets, or workspace-only values. Runtime values belong in the caller's workspace configuration, usually `workspace.config.yaml`.

Vault-facing skills discover vault paths, project registry paths, and log paths from workspace config and use Obsidian MCP for vault markdown. See `lib/vault_adapter.md`.

## Contributing

Keep bundled skills self-contained and reusable. Do not add private identities,
real credentials, institution-specific internal details, or local absolute paths
to T1 packages.

MIT — see `LICENSE`.

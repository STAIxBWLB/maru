# Skill Index

Maru bundled skill catalog. Each skill lives at `skills/<name>/SKILL.md`.
`manifest.json` is the machine-readable source of truth; keep this index in
sync with it.

## Runtime And Shared Helpers

- `envs/default/` — shared Python/Node runtime scaffold for document, graph, and workspace skills.
- `lib/build-graph.py` — shared graph builder used by `vault-graph` and `skill-mine`.
- `lib/vault_adapter.md` — shared vault access policy for Obsidian MCP workflows.

## Skills (34)

- Document toolkits: `hwpx`, `pptx-toolkit`, `xlsx-toolkit`, `md2docx`
- Korean writing: `gaejosik`
- Slide deck prompts: `canva-deck`, `notebooklm-deck`, `gpt-images-deck`
- Project workflows: `business-unit-lifecycle`
- IO and inbox/outbox: `io-mso`, `io-gws`, `io-telegram`, `io-kakao`, `inbox-intake`, `inbox-process`, `meeting-notes`, `share-outbox`
- Task and git: `task-management`, `git-sync`
- Vault workflows: `vault-extract`, `vault-connect`, `vault-sync`, `vault-learn`, `vault-lint`, `vault-graph`, `vault-pipeline`, `vault-refactor`, `vault-rename`, `vault-update`, `vault-next`, `vault-remember`, `vault-rethink`, `vault-stats`
- Skill analysis: `skill-mine`

## Install

Skills are installed by the Maru app (Skills UI) or `maru skills sync`;
deployment ships through the `skills-channel` OTA bundle. See
`skills/README.md` for the pipeline.

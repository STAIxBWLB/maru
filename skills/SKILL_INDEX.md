# Skill Index

Public skill catalog. Each skill lives at `skills/<name>/SKILL.md`.

## Runtime And Shared Helpers

- `env/` — shared Python/Node runtime scaffold for document, graph, and workspace skills.
- `lib/build-graph.py` — shared graph builder used by `vault-graph` and `skill-mine`.
- `lib/vault_adapter.md` — shared vault access policy for Obsidian MCP workflows.

## Public Skills

- Document toolkits: `hwpx`, `pptx-toolkit`, `xlsx-toolkit`
- Korean writing: `gaejosik`
- Slide deck prompts: `canva-deck`, `notebooklm-deck`, `gpt-images-deck`
- Design: `design-init`, `design-motion`, `design-system`, `design-review`, `design-a11y`
- IO and inbox/outbox: `io-mso`, `io-gws`, `io-telegram`, `io-kakao`, `inbox-intake`, `inbox-process`, `meeting-notes`, `share-outbox`
- Task and git: `task-management`, `git-sync`
- Vault workflows: `vault-extract`, `vault-connect`, `vault-sync`, `vault-learn`, `vault-lint`, `vault-graph`, `vault-pipeline`, `vault-refactor`, `vault-rename`, `vault-update`, `vault-next`, `vault-remember`, `vault-rethink`, `vault-stats`
- Skill analysis: `skill-mine`

## Install

```bash
./install.sh -n
./install-codex.sh -n
```

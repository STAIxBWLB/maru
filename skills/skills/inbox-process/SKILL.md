---
name: inbox-process
description: >
  Public-safe inbox processing skill. Use when extracting text from normalized
  inbox items, writing summaries, classifying action/schedule/info/noise,
  proposing routes, generating digest/task candidates, channel-scoped processing
  such as "inbox-process kakao", or moving processed artifacts. It consumes
  inbox-intake manifests and never fetches directly from external providers.
---

# Inbox Process

Process normalized inbox items created by `inbox-intake` or an `io-*` provider
skill. The user may scope processing with `inbox-process <channel>`.

## Boot Sequence

1. Find `workspace.config.yaml`.
2. Read `inbox`, `ssot.project_registry`, `ssot.registry_scoring`, and optional
   `inbox.hooks`.
3. Load `inbox-intake/references/manifest-schema.md` before changing item
   state.
4. Load `references/summary-schema.md` before creating a summary.

## Workflow

1. Parse the request:
   - no channel: select all pending items or the item ID provided by the user.
   - `<channel>`: select only pending items whose manifest `channel` matches
     the configured `inbox.channels` key.
   - `<channel> [context...]`: treat remaining words as processing context.
     Preserve free text as `metadata.processing_context`; parse `key=value`
     tokens into `metadata.processing_hints`.
2. If a channel is provided, scan that channel's configured `drop_paths` first.
   Stage unnormalized files there through `inbox-intake` before processing.
   Ignore `.DS_Store` and other configured OS noise files.
3. Read each `manifest.yaml` and verify `schema: inbox-item/v1`.
4. Extract text from `files[]` into `extracted.md`.
   - `.pdf`, `.docx`, `.pptx`, `.xlsx`, `.hwpx`, `.hwp`, `.txt`, `.md`, and
     `.csv` should use the closest installed public toolkit or platform reader.
   - Unsupported binaries stay pending with a clear `failed` reason.
5. Create `summary.md` with the required frontmatter and exactly three body
   sections: `## 요약`, `## 핵심`, `## 실행`.
6. Classify each item as `action`, `schedule`, `info`, `ideation`, or `noise`.
7. Propose a route using `project-registry.yaml` and the configured scoring
   spec. Write the decision to `route.md`.
8. Ask for confirmation before moving originals or summaries outside the inbox.
9. Move processed items to `done/`, `failed/`, or `duplicate/` and append a
   receipt to `_state/index.jsonl`.

## Channel Invocation

Use root channel names from `workspace.config.yaml`, not subchannel names:

```text
inbox-process kakao
inbox-process mso regional innovation plan project=rise
inbox-process transcripts meeting=committee
```

Provider-specific folders under a channel root, such as `drop/mso/mail/`, are
source-kind hints only. Do not require users to call fine-grained channel names.

## Hooks

Hooks are optional and config-driven:

- `task_skill`: create local task candidates or call `task-management` when the
  user asks for task registration.
- `vault_extract_skill` and `vault_connect_skill`: only propose or call explicit
  vault skills. This public skill must not write vault notes by itself.
- `digest_output`: write a local digest under the configured inbox state path.

## Routing Rules

- Use `project-registry.yaml` as the first source of truth.
- If project confidence is weak, leave the item pending and ask for a route.
- Do not create new project folder structures for one item.
- Do not overwrite existing destination files.

## References

- `references/summary-schema.md` - required summary shape
- `references/workspace-config.md` - processing config keys

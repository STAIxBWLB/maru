---
name: io-telegram
description: >
  Public-safe Telegram IO connector skill. Use for generic Telegram message,
  export, attachment, bot, or session-based import workflows and for emitting
  normalized inbox-intake items. Chat IDs, bot tokens, and session secrets are
  runtime config values only.
---

# IO Telegram

Provide Telegram primitives and normalized inbox export.

## Boot Sequence

1. Find `workspace.config.yaml`.
2. Read `io.providers.telegram`.
3. Verify the requested capability and the configured secrets reference.
4. For inbox imports, pass message batches and attachments to `inbox-intake`.

## Capabilities

- message/export scan
- attachment download
- bot notification when configured
- session-backed read when configured

## Rules

- Use chat/message IDs only in workspace-local manifests or receipts.
- Never store bot tokens, chat IDs, session paths, or monitored room names in
  this skill package.
- Group related messages into one inbox item when they form one topic.
- Do not classify messages or create tasks directly; use `inbox-process`.

## References

- `references/workspace-config.md` - expected runtime provider keys

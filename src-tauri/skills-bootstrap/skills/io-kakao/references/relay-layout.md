# Kakao Relay Bus Layout

Contract between the dedicated-Mac relay (`maru-kakao-relay`) and consumers
(Maru on the work Mac, this skill's send script). The bus is a plain folder
kept in sync by an external tool (Dropbox/iCloud/Syncthing). Default root:
`~/Dropbox/work/inbox/kakao-bridge`, configurable via
`io.providers.kakao.relay_root` in `workspace.config.yaml`.

## Tree

```
kakao-bridge/
  status/relay.json                      # relay writes: state=running|paused, heartbeat_at,
                                         #   last cycle, per-room counts, kmsg readiness, last error
  rooms/rooms.json                       # relay writes: scanned chat list + managed /
                                         #   send_allowed / priority flags
  messages/<room-slug>/YYYY-MM-DD/<hhmmss>-<hash8>.json
                                         # relay writes: one kakao-msg/v1 envelope per message
  media/_incoming/                       # KakaoTalk download folder points here directly
  outbox/pending/<uuid>.json             # CONSUMERS write (atomic tmp+rename): kakao-send/v1
  outbox/attachments/<uuid>-<name>       # CONSUMERS write: attachment for send-image
  outbox/done/<uuid>.json                # relay writes: request + result appended
```

## Single-writer rule

Exactly one machine ever writes a given file. The relay owns `status/`,
`rooms/`, `messages/`, `media/`, and `outbox/done/`. Consumers own
`outbox/pending/` and `outbox/attachments/`. No file is ever edited by both
sides, so sync "conflicted copy" files cannot arise. Relay-local state
(dedupe rings, cursors, logs, paused flag) lives outside the bus.

## Reading rules (tolerate partial sync)

- Skip JSON files that fail to parse; retry on the next cycle.
- Ignore media files whose mtime is newer than ~10 seconds (still syncing).

## Schemas

### kakao-msg/v1 — message envelope

Shaped so a literal copy into `inbox/drop/kakao/` is a valid staged message
file (mirrors `inbox_drop::stage_message_json`'s `{provider, kind, message}`).
`message.id` is a content hash (`sha256:<chat|sent_at|sender|text>`) because
kmsg exposes no message ID; it doubles as the inbox `dedupe_key`
(`dedupe: sha256`).

```json
{
  "schema": "kakao-msg/v1",
  "provider": "kakao",
  "kind": "message",
  "message": {
    "id": "sha256:...",
    "chat": "RISE1-...",
    "room_slug": "rise1-...",
    "sender": "...",
    "is_me": false,
    "text": "...",
    "sent_at": "2026-07-30T09:12:00+09:00",
    "captured_at": "2026-07-30T09:15:02+09:00",
    "engine": "kmsg",
    "attachments": [{ "type": "photo|file", "name": null, "path": null }]
  }
}
```

Notes: `sent_at` is approximate (kmsg exposes time-of-day only; the relay
combines it with the read date). Room slugs are stable ASCII; the original
Korean room name is preserved in `chat` and `rooms/rooms.json`.

### kakao-send/v1 — send request (`outbox/pending/<uuid>.json`)

```json
{
  "schema": "kakao-send/v1",
  "id": "<uuid>",
  "chat": "RISE1-...",
  "text": "...",
  "attachment": "outbox/attachments/<uuid>-report.pdf",
  "requested_by": "work-mac",
  "requested_at": "2026-07-30T09:20:00+00:00"
}
```

`attachment` is null or a bus-relative path under `outbox/attachments/`.

### Send result (`outbox/done/<uuid>.json`)

The request object plus:

```json
{ "result": { "ok": true, "error": null, "sent_at": "2026-07-30T09:20:08+00:00" } }
```

Idempotency: a request id present in `outbox/done/` is never re-sent.

## Send safety rails (relay side)

- `send.enabled` master switch, default off.
- Per-room `send_allowed` allowlist, separate from the managed/read toggle.
- Room re-resolved by exact display name against a fresh `kmsg chats` before
  every send; no match = failed, never guessed.
- One send in flight; global pause blocks both polling and sending.
- Malformed or unknown-room requests land in `outbox/done/` marked failed.

## Intake path (work Mac)

Envelopes are viewed read-only any time. On explicit "Process now", Maru
copies new envelopes into `inbox/drop/kakao/` and stable media files into
`inbox/drop/kakao/files/`; from there the normal `inbox-intake` →
`inbox-process kakao` pipeline runs (classification and routing stay
confirmation-gated).

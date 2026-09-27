# Phase 9: Durability and Session Lifecycle - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md; this log preserves the alternatives considered.

**Date:** 2026-09-25
**Phase:** 9-durability-and-session-lifecycle
**Areas discussed:** Save scope (REL-02), Quit flush behavior (REL-02), Save failure visibility (REL-03), Terminal force kill (REL-01)

REL-04 was not discussed as an area. It was found already shipped: #328 (commit 86e7074f) shipped it in v1.1.8, and issue #295 is closed. It is recorded as verify-only in CONTEXT D-13.

---

## Save scope (REL-02)

| Option | Description | Selected |
|--------|-------------|----------|
| All autosave + shared helper | Move the hand-rolled timers (Scratchpad, Studio, Today brain dump) onto `debouncedSave`; every autosave flushes on unmount and quit | ✓ |
| Same + recurrence guard | As above, plus a static check that fails `make verify` on new hand-rolled save timers | |
| Scratchpad only | Fix only the recorded 700 ms gap | |

**User's choice:** All autosave + shared helper

| Option | Description | Selected |
|--------|-------------|----------|
| Keep localStorage mirror as a secondary safety net | File stays the source of truth; the mirror is used only after abnormal exits and cleared once the file save lands | ✓ |
| Remove the mirror | Rely on the guaranteed flush; no protection on crash | |
| You decide | Decide during research and planning | |

**User's choice:** Keep as a secondary safety net

---

## Quit flush behavior (REL-02)

| Option | Description | Selected |
|--------|-------------|----------|
| Up to 3 s, then stop | Covers slow disks without a hung-looking quit; "saving" shown after ~300 ms | ✓ |
| Unbounded | No loss, but a stuck save blocks quit | |
| Up to 1 s | Fast quit, higher risk of cutting a slow save | |

**User's choice:** Up to 3 s

| Option | Description | Selected |
|--------|-------------|----------|
| Cancel quit and alert | Keep the app open, show the failure, user retries or chooses "quit anyway" | ✓ |
| Quit anyway + notify on next launch | Do not block quit; record the failure and offer a recovery copy next launch | |

**User's choice:** Cancel quit and alert

| Option | Description | Selected |
|--------|-------------|----------|
| Cmd+Q uses the same unsaved-changes guard | One quit path for window close and Cmd+Q | ✓ |
| Only flush pending autosaves on Cmd+Q | Leave explicit-save drafts as today | |

**User's choice:** Same guard for Cmd+Q

---

## Save failure visibility (REL-03)

| Option | Description | Selected |
|--------|-------------|----------|
| Global toast + log | errorStore toast with file name and reason (survives unmount), same line in the log | ✓ |
| Log + banner on next open | Surface the failure when the document is reopened | |

**User's choice:** Global toast + log

| Option | Description | Selected |
|--------|-------------|----------|
| Recovery copy file | Write the content under `.maru/recovery/`, openable from the toast | ✓ |
| Message only | Report the failure; content survives only via the Scratchpad mirror | |
| You decide | Decide during research and planning | |

**User's choice:** Recovery copy file

---

## Terminal force kill (REL-01)

| Option | Description | Selected |
|--------|-------------|----------|
| SIGHUP, 2 s, SIGTERM, 2 s, SIGKILL | One extra cleanup chance; worst case about 4 s | ✓ |
| SIGHUP, 2 s, SIGKILL | Simpler and faster, no SIGTERM step | |
| SIGHUP, 5 s, SIGKILL | More time for slow-exiting programs | |

**User's choice:** SIGHUP, 2 s, SIGTERM, 2 s, SIGKILL

| Option | Description | Selected |
|--------|-------------|----------|
| Tab closes immediately; escalation in background | Current behavior; the generation token blocks late output | ✓ |
| Show "terminating" until the process dies | Transparent, but closing feels slow | |

**User's choice:** Tab closes immediately

| Option | Description | Selected |
|--------|-------------|----------|
| One warn log line | Same as Phase 7 D-01 | ✓ |
| Log + toast | Also tell the user the process was force-killed | |

**User's choice:** One warn log line

| Option | Description | Selected |
|--------|-------------|----------|
| Clean up within the 3 s quit window, SIGKILL leftovers | SIGHUP/SIGTERM alongside the save flush, SIGKILL remaining process groups before exit; no orphans | ✓ |
| Immediate SIGKILL | Fast, no cleanup chance | |
| You decide | Decide during research and planning | |

**User's choice:** Clean up within the quit window
**Notes:** Clarified afterwards and recorded as CONTEXT D-06: terminal cleanup at quit starts only after the quit is committed, so a quit cancelled by a save failure never kills terminals.

---

## Claude's Discretion

- Mechanism of the Rust-driven quit handshake (prevent exit, webview event, ack command, native fallback dialog).
- Recovery-copy naming, retention, and cleanup.
- Confirming `portable_pty` process-group setup at spawn before implementing the escalation.
- Presentation of the "saving" indicator.

## Deferred Ideas

None.

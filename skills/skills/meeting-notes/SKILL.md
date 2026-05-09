---
name: meeting-notes
description: >
  Public-safe meeting notes skill. Use when turning any reviewed transcript,
  meeting memo, interview note, call note, or meeting-related inbox item into a
  structured meeting note. The source can be pasted text, a transcript file, or
  an inbox item; no vendor-specific transcript service is assumed.
---

# Meeting Notes

Create and file structured meeting notes from transcript-like inputs. This
skill is provider-neutral and does not require inbox staging.

## Boot Sequence

1. Find `workspace.config.yaml`.
2. Read `meeting_notes` for root, filename template, guide paths, and optional
   hooks.
3. Read only the local guide files needed for the current note.
4. If the input is an inbox item, read its `manifest.yaml` and `extracted.md`.

## Workflow

1. Accept pasted text, a local transcript file, a meeting memo, or an inbox item
   with `kind: transcript`.
2. Identify meeting date, type, topic, participants, venue, decisions, and action
   items from the provided material.
3. Normalize terms and people using configured local guides when available.
4. Write the note using `templates/meeting-note.md`.
5. File it under the configured meeting root, usually `YYYY/YYYY-MM/`.
6. If configured and explicitly requested, create task candidates with
   `task-management` or prepare vault extraction candidates. Do not write vault
   notes directly.

## Rules

- Do not assume a specific transcript vendor.
- Do not transcribe raw audio unless a configured `io-*` or transcriber tool
  has already produced text.
- Keep filename policy configurable; default to
  `MM-DD <type> - <topic> - <detail>.md`.
- If date, participants, or topic cannot be recovered from the input, leave a
  visible placeholder and state what is missing.
- Legal/accounting evidence meeting records are out of scope unless the user
  provides a local template and explicitly requests that format.

## References

- `references/workspace-config.md` - runtime config keys
- `templates/meeting-note.md` - neutral meeting note template

---
name: ideation-drafts
description: >
  Public-safe ideation-to-draft skill. Use when turning a scratchpad ideation
  entry (idea seed) into a structured implementation draft that Maru ingests
  into Drafts. Read-only: it never writes, moves, or deletes files and never
  runs follow-up skills; Maru creates the draft itself from the emitted
  artifact.
---

# Ideation Drafts

Turn one scratchpad ideation entry into a structured implementation draft.
Maru dispatches this skill in background mode with the idea title, path, and
content inline in the request.

## Mode: `ideate-to-draft`

`ideation-drafts ideate-to-draft` converts the provided idea into an
implementation plan. This mode is read-only: never write, move, or delete
files, and do not run follow-up skills.

1. Parse the request. It carries an `Idea title:`, an `Idea path:`
   (workspace-relative scratchpad path), and the full `Idea content:` block.
   When the idea references other workspace notes by path, you MAY read those
   files for context, but do not modify them.
2. Develop the idea into a concrete implementation plan: what to build, in
   which order, and what to watch out for. Stay within the scope of the idea;
   do not invent unrelated work.
3. Emit concise progress logs with the usual phase markers (`[phase:source]`,
   `[phase:classify]`, `[phase:review]`), then return exactly one
   `maru_implementation_draft_v1` JSON object as the final output:

```json
{
  "schemaVersion": "maru_implementation_draft_v1",
  "title": "implementation draft title in the workspace language (Korean)",
  "confidence": 0.0,
  "draftBody": "markdown draft body (Korean, gaejosik style)"
}
```

Rules:

- `title` and `draftBody` are Korean (the workspace language).
- `confidence` is a number between 0 and 1 reflecting how well-defined the
  plan is given the idea's current detail.
- `draftBody` is markdown in 개조식 (noun-ending) style per the `gaejosik`
  skill, with exactly these sections:
  - `## 개요` — 2-3 sentences framing the problem and the proposed approach.
  - `## 목표` — bulleted, verifiable outcomes.
  - `## 작업 항목` — ordered checklist (`- [ ]`) of concrete work items, each
    small enough to start immediately.
  - `## 고려사항` — risks, open questions, and dependencies.
- Maru ingests this artifact into Drafts itself and links it to the idea via
  `originRefs`; never create draft, task, or note files directly.
- Parsers ignore unknown fields, so the artifact stays forward-compatible.

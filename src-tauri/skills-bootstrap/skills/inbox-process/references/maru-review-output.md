# Maru review-mode output

Progress logs and the final artifact for a review-mode run (`reviewFlow: true`).
The safety rules stay in SKILL.md *Maru Run Contract*.

## Phase markers

Prefix each major log line with exactly one phase marker at the start of the
line (after any timestamp) so Maru can render stepwise status and colour-code
phases:

- `[phase:source]` after the selected items / channels are resolved.
- `[phase:extract]` while extracting text into `inbox.naming.extracted_file`.
- `[phase:summary]` while writing `inbox.naming.summary_file`.
- `[phase:classify]` while classifying action/schedule/info/ideation/noise.
- `[phase:route]` while scoring routes against `project-registry.yaml`.
- `[phase:review]` when preparing the `maru_inbox_review_v1` block.
- For errors prepend `ERROR:` to the message or use `[phase:error]`.

## `maru_inbox_review_v1`

Return exactly one object listing a decision for every processed item:

```json
{
  "schemaVersion": "maru_inbox_review_v1",
  "summary": "short batch summary across channels",
  "items": [
    {
      "itemId": "pending item id",
      "itemDir": "inbox/items/pending/<id>",
      "title": "human title",
      "channel": "kakao",
      "classification": "action|schedule|info|ideation|noise",
      "project": "project id or null",
      "destination": "workspace-relative destination SUBFOLDER for raw originals (kind-matched per naming-and-placement.md §C; _incoming/ when ambiguous; never a bare project root), or null",
      "confidence": "high|medium|low",
      "summaryPreview": "2-3 sentence preview",
      "requiresConfirmation": true,
      "recommendedAction": "route|reject|skip|handoff",
      "note": "why, or what is uncertain"
    }
  ]
}
```

SKILL.md item 5 sets when `requiresConfirmation` is true. Parsers ignore
unknown fields, so the artifact stays forward-compatible.

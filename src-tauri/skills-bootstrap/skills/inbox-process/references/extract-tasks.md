# Task Extraction Mode (`extract-tasks`)

This mode is read-only: never write, move, or delete files in any mode (review
mode included), and do not run follow-up skills.

1. Collect inputs:
   - Pending inbox items: read each item's `inbox.naming.summary_file`
     (fall back to `inbox.naming.extracted_file`) under the pending dir.
   - Recent meeting notes: the newest notes under the configured meetings
     root (default `meetings/`), at most 10 files, newest first.
   - Latest mail digest: the newest file under the configured
     `inbox.hooks.digest_output` path (e.g. `inbox/_state/digests/`), when
     present. It is context only; it covers messages that were not staged
     as pending items, so candidates may cite it, but never treat it as a
     substitute for reading a staged item's own summary.
2. Extract only concrete, actionable follow-ups (an identifiable action an
   owner could start). Skip pure information, completed items, and noise.
   Merge duplicates across sources into one candidate and list every source
   in `originRefs`.
3. Emit concise progress logs with the usual phase markers (`[phase:source]`,
   `[phase:classify]`, `[phase:review]`), then return exactly one
   `maru_task_candidates_v1` JSON object as the final output:

```json
{
  "schemaVersion": "maru_task_candidates_v1",
  "summary": "short batch summary",
  "candidates": [
    {
      "title": "task title in the workspace language (Korean)",
      "importance": "high|medium|low",
      "confidence": 0.0,
      "originRefs": ["workspace-relative source path"],
      "summary": "1-2 sentence summary (Korean)",
      "draftBody": "markdown draft body (Korean): context, action steps, references"
    }
  ]
}
```

Rules:

- `title`, `summary`, and `draftBody` are Korean (the workspace language).
- `importance` is exactly one of `high`, `medium`, `low`; `confidence` is a
  number between 0 and 1.
- Every candidate names at least one workspace-relative `originRefs` path.
- Maru ingests this artifact into Drafts itself; never create task or note
  files directly.
- When the prompt contains a `## 최근 수정 경향` (recent edit tendencies)
  section, treat it as feedback from the user's past draft edits and apply its
  hints to every `draftBody` (e.g. include sources/figures/dates up front, or
  pre-link related documents). The section is auto-attached by Maru; do not
  echo it back in the output.

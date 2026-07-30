# Gap analysis

Gap analysis diffs a promoted draft against its frozen promote baseline and
classifies what the human changed. It answers: "what did the user have to fix
in the AI's draft?" — and feeds the answer back into future draft prompts.

Backend: `src-tauri/src/gap.rs`. Frontend: `src/components/gap/` (GapPane,
GapLogPanel), `src/lib/gapAnalysis.ts` (pure helpers).

## Baseline

`drafts_promote` freezes the draft body, byte for byte, to
`<work>/.maru/drafts/<id>/baseline.md` at promote time (see
[drafts.md](drafts.md)). The promoted document lives at the vault-relative
`promotedTo` path on the draft index entry. Analysis re-validates `promotedTo`
through `resolve_inside_vault`, so a hand-edited index cannot redirect the
read outside the workspace.

`gap_reports_list` returns the analyzable set: accepted drafts with a
`promotedTo`, each flagged `hasBaseline` so the UI can mark rows whose
baseline was deleted.

## Diff

`gap_analyze(workPath, draftId)` runs a line-level diff (`similar::TextDiff`)
between baseline and current document, grouped into unified-diff-style hunks
with 3 lines of context on each side; change groups at most 6 equal lines
apart merge into one hunk. Each hunk carries:

- `op` — `insert` | `delete` | `replace` (equal runs are never emitted).
- 1-based `oldStart`/`newStart` and line counts. For pure insertions,
  `oldStart` is the baseline line after which content was added (0 = before
  the first line), matching unified-diff convention.
- `lines` — `' '` context, `'-'` removed from baseline, `'+'` added.
- `hunkType` + `evidence` (see below).

The report also carries `baselineHash` (sha256 of the baseline) and a summary:
total hunks, added/removed line counts, per-type hunk counts. Korean multibyte
content diffs safely (line-oriented, never byte-sliced).

## Classification heuristics (v1)

Pure Rust string/regex signals, no AI call. Ordered — first match wins:

1. **formatting** — every changed line is blank, added/removed lines are
   identical once whitespace is squashed, or every changed line sits inside
   the leading frontmatter block of its document.
2. **cross-doc-reference** — an added line contains a `[[wikilink]]` or a
   markdown link to a non-URL (workspace-relative) target.
3. **external-info** — an added line contains a URL, a date, a number, or a
   quoted name that does not appear anywhere in the baseline. "Not in the
   baseline" stands in for "new information" — an intentional approximation.
4. **direct-edit** — everything else (rewording, restructuring).

Every classification surfaces its `evidence` (the matched URLs, wikilinks,
numbers, ...) so the UI can show *why* a hunk got its type.

## Log

Analysis itself is read-only. `gap_append_log` (explicit, frontend-triggered
after an analysis is viewed) re-runs the analysis and appends one JSON line to
`<work>/.maru/gap-log.jsonl`:

```json
{ "at": "...", "draftId": "...", "promotedTo": "...", "addedLines": 2,
  "removedLines": 1,
  "byType": { "externalInfo": 1, "directEdit": 0, "crossDocReference": 0,
              "formatting": 0 },
  "hunkCount": 1 }
```

`gap_log_list(workPath, limit)` returns entries newest-first (default cap
100); corrupt lines are skipped so one bad write never wedges the log. The
Gap pane renders the log grouped by day with a per-document gap-size trend
(`gapTrend` in `src/lib/gapAnalysis.ts`).

Isolation invariant: the module only reads the draft index, baselines, and
in-vault documents, and only writes `.maru/gap-log.jsonl` — and only through
`gap_append_log`, never as a side effect of analysis.

## Feedback loop

The log is not just a report: it closes the loop back into draft generation.

- `buildGapFeedbackDigest(entries, maxEntries?)` (`src/lib/gapAnalysis.ts`)
  aggregates the most recent 20 entries into a few Korean lines: totals
  ("최근 초안 N건의 수정 분석: 추가 X줄, 삭제 Y줄 (...)"), plus one actionable
  hint for the dominant edit type (e.g. external-info dominates → "초안에
  출처·수치·날짜 등 근거 정보를 더 포함할 것"). Empty input yields an empty
  string.
- Injection point: **schedule-add time**, frontend-side
  (`promptWithGapFeedback` in `SchedulerSection.tsx`). When the user adds a
  schedule for the `inbox-process` skill, the current digest is appended to
  the stored prompt under a clearly delimited, user-editable section header
  (`## 최근 수정 경향 (자동 첨부)`). The digest is best-effort: a gap-log read
  failure never blocks schedule creation, and non-inbox-process schedules are
  untouched.
- Trade-off: the digest is a snapshot, stale between runs. Chosen over a
  Rust-side injection at dispatch time because it requires no change to
  `skill_host` and keeps the section visible/editable in the schedule dialog.
- The extract-tasks mode of `skills/skills/inbox-process/SKILL.md` is
  instructed to honor the `## 최근 수정 경향` section when present and apply
  its hints to every `draftBody`.

Effect: if users keep adding sources and figures by hand, the next scheduled
extract-tasks run is told to include them up front, shrinking the gap the log
measures.

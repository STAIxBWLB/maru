# Maru Integration Contract

Maru can treat the configured LinkedIn root as a local-first data source.

## Directories

```text
<linkedin.root>/
├── ideas/
├── drafts/
├── scheduled/
├── published/
│   └── YYYY/
├── calendar/
├── reviews/
├── profile/
│   ├── current.md
│   ├── proposals/
│   └── history/
├── references/
└── engagement/
```

## Parsing Rules

- Read markdown files with YAML frontmatter; `type` distinguishes record kinds
  (`linkedin-post`, `linkedin-plan`, `linkedin-review`, `linkedin-profile`,
  `linkedin-profile-proposal`, `linkedin-source-inventory`,
  `linkedin-engagement`).
- Preserve unknown frontmatter keys.
- Resolve the display label as `title -> filename`.
- For a post, `status` is authoritative; the directory mirrors it. When they
  disagree, report it and trust `status`. `dropped` is the one exception: a
  dropped post stays in the directory it was in, and that is not a mismatch.
- A legacy `published` status without a valid `publishedAt` is unresolved
  archive evidence, not a dated publication. Preserve the record, surface the
  gap, and exclude it from period totals as specified in `review-report.md`.
- In a post body, only the text before the first line that is exactly
  `## Working notes` is the post.
- A plan's `record` column holds a post filename; resolve it by searching the
  lifecycle directories.

## App Fields

Display when present: `title`, `status`, `language`, `pillar`, `format`,
`scheduledFor`, `publishedAt`, `url`, `relatedTask`, and the latest entry of
`metrics`.

## Background and Review Runs

In a proposals-only run the skill writes nothing. It returns exactly one
proposal object:

```json
{
  "schemaVersion": "maru_skill_proposal_v1",
  "summary": "what the approved writes will do, in one or two lines",
  "files": [
    { "path": "relative/to/workspace/file.md", "operation": "create", "content": "full file content" }
  ],
  "commands": [],
  "risks": ["anything the user should check before approving"],
  "requiresApproval": true
}
```

- `operation` is `create` for a new record and `replace` for a changed one,
  with the full new content.
- The proposal object has no move operation. So propose as file writes only
  what moves nothing, for example a new idea, a metrics snapshot, a profile
  record, a plan or a review, an in-place drop or restore, a `url` or
  `publishedAt` correction. `files` may be empty. Describe a transition that moves a file in `summary` and leave
  it for a terminal run. Never propose a `status` change that would leave the
  record in a directory that contradicts it.
- `commands` stays empty: this skill runs no command against an outside service.
- Setup proposals may describe pending YAML/config changes in `summary` and
  `risks`, but must not emit YAML writes, shell commands, or external actions.
- No dedicated review object is defined for this skill yet. Put what the user
  must confirm (mentions, facts to confirm, missing values) in `risks`, and
  repeat it in plain text after the JSON.

## Allowed Handoffs

Proposed only, never run by this skill during a background run: the configured
writer, polish, task and spreadsheet skills. Never `linkedin-manager` itself.

## Write Behavior

The markdown file is the source of truth. LinkedIn is updated by the user, by
hand, and the result is then recorded here.

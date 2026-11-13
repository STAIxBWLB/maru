SKILL.md is the instruction source for this skill. This file is background for maintainers; it holds no directives.

# LinkedIn Manager background

## Filenames as identifiers

Plans, reminders and logs refer to posts by filename rather than path. Because
filenames are unique across the lifecycle directories, moving a post between
`ideas/`, `drafts/`, `scheduled/` and `published/YYYY/` breaks no reference.

## Recording a post that skipped `ready`

A post can go out without passing through `ready`. The skill still records it
(with `readySkipped: true`) because the record has to match what actually
happened on LinkedIn.

## Description scope

The frontmatter description carries routing triggers only. The limits on
profile reading (one explicitly authorized public read, no login or
interaction, stop on access failure), identity from configuration, and the
configured writer are stated in SKILL.md Core Rules and `references/setup.md`.

## File layout

Mode procedures that only one mode needs live in `references/` (`setup.md`,
`calendar-and-cadence.md`, `publish-pack.md`, `review-report.md`, `profile.md`,
`import.md`, `metrics.md`). `record-schema.md` is read before any record write,
and `maru-integration.md` holds the background-run contract.

# Calendar and Cadence

How `plan` builds a content calendar, and what a plan is allowed to claim.

## Inputs, in priority order

1. Dates the user names: events, launches, deadlines, embargoes, travel.
2. Records already in `scheduled/` and `drafts/`.
3. Open records in `ideas/`, oldest and most time-sensitive first.
4. `linkedin.cadence` (posts per week, preferred days) and `linkedin.pillars`.

A workspace calendar or task list may be read through the configured task skill
when the user asks for it. This skill reads no calendar service on its own.

## Building the plan

When `linkedin.cadence.mode` is `on_demand`, keep the same table but leave the
`date` column empty for new ideas and order rows by source readiness and user
priority. The period is a planning label only. Preserve past rows and recorded
scheduled/published dates. Do not infer new posting dates or times. A later
user-supplied posting date may be recorded without changing the channel's
cadence. When the mode is missing or `weekly`, use the weekly behavior below.

- Fill dated slots first (a post tied to an event goes near the event), then
  spread the rest across preferred days at the configured cadence. When there
  are more preferred days than posts per week, propose the first preferred day
  and let the user change it.
- Rotate pillars when pillars are configured; say so when the open ideas cannot
  support a rotation rather than inventing topics to fill it.
- An empty slot is a valid result. List it as open and suggest capturing ideas;
  do not generate filler topics unless the user asks for suggestions, and label
  suggestions as suggestions.
- One slot per row: `date`, `pillar`, `working title`, `record`, `state`
  (`open`, `idea`, `draft`, `scheduled`, `published`, `dropped`).
- Revising a plan edits the same file. Keep slots that already happened.

## What a plan may not claim

- No "best day" or "best time" asserted from outside sources. Preferred days
  come from config or from the user's own review results, cited as such.
- No promised reach, growth or follower numbers.
- No commitment on the user's behalf: a plan is a proposal until the user
  accepts it.

## Reminders

For each accepted, dated slot, offer one reminder through `linkedin.skills.tasks` as a
proposed handoff: title, date, and the filename of the record (not its path,
which changes as the post moves). The task skill owns
the task file and any calendar write. When it returns a task path, store it in
the post's `relatedTask`. Undated on-demand rows have no reminder handoff.

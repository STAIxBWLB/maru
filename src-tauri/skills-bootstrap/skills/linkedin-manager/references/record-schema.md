# Record Schema

Every record is a markdown file with YAML frontmatter. Always write a
human-readable `title`. Preserve keys you do not know. Dates are ISO
(`YYYY-MM-DD`). `scheduledFor` may be a date alone. A time written by this skill
(`publishedAt`, or `scheduledFor` when the user gave a time) carries the
offset of `linkedin.timezone`; when no timezone is configured, ask before
writing a time. The one exception is an imported timestamp whose timezone is
unknown (§Imported posts).

## Post (`ideas/`, `drafts/`, `scheduled/`, `published/YYYY/`)

```yaml
---
title: Short human-readable title
type: linkedin-post
status: idea            # idea | draft | scheduled | published | dropped
language: en
pillar: null            # one of linkedin.pillars, or null
topic: one line
why: null               # why it is worth a post; set by `idea`
targetMonth: null       # YYYY-MM; set by `idea`
format: text            # text | image | document | video | poll | article
created: 2026-01-05
scheduledFor: null      # set by `ready`
publishedAt: null       # set by `published`
url: null               # set by `published`
mentions: []            # people and organizations, confirmed by the user
hashtags: []            # mirrors the hashtags in the body; the body is what gets posted
media: []               # file paths or descriptions, each with alt text
source: null            # idea source link or path; for imports, the export file
relatedTask: null       # set only when the task skill reports one
readySkipped: false     # true when a post was recorded as published without `ready`
metrics: []             # `metrics` adds snapshots in date order; existing ones are never edited
---

Post text exactly as it will be, or was, published, hashtags included. Every
character count is taken from this text. An idea leaves it empty.

## Working notes

Alternatives, the brief, earlier versions. Not part of the post.
```

A metrics snapshot:

```yaml
metrics:
  - date: 2026-01-12
    impressions: 1840
    reactions: 52
    comments: 7
    reposts: 3
    source: user            # user | export:<file>; written by the skill
```

The post text is everything before the first line that is exactly
`## Working notes`. That line is the only boundary: a `---` inside a post is
post text. If a post itself must contain that exact line, indent it by one
space in the record and say so in the notes. A record with no `## Working notes`
line is all post text; when such a record looks as if it holds notes below a
bare `---`, report it and ask before treating any of it as notes.

Rules: `source` is the only field the skill adds on its own. A correction is a
new snapshot with the same `date`, `corrects: true` and `reason`, repeating the
whole reading with the corrected values and the unretracted fields copied over;
the last snapshot written for a date is the effective one. One snapshot per reading, appended in date order; omit a field the
source did not give; extra fields keep the label the user or the export used.
The file moves between lifecycle directories as `status` changes and keeps its
name. `dropped` files stay where they were.

## Source inventory

`references/source-inventory.md` uses `type: linkedin-source-inventory`,
`created`, and `source` (the legacy source root), and
records each legacy source with its path, event-date evidence, publication URL
evidence, exact publication date (or null), metric-date evidence (or null),
duplicate matches, and an uncertainty note. A filename date or URL never
supplies an unverified publication or measurement timestamp.

## Profile proposal

`profile/proposals/YYMMDD-profile.md` uses `type: linkedin-profile-proposal`,
`status: proposed`, `created`, `language`, and `source` (the primary CV path).
It contains proposed sections such as Headline and About. It is distinct from
`profile/current.md`, which is only a user-supplied snapshot of live LinkedIn
text. Setup never creates `profile/current.md` from a CV, biography, or failed
profile read.

## Imported posts

An imported record uses the post schema with these rules:

- Filename date is the publish date, not the import date. Apply the collision
  rule: two posts on one day with the same slug get `-2`, `-3`.
- `importKey`: the raw export timestamp, a `|`, and the first 60 characters of
  the text with all whitespace collapsed to single spaces, written as a quoted
  string. It identifies the post when the export has no `url`.
- `<slug>` is at most six words. `topic` stays null unless the user supplies it.
- `title` is the first line of the text, cut at about 60 characters; `<slug>`
  is derived from it in lowercase ASCII, or `post-N` when nothing usable remains.
- `created` equals the publish date. `language` is detected from the text.
- `format`: `image`, `video` or `document` when the export shows media, `text`
  otherwise; a shared link stays `text` with the link kept in the body or under
  the export's own column label.
- `publishedAtRaw`: the timestamp exactly as the export gives it.
- `publishedAt`: look at how this export writes its timestamps. When it states
  an offset or zone, convert to `linkedin.timezone`. When it does not, ask the
  user which zone the export uses; unanswered, write the raw value in ISO form (`YYYY-MM-DDTHH:MM:SS`) without an
  offset, set `timezoneResolved: false`, and file the record under the year of
  the raw date. Never assume a zone.
- `pillar`, `why`, `targetMonth`, `scheduledFor`, `relatedTask` stay null.
- Loose files are imported as published only when publication evidence is
  attributable to the owner and includes an absolute publication date, such as
  the owner's export timestamp or a supplied own-post URL and publication date.
  A third-party original-post URL is not proof the owner reposted it. Relative
  times without a capture anchor and event dates cannot fill `publishedAt`.
  Metrics without a reading date stay as inventory evidence, not snapshots.
  Otherwise keep them in the source inventory as uncertain and do not change
  an existing record's status.
- Every other export column goes under one `importFields:` mapping, as quoted
  strings under the export's own labels. Nothing from an export may set or
  override a schema key such as `status`, `source` or `metrics`.

## Plan (`calendar/YYMM-plan.md`, or `calendar/YYQn-plan.md` for a quarter)

```yaml
---
title: LinkedIn plan 2026-01
type: linkedin-plan
period: 2026-01         # or 2026-Q1
cadence: 1 per week
---
```

Body: a table of slots (`date`, `pillar`, `working title`, `record`, `state`)
followed by the dates and events the plan was built around. `record` is the
**filename** of the post that fills the slot, or empty; never a path, because
posts move between directories.

For on-demand plans use `cadence: on_demand`; new idea rows have an empty date.
Row order is priority (an optional priority column can make that explicit).
Keep past rows and dates already recorded for scheduled or published posts.

## Review (`reviews/YYMM-review.md`, or `reviews/YYQn-review.md` for a quarter)

```yaml
---
title: LinkedIn review 2026-01
type: linkedin-review
period: 2026-01         # or 2026-Q1
generatedAt: 2026-02-03
revision: 1
posts: 4
measured: 3
---
```

A quarterly review reads the quarter's plan file when it exists, otherwise the
three monthly plans. A replaced report is kept as
`reviews/history/<name>-r<revision>.md`.

## Profile (`profile/current.md`, `profile/history/YYMMDD-profile.md`; a second copy on one day gets `-2`)

```yaml
---
title: LinkedIn profile text
type: linkedin-profile
recordedAt: 2026-01-05
source: pasted by the user
---
```

Body: one `##` section per profile field the user keeps (Headline, About,
Experience entries, Education, Featured, Skills), holding the live text.

## Engagement (`engagement/YYMMDD-<slug>.md`), optional

```yaml
---
title: Reply to a comment on <post title>
type: linkedin-engagement
kind: comment           # comment | message
post: published/2026/260105-post-example.md
date: 2026-01-06
sent: false             # the user sets true after sending by hand
---
```

Body: the incoming text quoted, then the reply as drafted. Store no more about
the other person than the exchange itself.

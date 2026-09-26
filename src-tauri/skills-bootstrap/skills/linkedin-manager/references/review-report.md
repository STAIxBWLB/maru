# Review Report

`review` reports on a period from recorded posts and their snapshots only.

## Selection

- Posts with `status: published` and `publishedAt` inside the period.
- Legacy records with a missing/invalid `publishedAt` cannot be assigned to a
  period. List them separately as unresolved archive records and exclude them
  from published counts, metrics, and rankings. Never infer a date from the
  directory or filename, and never silently change their status.
- For each post use its **latest** snapshot: the latest `date`, and when that
  date has several snapshots (a correction), the last one written. Give the snapshot's date and its
  age in days since posting: readings taken at different ages are not
  comparable, and the report says so where ages differ by more than a week.
- A post with no snapshot is **unmeasured**. It appears in the table with empty
  metric cells and `unmeasured` in the snapshot-age column, and is excluded from
  every total and average. It is never zero. A single missing field in a
  snapshot stays empty and is left out of that field's sum, with its own `n`.

## Arithmetic the report may do

- Counts: posts published, posts measured, posts per pillar, per format, per
  language.
- Sums and means over measured posts, per field, with `n` stated.
- Engagement rate only when the user asks or has used it before, defined
  exactly as `(reactions + comments + reposts) / impressions`, per post, only
  for posts that have all four numbers and impressions above zero. State it as
  a percentage with the inputs beside it.
- Ranking of the user's own posts within the period, **only among posts whose
  snapshot ages are within seven days of each other**. Posts outside that window
  are shown with their values and left out of the ranking, and their numbers do
  not enter a mean alongside the others without the age difference stated.
- Comparison with the previous period uses that period's review file as it
  stands, cited with its `generatedAt` and `revision`, and is subject to the
  same age rule.
- Show the inputs next to every derived figure so the user can check it.

## What the report may not do

- Cite an outside benchmark, an industry average, or a platform "rule".
- Attribute a result to a cause at any sample size. These are observational
  records: say which posts did better, never why, unless the user supplies the
  reason. With fewer than about eight measured posts overall, or fewer than
  three in a subgroup, give the values and say the sample is too small to
  compare; the threshold is a reading convention, not a statistical test.
- Estimate, interpolate or round away a missing value.
- Report on followers, profile views or search appearances unless the user
  supplied those numbers for the period.

## Format

```markdown
# LinkedIn review <period>

## Summary
<three to five lines: what was posted, what was measured, the clearest
difference among the user's own posts, stated with its n>

## Posts
| Date | Title | Pillar | Format | Impressions | Reactions | Comments | Reposts | Snapshot age |

## By pillar and format
<counts and means with n; leave out a pillar or format that has only one post>

## Plan versus actual
<slots planned, published, dropped, still open, from the period's plan file>

## Carry forward
<open ideas and drafts, and questions for the user; no targets unless asked>
```

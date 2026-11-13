# Metrics mode

Read before running `metrics`. The snapshot shape is in
`record-schema.md`.

Append one snapshot per reading: `{date, impressions, reactions, comments,
reposts}` plus any other fields the user supplies, with the user's own labels.
Never overwrite an earlier snapshot, never fill an omitted field, never
estimate. To fix a mistyped reading, append a new snapshot with the same `date`,
`corrects: true` and a `reason`. A correction repeats the whole reading: the
corrected fields take the new values and every field the user did not retract
is copied from the snapshot it corrects. For any date the last snapshot written
is the effective one and earlier ones stay as history. A late reading for an earlier
date is inserted in date order. From an analytics export, read `.xlsx` through the workspace's
spreadsheet skill and `.csv` directly, show the rows you matched to posts by
URL, and ask before writing.

# Publish Pack

What `ready` produces for one post, and the field limits `ready` and `profile`
check against.

## Field limits

Character counts include spaces, line breaks, hashtags and emoji.

| Field | Limit |
|---|---|
| Post | 3,000 |
| Comment | 1,250 |
| Headline | 220 |
| About | 2,600 |
| Experience description, per position | 2,000 |
| Text shown before "see more" | roughly 140 on mobile, 210 on desktop |

These are the values commonly reported by third-party LinkedIn guides as of
2026-09; this file could not confirm them against one canonical LinkedIn
table, and LinkedIn changes them without notice. Treat them as working values. Report the
count and the limit; when a count is within 5% of a limit, tell the user to
check it in the LinkedIn editor, which is the authority.

## The pack

Produce these in order, as a reply the user can copy from. Report problems;
change nothing without the user's word.

1. **Final text**, in a code block so line breaks and spacing survive the copy.
2. **Count**: characters used and the limit.
3. **Opening**: an estimate of the text that shows before "see more" on mobile
   (the cut-off is approximate and varies by device), quoted. Say
   whether it states what the post is about. Do not rewrite it for hook value.
4. **Facts to confirm**: every name, title, number, date, amount and quotation
   in the post, as a list for the user to tick. Mark the source for each factual
   group; approved website, blog, project, or other configured sources may
   support a claim, but do not override the CV for career facts. Mark anything
   that came from neither the brief nor an approved configured source.
5. **Mentions**: each person and organization to tag, as the user should type
   them. The user confirms each; tagging is the user's act.
6. **Hashtags**: as they stand in the final text (the body is authoritative;
   `hashtags` in frontmatter mirrors it). Keep the user's choices; say only when there
   are none or more than the post can carry without reading as a tag wall.
7. **Media**: each file with its alt text. A missing file, a missing alt text,
   or text-heavy images without a text equivalent are reported.
8. **Link**: when the post contains a URL, note that the user may prefer the
   link in the first comment and let them choose. Make no claim about reach.
9. **Language**: follow the requested language or `linkedin.default_language`.
   Multiple entries in `linkedin.languages` are supported choices, not a
   requirement to translate. With no settled preference, ask whether a second
   version is wanted; do not translate unasked.
10. **When**: the agreed `scheduledFor`. If it conflicts with the plan or with
    another scheduled post on the same day, say so.

Close with one line: posting is done by the user; run `published` with the URL
afterwards.

## Without a writer skill

When no writer is configured, a plain draft follows the brief and nothing else:
say what happened and who was involved, and why it matters to the reader only
when the brief says so; otherwise leave that out and ask. No invented anecdote,
quotation, statistic, name or emotion. An unnamed party in the brief stays
unnamed, with a `TODO` in the working notes. Offer the polish skill.

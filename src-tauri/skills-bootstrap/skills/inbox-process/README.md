SKILL.md is the instruction source for this skill. This file is background for maintainers; it holds no directives.

# Inbox Process background

## Extraction route for HWP

`.hwp`/`.hwpx` files go through `ahwp cat --format markdown` because that output
keeps tables, merged cells and image positions, which plain-text extraction
loses.

## Route file choices

- `destination: null` is not a typed null. The applying tool reads it as a value
  that is not a path, which is exactly why nothing is moved.
- `filed_as` lines live in the route file because choosing a slug is a judgment
  call. The applying tool only uses the slugs it is given.

## File layout

Mode-specific material sits in `references/` so a normal routing run does not
load it: the review-mode output contract (`maru-review-output.md`), the route
file block (`route-file.md`), and the `extract-tasks` mode (`extract-tasks.md`).

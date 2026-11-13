# Content verification and supplementation

Workflow step 5 (`[phase:verify]`), run before drafting when
`meeting_notes.hooks.verification` is set (e.g. `internal-external`).

- Extract high-risk claims from the normalized material: person
  names/titles/affiliations, org and program names, decisions and their
  owners, dates, amounts, quoted commitments, and any "someone said X is
  happening" attributions.
- Internal verification: cross-check each claim against the step-4 context
  bundle plus targeted lookups: vault notes (`vmem_search` with the `vault` id bound per `lib/vault_adapter.md` §Runtime Discovery),
  past meeting notes under the meeting root, open tasks, and the project
  registry. Flag transcription-error suspects (a surface form
  phonetically/visually close to a known canonical entity, e.g. a garbled
  company name matching a glossary entry) and contradiction suspects (claims
  conflicting with recorded decisions or known project state).
- External verification (last resort): for claims about external parties
  that internal sources cannot settle (a person's current title, an
  org's program, a public event), use web search under the
  context-enrichment §2-7 contract verbatim: results are
  `web_unverified`, carry a source URL, and are promoted only by explicit
  user confirmation. No web lookup for bare person names.
- Supplementation: add context the transcript cannot carry (the formal
  meeting name from the calendar event, full org names from the
  glossary, prior decisions a statement refers to), each tagged with its
  source.
- Every proposed change is emitted as a structured correction in the
  review block (`corrections` in `references/maru-review.md`), never as an
  in-place rewrite.

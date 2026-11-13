# Profile mode

Read before any `profile` action (`audit`, `propose`, `record`).

`linkedin.cv_source` is the factual source; `profile/current.md` is the text
believed to be live on LinkedIn, as last recorded by the user. Without a
configured `cv_source`, `audit` and `propose` stop and say what is missing;
`record` still works.

- `audit`: compare section by section. List what is stale, missing or
  inconsistent, with the CV line that shows it. If `profile/current.md` does not
  exist, ask the user to paste the live text first; do not reconstruct it. Offer
  to save the paste as `profile/current.md` with `source: pasted by the user`
  as a baseline; that is not a `record` of a change and writes no history copy.
  Where the CV holds something with no obvious profile section (a project role,
  an award), list it and ask where the user wants it rather than placing it.
- `propose <section>`: write new text for that section within the field limit
  in `references/publish-pack.md`, from CV facts and approved source citations.
  Write a `linkedin-profile-proposal` under `profile/proposals/`, never
  `profile/current.md`. Reuse an identical proposal and suffix a changed
  collision. Offer the polish skill.
- `record`: after the user has updated LinkedIn by hand, save the new live text
  to `profile/current.md` and a dated copy to `profile/history/`.

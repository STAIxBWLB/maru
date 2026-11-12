# Import mode

Read before running `import`.

From LinkedIn's data export (`Shares.csv` and related files) or loose post
files the user points at, create one record per post in `published/YYYY/` only
when publication evidence belongs to the owner and an absolute publication
date is available (for example from the owner's export or supplied post
URL/date), with
`status: published`, `publishedAt`, `url` when present, the original text as
the body, and `source` naming the file it came from. Field rules for imported
records are in `references/record-schema.md` §Imported posts. Show the list and ask
before writing. Leave the original files where they are. Skip a post that is
already in the archive: match on `url` when the export has one, otherwise on
`importKey` (the raw export timestamp joined to the first 60 characters of the
text). Show a near match (same day, similar opening) to the user instead of
deciding.

# Route File

`inbox.naming.route_file` carries the routing decision. Write the reasoning as
ordinary prose in the workspace language, then one machine-readable block that a
tool can apply without reading the prose:

```markdown
## Destination (schema)

- destination: projects/<project>/<subfolder>/
- project: <project id>
- classification: action
- confidence: medium
- rationale: why this destination, and what is still uncertain
- filed_as: <원본명>.md -> 260730-mail-drive-share-example.md
```

Parsing rules the block must satisfy:

- The heading is matched case-insensitively on the `## destination` prefix, and
  the block ends at the next `##` heading. Emit exactly `## Destination (schema)`.
- Each line is `- key: value`. Keys are `[A-Za-z_]+`, and one level of
  surrounding backticks is stripped from the value.
- Scalar keys are single-valued: repeat one and the **first occurrence wins**.
- `filed_as` is the exception: it is repeatable, and every line **accumulates**
  into the rename map. A bundle with three files needing slugs carries three
  `filed_as` lines, and all three apply.
- Unknown keys are ignored, so the block stays forward-compatible.

| Key | Rule |
|---|---|
| `destination` | Workspace-relative subfolder for raw originals, kind-matched per `naming-and-placement.md` §C. Must contain `/`, must not be absolute, `~`-rooted or contain `..`, and its parent must already exist (at most one new leaf folder). `null` when there is no destination. |
| `project` | Project ID from `project-registry.yaml`, or `null`. |
| `classification` | `action`, `schedule`, `info`, `ideation`, or `noise`. Recorded on the receipt. |
| `confidence` | `high`, `medium`, or `low`. Only `high` and `medium` are applicable without a person deciding. Use `low` whenever the top registry score is weak (`< 3`), the kind is ambiguous, or the item is `noise`/`handoff`. |
| `rationale` | Free text. Parsed but never acted on; it is where doubt belongs, for the human reading the proposal. |
| `filed_as` | Rename map, one line per raw file that needs an English slug. Repeatable and accumulated, unlike the scalar keys above. |

Two ways to say "do not file this anywhere":

- `destination: null`: the explicit no-destination value; prefer it over
  omitting the key, so a reader can tell a decision from a gap.
- `destination: projects/x/  (정본 이전 후)`: a path plus a caveat, separated by
  two spaces or ` (`. The caveat marks the route as not machine-applicable, so a
  person handles it. Use it when the path is right but the timing or precondition
  is not.

`filed_as` lines take the form `- filed_as: <original> -> <slug>`, with `->` or
`→`, backticks optional on either side. The target slug must contain no spaces.
Write one for every raw file that §A4 requires renaming (`.md`, `.txt` or `.svg`
with a non-ASCII name); the applying tool only uses what it was given and skips
the item when the line is missing. Binaries need no `filed_as`.

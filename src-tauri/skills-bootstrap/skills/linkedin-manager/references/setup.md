# Setup

`setup` initializes a channel from user-approved sources. Terminal setup writes
the artifacts and configuration already authorized by the user; background or
review runs produce proposals only. Do not repeat questions answered in the
session. Ask only for a missing root or a material editorial choice that cannot
be resolved from the brief and existing config.

## Configuration and sources

- Follow the main config's pointer before selecting a write target. Update the
  existing effective section, preserving unrelated YAML, comments, and unknown
  keys. When no section exists, terminal setup may add one to the existing
  workspace config using the user-supplied root and known values. With no
  workspace config, request its intended location before creating anything.
- Load `references/workspace-config.md`. Record the supplied profile URL,
  audience, language preference, cadence, approved pillars, CV and source paths.
  Missing facts stay unset. Cadence or content themes are not inferred facts;
  propose them only when editorial suggestions are in scope.
- Current user instructions take precedence for identity and public contact.
  `cv_source` governs career facts. Active public site content supports project,
  research and teaching claims. Legacy drafts support wording and reuse
  candidates, not proof of publication. Report conflicts rather than silently
  treating an archived or duplicated source as current.
- `sources` labels are descriptive. Read approved local files and source
  directories, locate the active site sources, and retain exact source paths
  and relevant sections in the outputs. Goals, planned features and example
  curricula are not demonstrated outcomes. Cite additional sources in working
  notes or proposal bodies; `source` names the primary source.

## Profile read and proposals

Only an explicitly requested public LinkedIn profile may be read, once per
setup request. An earlier failed read in the same setup counts as that attempt.
Do not log in, use an authenticated session, bypass access controls, follow a
login redirect, traverse feeds or search, or interact. A blocked or failed read
stops that part of setup, not the local setup work.

Successful public text may be cited as an observed comparison source, with the
read date. Keep it distinct from user-confirmed live snapshots. Setup writes
only proposals under `paths.profile/proposals`, never `profile/current.md`.
Use the configured CV and approved sources for Headline/About proposals; report
counts, source conflicts, candidate mentions, and the live-comparison gap. The
user later supplies the exact applied text to `profile record`.

## Inventory and reuse

Inventory legacy files before drafting. Use `references/record-schema.md` for
`paths.references/source-inventory.md`. Separate event dates, header labels,
owner-publication evidence, exact publication dates, and measurement dates.
A URL alone does not provide a timestamp, and someone else's original-post URL
does not prove the owner reposted it. Undated metrics remain inventory evidence,
not metric snapshots. Setup is inventory-only for legacy material unless the
user separately requests import and supplies the required evidence.

For approved new topics, search all lifecycle directories before creating an
idea. Match topic/title together with source, not a shared source path alone:
one portfolio file can support different ideas. Reuse a matching record even
if it moved to draft, scheduled, or published; preserve its status and edits.
Surface a near match instead of silently creating a likely duplicate. A
different topic from the same source may be a new idea. Ideas have empty post
bodies, evidence in working notes, and unconfirmed mentions outside `mentions`.

On repeat setup, preserve user-edited plans and records. Reuse an unchanged
inventory; if source evidence changed, show the intended inventory update and
preserve custom notes/unknown fields. Apply a plan revision only when requested,
using the plan update rules rather than creating another plan for the same
period. Identical profile proposals are reused; changed proposals get a numeric
suffix. Use the configured post filename pattern and collision rules.

For `on_demand`, setup may create an undated planning queue for the requested
period. It creates no schedules or reminders for undated ideas. Keep recorded
past and scheduled rows when an existing plan is revised.

## Background contract

In Maru background/review runs, propose only Markdown records whose locations
are known. Describe pending workspace YAML changes and missing prerequisites
in `summary` and `risks`; never add YAML to `files`, fabricate a Markdown config,
or emit executable `commands`. If the user supplied a root but the config is
absent, proposed Markdown artifacts may use that root and must name the pending
config setup. If the root is unknown, return an empty `files` list and the
missing-root risk. Nothing is written during the run.

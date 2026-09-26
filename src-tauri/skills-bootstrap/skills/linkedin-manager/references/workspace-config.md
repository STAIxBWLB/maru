# Workspace Config

The skill discovers `workspace.config.yaml` by walking up from the current
directory. This public package never stores a real owner name, handle, URL or
path.

## Expected Shape

```yaml
linkedin:
  root: ~/workspace/PATH/TO/linkedin
  timezone: Region/City
  profile_url: https://www.linkedin.com/in/HANDLE
  languages: [en]
  default_language: en
  audience: global AI peers and partners
  cadence:
    mode: weekly          # on_demand | weekly; missing mode keeps weekly compatibility
    posts_per_week: 1
    preferred_days: [Tue, Thu]
  pillars: [PILLAR_ONE, PILLAR_TWO]
  cv_source: PATH/TO/cv.yml
  public_contact: CONTACT_FOR_GENERATED_TEXT
  sources:
    identity: PATH/TO/site.yaml
    biography: PATH/TO/about.md
    portfolio: PATH/TO/builds.ts
    publications: PATH/TO/publications.yaml
    courses: PATH/TO/courses
    blog: PATH/TO/blog
    projects: PATH/TO/projects
    legacy_posts: PATH/TO/legacy-posts
    website: https://example.com
  skills:
    writer: WRITER_SKILL_NAME
    polish: POLISH_SKILL_NAME
    tasks: TASK_SKILL_NAME
    spreadsheet: SPREADSHEET_SKILL_NAME
  naming:
    post: "YYMMDD-post-<slug>.md"
  paths:
    ideas: ideas
    drafts: drafts
    scheduled: scheduled
    published: published
    calendar: calendar
    reviews: reviews
    profile: profile
    engagement: engagement
    references: references
```

## Split Section Files

A workspace with a boot-size budget may keep this section in its own file and
leave a pointer comment in `workspace.config.yaml`:

```yaml
# linkedin: -> _meta/config/linkedin.yaml
```

Follow the pointer relative to the directory of `workspace.config.yaml`. The
file's top-level key is still `linkedin`. When both exist, the main config wins.

## Runtime Rules

- Expand `~` before using paths. A relative `root`, `cv_source`, or local value
  in `sources` resolves from
  the directory of `workspace.config.yaml`, also when the section was read
  through a pointer file that lives elsewhere.
- Every key except `root` is optional. A missing `cadence` means the plan asks
  the user for one; missing `pillars` means posts carry no pillar; a missing
  `skills.*` entry means that handoff is not offered.
- `default_language` supplies the output language when the user does not
  specify one; when `languages` exists it must be one of those entries.
  An explicit request overrides the default. `audience` is the intended reader
  description for planning and writer handoffs, not a factual source.
- `sources` maps descriptive labels to local files, directories, or public
  URLs. Read only the sources authorized by the request. Directory entries are
  discovery roots, not permission to publish every file; use active public
  content and separate private or unpublished material. `cv_source` remains
  the career-fact authority, subject to current user instructions.
- `cadence.mode: on_demand` creates a prioritized queue with empty dates and no
  reminders for new undated ideas. Set only `mode: on_demand` for a new
  on-demand configuration; existing weekly settings are ignored in that mode.
  `weekly` or an absent mode keeps weekly behavior. An unknown mode is an error
  to resolve, not permission to schedule. Preserve already recorded dates.
- `naming.post` tokens: `YYMMDD` is the creation date for ideas and drafts and
  is kept when the file moves; `<slug>` is lowercase ASCII with hyphens. When the
  workspace has its own naming rule, the configured pattern carries it.
- `cv_source` is read-only to this skill.
- A skill named under `skills` is handed off to only when it is installed. Say
  so when it is not, and continue without it.

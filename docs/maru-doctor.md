# Maru Doctor

`maru doctor` validates the local skills registry under `~/.maru/skills`.
It is intentionally limited to Maru-managed state; legacy external skill
links outside Maru are ignored unless imported.

The command is strictly read-only. It scans sources and validates registry and
symlink state in memory, but never writes `registry.json`, materializes the
bundled catalog, creates directories, or repairs links. Use `maru skills sync
--apply` for explicit mutation.

## Commands

```bash
maru doctor
maru doctor --json
maru doctor --quiet
maru skills dirty
maru skills dirty --json
maru skills update --check
maru skills update --apply [--repair-env] [--json]
maru skills sync --check --tools claude,codex
maru skills sync --apply --tools claude,codex
```

`skills update --check` is read-only: it reports the active OTA bundle, the
newest `skills-channel` bundle, and any blockers (local edits, env update,
app too old) without touching the active bundle, registry, or tool links.
`skills update --apply` downloads, verifies (minisign signature + sha256),
and atomically applies the bundle; `--repair-env` additionally runs the
bundle's env setup when the runtime env hash changed, rolling the bundle back
if the repair fails.

`skills sync --check` is also read-only and exits `1` when changes are needed.
`skills sync --apply` creates canonical `~/.maru/skills/<name>` links, points
the selected tool runtimes at those canonical links, and updates install
records. It refuses to overwrite non-symlink tool content.

`--quiet` exits `0` when no error issue exists and exits `1` when a critical
skills issue exists.

## Issue Codes

| Code | Severity | Meaning |
|------|----------|---------|
| `duplicate_source` | error | The same skill name appears in more than one registered source. |
| `tier_misplaced` | error | A skill's tier does not match its registered source location. |
| `skill_invalid` | error | Skill frontmatter is malformed or unsupported. |
| `skill_missing` | error | Registry points to a skill directory without `SKILL.md`. |
| `source_invalid` | error | Registry source path is missing or invalid. |
| `install_skill_missing` | error | Install record references a missing skill. |
| `install_link_broken` | error | Install symlink no longer points through Maru. |
| `skill_dirty` | warn | Skill content differs from its saved hash or source working tree. |

Invalid skills remain visible so they can be repaired, but install/dispatch
paths fail closed until doctor is clean.

## Reconcile

```bash
maru skills reconcile <name-or-id> --accept
maru skills reconcile <name-or-id> --discard
```

For `_sources/*` git-backed skills, `--accept` stages, commits, and attempts to
push the skill path. If push fails, the local commit remains and the outcome
reports the push failure. `--discard` restores the skill path from git.

For bundled skills, `--accept` is refused and `--discard` restores the skill
from the ACTIVE bundle's pristine baseline (`~/.maru/skills/_bundles/<id>/`),
falling back to the embedded bootstrap snapshot only when no baseline exists.
For managed/imported skills, `--accept` updates the saved hash and
`--discard` is not available unless the source is git-backed.

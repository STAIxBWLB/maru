# Anchor Doctor

`anchor doctor` validates the local skills registry under `~/.anchor/skills`.
It is intentionally limited to Anchor-managed state; legacy external skill
links outside Anchor are ignored unless imported.

## Commands

```bash
anchor doctor
anchor doctor --json
anchor doctor --quiet
anchor skills dirty
anchor skills dirty --json
```

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
| `install_link_broken` | error | Install symlink no longer points through Anchor. |
| `skill_dirty` | warn | Skill content differs from its saved hash or source working tree. |

Invalid skills remain visible so they can be repaired, but install/dispatch
paths fail closed until doctor is clean.

## Reconcile

```bash
anchor skills reconcile <name-or-id> --accept
anchor skills reconcile <name-or-id> --discard
```

For `_sources/*` git-backed skills, `--accept` stages, commits, and attempts to
push the skill path. If push fails, the local commit remains and the outcome
reports the push failure. `--discard` restores the skill path from git.

For bundled skills, `--accept` is refused and `--discard` rematerializes the
embedded bundle copy. For managed/imported skills, `--accept` updates the saved
hash and `--discard` is not available unless the source is git-backed.

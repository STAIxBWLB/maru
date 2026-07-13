# Skills SSOT Tiers

Maru treats skills as a federated catalog with one owner per skill name.

## Source ownership classes

| Class | Registry kind / source | Ownership | Maru sync behavior |
|------|-------------------------|-----------|--------------------|
| Bundled | `builtin` / `maru-builtin` | Maru release | Installable |
| Owned catalog | `linked` or `cloned` / public, private, managed | Catalog repository or local Maru owner | Installable |
| Imported | `imported` / `maru-imported` | Explicit local import | Installable |
| External managed | `external-managed` | `~/.agents` or another manager | Inventory only, never copied or installed |
| Tool native | `tool-native` | Claude/Codex plugin or built-in runtime | Inventory only, never copied or installed |

The default owned catalog is 43 skills: 34 bundled, 5 public, and 4 private.
Synchronizing it to Claude and Codex produces 86 Maru install records. Tool
native/plugin skills remain owned by their tool and are excluded from that
count. Maru nevertheless inventories `~/.agents/skills` as `external-managed`
and `~/.codex/skills/.system` as `tool-native` registry sources when those
directories exist. These inventory-only skill counts appear in the registry
and doctor output, but never increase the 43 managed skills or 86 installs.

| Tier | Location | Identity | Change Path |
|------|----------|----------|-------------|
| T1 Core | `dev/maru/skills/skills/<name>/` | Maru-bundled skill, deployed via the `skills-channel` OTA bundle (no app release needed) | `dev/maru` PR → auto-published bundle |
| T2 Public | `~/.maru/skills/_sources/skills-public/skills/<name>/` | Public reusable skill | `STAIxBWLB/skills` PR |
| T3 Private | `~/.maru/skills/_sources/skills-private/skills/<name>/` | Private or identity-bearing skill | `entelecheia/skills` push |
| T4 Imported | `~/.maru/skills/_imported/skills/<name>/` | Explicitly imported external skill | `maru skills import` |
| T5 Managed Local | `~/.maru/skills/_managed/<name>/` | Local-only managed skill | Maru local registry |

## Invariants

- One skill name belongs to one tier only.
- Duplicate names across registered sources are registry validation errors.
- Duplicate or misplaced skills are visible for repair but cannot install or dispatch.
- `public` and `private` tiers are valid only in their matching `_sources/skills-public` or `_sources/skills-private` checkouts.
- Runtime edits are allowed, but the owner tier determines the reconcile path.
- External legacy skills remain outside Maru management unless explicitly imported.

## T1 deployment

T1 skills ship as signed immutable bundles on the fixed `skills-channel`
prerelease of `STAIxBWLB/maru` (see `skills/README.md`). The app applies the
newest bundle automatically at launch when `_builtin` is clean and the
runtime env hash matches; otherwise the update waits for a manual apply
(`maru skills update --apply [--repair-env]` or the Skills UI). Local T1
edits block bundle apply until promoted (Save As) or discarded. The embedded
`src-tauri/skills-bootstrap/` snapshot only seeds offline first runs and can
never downgrade an applied bundle.

## Reconcile Paths

- T1 dirty runtime copy: revert (restores the ACTIVE bundle content), or change `dev/maru`, or promote to T2/T3.
- T2 dirty source: commit/push in `STAIxBWLB/skills`.
- T3 dirty source: commit/push in `entelecheia/skills`.
- T4 dirty imported skill: accept the local/imported state or unmanage it.
- T5 dirty managed skill: accept the local registry state or delete.

## Commands

```bash
maru doctor --quiet
maru skills update --check
maru skills update --apply [--repair-env]
maru skills sync --check --tools claude,codex
maru skills sync --apply --tools claude,codex
maru skills dirty --json
maru skills reconcile <name-or-id> --accept --message "maru: reconcile <name>"
maru skills reconcile <name-or-id> --discard
maru skills import /path/to/skill --copy
maru skills import-unmanage <name> --delete-files
```

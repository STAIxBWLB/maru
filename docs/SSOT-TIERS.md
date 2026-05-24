# Skills SSOT Tiers

Anchor treats skills as a federated catalog with one owner per skill name.

| Tier | Location | Identity | Change Path |
|------|----------|----------|-------------|
| T1 Core | `dev/anchor/skills/skills/<name>/` | Anchor-bundled skill embedded in the app | `dev/anchor` PR |
| T2 Public | `~/.anchor/skills/_sources/skills-public/skills/<name>/` | Public reusable skill | `STAIxBWLB/skills` PR |
| T3 Private | `~/.anchor/skills/_sources/skills-private/skills/<name>/` | Private or identity-bearing skill | `entelecheia/skills` push |
| T4 Imported | `~/.anchor/skills/_imported/skills/<name>/` | Explicitly imported external skill | `anchor skills import` |
| T5 Managed Local | `~/.anchor/skills/_managed/<name>/` | Local-only managed skill | Anchor local registry |

## Invariants

- One skill name belongs to one tier only.
- Duplicate names across registered sources are registry validation errors.
- Duplicate or misplaced skills are visible for repair but cannot install or dispatch.
- `public` and `private` tiers are valid only in their matching `_sources/skills-public` or `_sources/skills-private` checkouts.
- Runtime edits are allowed, but the owner tier determines the reconcile path.
- External legacy skills remain outside Anchor management unless explicitly imported.

## Reconcile Paths

- T1 dirty runtime copy: revert, or change `dev/anchor`, or promote to T2/T3.
- T2 dirty source: commit/push in `STAIxBWLB/skills`.
- T3 dirty source: commit/push in `entelecheia/skills`.
- T4 dirty imported skill: accept the local/imported state or unmanage it.
- T5 dirty managed skill: accept the local registry state or delete.

## Commands

```bash
anchor doctor --quiet
anchor skills dirty --json
anchor skills reconcile <name-or-id> --accept --message "anchor: reconcile <name>"
anchor skills reconcile <name-or-id> --discard
anchor skills import /path/to/skill --copy
anchor skills import-unmanage <name> --delete-files
```

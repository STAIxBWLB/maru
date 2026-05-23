# Skills SSOT Tiers

Anchor treats skills as a federated catalog with one owner per skill name.

| Tier | Location | Identity | Change Path |
|------|----------|----------|-------------|
| T1 Core | `dev/anchor/skills/skills/<name>/` | Anchor-bundled core skill embedded in the app | `dev/anchor` PR |
| T2 Public | `~/.anchor/skills/_sources/skills-public/skills/<name>/` | Public reusable skill | `STAIxBWLB/skills` PR |
| T3 Private | `~/.anchor/skills/_sources/skills-private/skills/<name>/` | Private or identity-bearing skill | `entelecheia/skills` push |
| T4 Managed Local | `~/.anchor/skills/_managed/<name>/` | Local-only managed skill | Anchor local registry |

## Invariants

- One skill name belongs to one tier only.
- Duplicate names across registered sources are registry validation errors.
- Duplicate skills are visible for repair but cannot dispatch.
- Runtime edits are allowed, but the owner tier determines the reconcile path.

## Reconcile Paths

- T1 dirty runtime copy: revert, or change `dev/anchor`, or promote to T2/T3.
- T2 dirty source: commit/push in `STAIxBWLB/skills`.
- T3 dirty source: commit/push in `entelecheia/skills`.
- T4 dirty managed skill: save local registry state or delete.

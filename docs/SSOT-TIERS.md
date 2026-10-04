# Skills SSOT Tiers

Maru treats skills as a federated catalog with one owner per skill name.

## Source ownership classes

| Class | Registry kind / source | Ownership | Maru sync behavior |
|------|-------------------------|-----------|--------------------|
| Bundled | `builtin` / `maru-builtin` | Maru release | Installable |
| Owned catalog | `linked` or `cloned` / public, private, managed | Catalog repository or local Maru owner | Installable |
| Imported | `imported` / `maru-imported` | Explicit local import | Installable |
| External managed | `external-managed` | `~/.agents` or another manager | Inventory only, never copied or installed |
| Tool native | `tool-native` | Agent-tool plugin or built-in runtime | Inventory only, never copied or installed |

The default owned catalog is 48 skills: 39 bundled, 5 public, and 4 private.
A full unfiltered sync records 48 Maru installs per requested target (96 for
the historical `claude,codex` pair, up to 288 for all six). Tool
native/plugin skills remain owned by their tool and are excluded from that
count. Maru nevertheless inventories `~/.agents/skills` as `external-managed`
and `$CODEX_HOME/skills/.system` as `tool-native` when `CODEX_HOME` is set,
falling back to `~/.codex/skills/.system`. These inventory-only skill counts
appear in the registry and doctor output, but never increase the 48 managed
skills or the install count. Only Maru-owned (bundled, owned-catalog,
imported) entries are deployable; `maru skills list --json` marks everything
else `installable: false` with a reason.

| Tier | Location | Identity | Change Path |
|------|----------|----------|-------------|
| T1 Core | `STAIxBWLB/skills` repo, `skills/<name>/` | Maru-bundled skill, deployed via the `skills-channel` OTA bundle (no app release needed) | `STAIxBWLB/skills` PR → auto-published bundle |
| T2 Public | `~/.maru/skills/_sources/skills-public/skills/<name>/` | Public reusable skill | frozen on the `archive/legacy-catalog` branch of `STAIxBWLB/skills` (that repo is now the T1 bundle source) |
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
prerelease of `STAIxBWLB/skills` (see that repo's README). The app applies
the newest bundle automatically when `_builtin` is clean and the runtime env
hash matches; otherwise it notifies and the update waits for a manual apply
(`maru skills update --apply [--repair-env]` or the Skills UI). Local T1
edits block bundle apply until promoted (Save As) or discarded. The embedded
`src-tauri/skills-bootstrap/` snapshot only seeds offline first runs and can
never downgrade an applied bundle; refresh it with
`make skills-bootstrap-refresh` at release time.

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
maru skills capabilities --json
maru skills list --json
maru skills sync --check --tools claude,codex
maru skills sync --apply --tools claude,kimi --skills meeting-notes --json
maru skills dirty --json
maru skills reconcile <name-or-id> --accept --message "maru: reconcile <name>"
maru skills reconcile <name-or-id> --discard
maru skills import /path/to/skill --copy
maru skills import-unmanage <name> --delete-files
```

## Federation targets

`maru skills sync` deploys to six explicit targets: `claude`, `codex`, `kimi`,
`qwen`, `grok`, and `opencode`. Destination roots resolve machine-locally:

| Target | Root | Profile override |
|--------|------|------------------|
| `claude` | `~/.claude/skills` | alternate `HOME` |
| `codex` | `~/.codex/skills` | `$CODEX_HOME` (including isolated Orca account profiles) |
| `kimi` | `~/.kimi-code/skills` | `$KIMI_CODE_HOME` |
| `qwen` | `~/.qwen/skills` | alternate `HOME` |
| `grok` | `~/.grok/skills` | alternate `HOME` |
| `opencode` | `~/.config/opencode/skills` | `$OPENCODE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/opencode` |

Overrides must be absolute. Recorded install roots are sticky: a changed
runtime home fails with an actionable error unless `--retarget` is explicitly
supplied, and orchestrators must never add that flag automatically.

Selected sync (`--skills <names-or-ids>`) is additive: the complete selection
is validated before any write, unknown/ambiguous/empty selectors are rejected,
unrelated installs are preserved, and deselecting a skill stops future writes
without removing existing links or data. Targets that alias one physical root
share a single physical link while each profile keeps its own ownership
record. Collisions and foreign links are reported, never overwritten. Skill
visibility in a shared global root is file exposure, not a promise of
isolation from unselected agents, and not proof that a particular agent
release loaded the skill.

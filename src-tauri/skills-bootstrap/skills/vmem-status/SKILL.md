---
name: vmem-status
description: Use when asked which vmem version is installed, whether vmem is up to date, or whether the vmem install and its vault registry are healthy (not note content; that is vault-stats). Reports the running vmem build against this bundle's floor, other installs on PATH, registered vaults and doctor findings, read-only.
---

# vmem-status

Answer "what vmem runs here and is it healthy" in one report. Every step is read-only: give repairs as commands for the person to run.

## Process

1. **Build**: run `vmem --version`. Read `requires.vmem` from the bundle's `manifest.json`, `../../manifest.json` from this skill directory's real (symlink-resolved) path, and compare; when it cannot be read, report the floor as unknown. Below the floor, the vault skills in this bundle stop; say so.
2. **Other installs**: list every `vmem` on PATH (`which -a vmem`, `where vmem` on Windows) and run `--version` on each distinct resolved file. When versions differ, the lower one is stale. A stale install that runs is replaced by fixing PATH order or removing it; a stale shadowed install runs whenever PATH order changes, so remove it.
3. **Registry**: run `vmem status --json`. Take `version`, `home`, `source`, `healthy`, and per vault `id`, `kind`, `write`, `pii`, `healthy`, `path`.
4. **Doctor**: run `vmem doctor --json`. Its top-level `healthy` and exit code (1 means unhealthy, a finding to report, not a failure of this skill) are the verdict. Report each vault with `healthy: false` and its `issue`, each `vaults[].checks.<name>` with `ok: false` and its `issue`, each `specs[]` entry with `healthy: false` and its `issue`, and each vault's `tidy` (pending migration) as a warning.
5. **Leftovers**: run `vmem recover --json` without `--confirm`; it only previews. Report `lock.state` and any `temporaryFiles`. Exit 1 with `blocked` is a finding: a `live` lock means a writer is running, so wait and rerun; an `unknown` owner (unreadable, or another host's lock) means the person confirms no writer runs on any host, then removes `lock.path` by hand.
6. **MCP**: when the vmem MCP tools are available, call `vmem_status`. A vault list that differs from step 3 means the MCP server started before the last registry change (restart the host session) or runs another build or home; report which fits. A `vaults remove` does not show as a mismatch, so after one the server needs a restart either way.

## Output

- One line: running version, bundle floor, verdict (ok, upgrade needed).
- Other installs with versions, only when step 2 found any.
- Vaults table: id, kind, write, pii, health, path.
- Doctor failures and tidy warnings from step 4; "healthy" only when doctor's `healthy` is true.
- At most one next action with its command: upgrade below the floor, the repair a doctor `issue` names, `vmem recover --confirm` when step 5 is not `blocked` and shows a `stale` lock or `temporaryFiles`, rerunning `vmem recover --json` after a live writer finishes, or removing the file at `lock.path` once no writer runs, `vmem tidy <vault> --all` (preview) for pending migration, or removing a stale install with the package manager that owns it.

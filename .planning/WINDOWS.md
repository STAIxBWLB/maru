---
schema_version: 1
open_count: 1
waived_count: 0
fixed_count: 0
total_count: 1
last_updated: 2026-08-22T21:43:44.468Z
---

# Broken Windows Ledger

> Cross-phase defect register. With `workflow.windows_enforce` enabled, `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 02 | todo | src-tauri/src/paths.rs |  | require_absolute keeps #[allow(dead_code)] until plan 02-03 wires the SCAN-04 guard in skill_host/fs.rs | open |  | 2026-08-22T21:43:44.468Z |  |

````json
[
  {
    "id": 1,
    "kind": "todo",
    "phase": "02",
    "file": "src-tauri/src/paths.rs",
    "line": null,
    "description": "require_absolute keeps #[allow(dead_code)] until plan 02-03 wires the SCAN-04 guard in skill_host/fs.rs",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-08-22T21:43:44.468Z",
    "resolved_at": null
  }
]
````

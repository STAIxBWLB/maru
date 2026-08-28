---
schema_version: 1
open_count: 0
waived_count: 0
fixed_count: 3
total_count: 3
last_updated: 2026-08-25T22:00:10.739Z
---

# Broken Windows Ledger

> Cross-phase defect register. With `workflow.windows_enforce` enabled, `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 02 | todo | src-tauri/src/paths.rs |  | require_absolute keeps #[allow(dead_code)] until plan 02-03 wires the SCAN-04 guard in skill_host/fs.rs | fixed |  | 2026-08-22T21:43:44.468Z | 2026-08-22T22:00:52.150Z |
| 2 | 04 | deviation | src/App.tsx |  | Kept EditorPane command ports stable across App renders with current-scope dispatch. | fixed |  | 2026-08-25T21:59:50.997Z | 2026-08-25T22:00:10.661Z |
| 3 | 04 | deviation | src/__tests__/editorSurfaceRenderIsolation.test.tsx |  | Separated render-domain probes so changed-slice counters measure independent subscribers. | fixed |  | 2026-08-25T21:59:51.076Z | 2026-08-25T22:00:10.739Z |

````json
[
  {
    "id": 1,
    "kind": "todo",
    "phase": "02",
    "file": "src-tauri/src/paths.rs",
    "line": null,
    "description": "require_absolute keeps #[allow(dead_code)] until plan 02-03 wires the SCAN-04 guard in skill_host/fs.rs",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-08-22T21:43:44.468Z",
    "resolved_at": "2026-08-22T22:00:52.150Z"
  },
  {
    "id": 2,
    "kind": "deviation",
    "phase": "04",
    "file": "src/App.tsx",
    "line": null,
    "description": "Kept EditorPane command ports stable across App renders with current-scope dispatch.",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-08-25T21:59:50.997Z",
    "resolved_at": "2026-08-25T22:00:10.661Z"
  },
  {
    "id": 3,
    "kind": "deviation",
    "phase": "04",
    "file": "src/__tests__/editorSurfaceRenderIsolation.test.tsx",
    "line": null,
    "description": "Separated render-domain probes so changed-slice counters measure independent subscribers.",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-08-25T21:59:51.076Z",
    "resolved_at": "2026-08-25T22:00:10.739Z"
  }
]
````

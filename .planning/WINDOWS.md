---
schema_version: 1
open_count: 1
waived_count: 1
fixed_count: 4
total_count: 6
last_updated: 2026-09-25T14:37:57.041Z
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
| 4 | 08 | deviation | src-tauri/src/git.rs |  | Plan05 uses owned AppHandle and real worker-local State lookup to preserve ApprovalState ownership without changing its representation. | fixed |  | 2026-09-05T05:40:43.884Z | 2026-09-05T05:40:54.363Z |
| 5 | 10-bundle-and-build-hardening | stub |  |  | no stubs introduced by plan 10-02 | open |  | 2026-09-24T22:24:57.774Z |  |
| 6 | 11 | deviation | src/components/graph/GraphCanvas.tsx | 311 | make verify typecheck fails: pre-existing implicit-any TS7006 in GraphCanvas.tsx forEachEdge/forEachNode callbacks, unrelated to Phase 11 plan 04 (VALID-01) | waived | Not a code regression: TS7006 in GraphCanvas.tsx appears only in agent worktrees whose pnpm install links graphology via the global virtual store; main checkout typecheck exits 0 at 9446eb0a and CI make verify is green. See phase 11 deferred-items.md. | 2026-09-25T14:24:07.664Z | 2026-09-25T14:37:57.041Z |

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
  },
  {
    "id": 4,
    "kind": "deviation",
    "phase": "08",
    "file": "src-tauri/src/git.rs",
    "line": null,
    "description": "Plan05 uses owned AppHandle and real worker-local State lookup to preserve ApprovalState ownership without changing its representation.",
    "status": "fixed",
    "reason": "",
    "recorded_at": "2026-09-05T05:40:43.884Z",
    "resolved_at": "2026-09-05T05:40:54.363Z"
  },
  {
    "id": 5,
    "kind": "stub",
    "phase": "10-bundle-and-build-hardening",
    "file": "",
    "line": null,
    "description": "no stubs introduced by plan 10-02",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-09-24T22:24:57.774Z",
    "resolved_at": null
  },
  {
    "id": 6,
    "kind": "deviation",
    "phase": "11",
    "file": "src/components/graph/GraphCanvas.tsx",
    "line": 311,
    "description": "make verify typecheck fails: pre-existing implicit-any TS7006 in GraphCanvas.tsx forEachEdge/forEachNode callbacks, unrelated to Phase 11 plan 04 (VALID-01)",
    "status": "waived",
    "reason": "Not a code regression: TS7006 in GraphCanvas.tsx appears only in agent worktrees whose pnpm install links graphology via the global virtual store; main checkout typecheck exits 0 at 9446eb0a and CI make verify is green. See phase 11 deferred-items.md.",
    "recorded_at": "2026-09-25T14:24:07.664Z",
    "resolved_at": "2026-09-25T14:37:57.041Z"
  }
]
````

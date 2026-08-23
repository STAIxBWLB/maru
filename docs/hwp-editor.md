# hwp-editor integration (hwped_*)

Maru hosts the [hwp-editor](https://github.com/entelecheia/hwp-editor) engine
bridge: six Tauri commands (`src-tauri/src/hwped.rs`) that spawn the `hwp`
binary (hwp-cli >= 0.8.7) behind the editor's `HwpEngine` contract. This is a
backend-only landing — embedding the editor UI into a Maru mode is a later,
separate decision.

## Commands

All commands are async wrappers over blocking spawns (`spawn_blocking`,
following `check_gws_auth`). Fixed argv, no shell, 60s timeout, 32MB stdout
cap — mirroring the Node CliEngine (`packages/server/src/cli-engine.ts` in
hwp-editor).

| Command | CLI invocation | Returns |
|---|---|---|
| `hwped_read` | `hwp cat <in> --format markdown --with-segments` | CatEnvelope JSON |
| `hwped_render` | `hwp render <in> -o page.<fmt> --format --pages --dpi --report` | `{ pages: [{ page, width, height, dpi, format, dataBase64 }] }` |
| `hwped_edit` | `hwp edit <in> -o <out> <opsArgv...> [--verify] [--allow-partial]` | `{ name, dataBase64 }` |
| `hwped_compose` | `hwp compose <spec.json> -o <out> --report` | `{ name, dataBase64, report? }` |
| `hwped_validate` | `hwp validate <in> --json` (exit 1 = invalid, report still parsed) | `{ valid, errors }` |
| `hwped_capabilities` | `hwp --version` (enforces >= 0.8.7, memoized) | `{ version, editable, formats }` |

Documents cross the bridge as `HwpedDocumentRef`: a workspace `path`
(relative paths are resolved against `workspaceRoot` with an escape guard)
when the bytes are already on disk, `dataBase64` otherwise. Edit ops are
serialized JS-side (`opsToArgv` from `@hwp-editor/core`) and passed as
`opsArgv` flag/value fragments, so Rust owns no op grammar.

Errors are prefixed strings (`cli_missing:`, `hwp_timeout:`, `hwp_failed:`,
`hwp_parse_failed:`, `hwped_bad_request:`), matching the `gws` convention.

## Binary resolution

`MARU_HWP_BIN` env override → `hwp` on (augmented) PATH → bundled fallbacks
`~/.maru/skills/hwpx/hwp`, `~/.maru/skills/_builtin/skills/hwpx/hwp`, and the
repo `skills/skills/hwpx/hwp` — the `find_hwpx_tool` convention
(`export/dispatch.rs`).

## Frontend

Typed invoke wrappers live in `src/lib/hwped.ts`. When `@hwp-editor/core` is
vendored, prefer its engine factory over calling the wrappers directly:

```ts
import { invoke } from "@tauri-apps/api/core";
import { createTauriEngine } from "@hwp-editor/core";

const engine = createTauriEngine(invoke, {
  workspaceRoot,
  pathOf: (doc) => /* workspace-relative path when on disk */,
});
```

Theming maps Maru's tokens onto the editor's `--hwped-*` contract; see
`docs/integration-maru.md` and `docs/theme-contract.md` in the hwp-editor
repo for the mapping.

## Follow-up: resident MCP server

Each command spawns a fresh `hwp` process. Render-heavy sessions would
benefit from a resident `hwp mcp --root <dir>` stdio server (16 tools) kept
alive for the app's lifetime. Deliberately not implemented: the CLI spawner
keeps parity with the Node engine and carries no process lifecycle.

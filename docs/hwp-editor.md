# hwp-editor integration (hwped_*)

Maru hosts the [hwp-editor](https://github.com/STAIxBWLB/hwp-editor) engine
bridge: six Tauri commands (`src-tauri/src/hwped.rs`) that spawn the `hwp`
binary (hwp-cli >= 0.20.0) behind the editor's `HwpEngine` contract. This is a
backend milestone; the published-engine UI migration follows the release
gate described below.

## Commands

All commands are async wrappers over blocking spawns (`spawn_blocking`,
following `check_gws_auth`). Fixed argv, no shell, 60s timeout, 32MB stdout
cap. The 0.20.0 minimum matches the upstream CLI engine and includes both
`--ops` and `--layout-json`; older accepted binaries lacked these flags. This is
separate from compatibility with older JS clients that use `opsArgv`. The worker
boundary mirrors the Node CliEngine (`packages/server/src/cli-engine.ts` in
hwp-editor).

| Command | CLI invocation | Returns |
|---|---|---|
| `hwped_read` | `hwp cat <in> --format markdown --with-segments` | CatEnvelope JSON |
| `hwped_render` | `hwp render <in> -o page.<fmt> --format --pages --dpi --report --layout-json <file>` | `{ pages: [{ page, width, height, dpi, format, dataBase64, layout? }] }` |
| `hwped_edit` | `hwp edit <in> -o <out> (--ops <file> or <opsArgv...>) [--verify] [--allow-partial]` | `{ name, dataBase64 }` |
| `hwped_compose` | `hwp compose <spec.json> -o <out> --report` | `{ name, dataBase64, report? }` |
| `hwped_validate` | `hwp validate <in> --json` (exit 1 = invalid, report still parsed) | `{ valid, errors }` |
| `hwped_capabilities` | `hwp --version` (enforces >= 0.20.0, memoized) | `{ version, editable, formats, editOps: "v1" }` |

Documents cross the bridge as `HwpedDocumentRef`: a workspace `path`
(relative paths are resolved against `workspaceRoot` with an escape guard)
when the bytes are already on disk, `dataBase64` otherwise.

`hwped_edit` takes exactly one of `ops` and `opsArgv`. The JSON `ops` channel
accepts a flat `edit-ops-v1` array, writes it to an isolated per-call `ops.json`,
and invokes `hwp edit --ops`. Rust checks only the array envelope; the engine
owns the operation grammar. Run addresses and half-open source WCHAR/UTF-16
`chars` ranges pass through unchanged. They are never converted to text selectors.
Legacy clients keep sending `opsArgv` flag/value pairs. Both or neither channel,
and a nonarray JSON payload, fail with `hwped_bad_request`. Explicit null keys
are present, not an alternative spelling of omission, and are rejected. Temporary files are
removed after output readback, and edits return new bytes without overwriting
the input document.

`hwped_render` requests an optional `hwp-render-layout-v1` artifact with schema
version `1.x`. Each returned page receives its matching `layout` by actual
page number, containing `width_pt`, `height_pt`, `rows` and `truncated`.
Point coordinates are independent of image DPI. Row order, repeated segment IDs,
nullable boxes and source-character ranges are preserved. Source ranges are not
Markdown offsets and must not be used to slice JS text. A missing optional artifact omits
`layout`; a present but malformed or incomplete artifact fails
with `hwp_parse_failed`, rather than being presented as empty measured geometry.

The Rust channel and capability are the first milestone of [#563](https://github.com/STAIxBWLB/maru/issues/563).
The frontend switch to published `createTauriEngine`, editor mount and theme-token
mapping wait for the core release that reads `capabilities.editOps`. Existing
Maru wrappers continue using the legacy channel until that migration.

Errors are prefixed strings (`cli_missing:`, `hwp_timeout:`, `hwp_failed:`,
`hwp_parse_failed:`, `hwped_bad_request:`), matching the `gws` convention.

## Binary resolution

`MARU_HWP_BIN` env override → `hwp` on (augmented) PATH. The retired `hwpx`
skill no longer ships a binary, so there are no bundled fallbacks. Studio's
template fields, fill and validate (native `hwp_cli_skill` / legacy `hwpx_skill`
records and workspace `.hwpx` templates), Markdown → HWPX export, PDF from
the exported HWPX, the inline HWPX preview (`hwp convert --to html -o -`) and
the HWPX structure checks of export validation and the evidence binder resolve
the released `hwp` through `hwp_cli_template::hwp_bin()`, which also enforces
its minimum version (1.3.0, the release with `hwp slots --forms` and `hwp fill
--forms`, plus the corrupt `.hwp` merge/fill output fix). No code path runs
the retired `hwpx` binary, and Maru keeps no HWPX
parser of its own.

## Frontend

Typed invoke wrappers live in `src/lib/hwped.ts`. Once the published `@hwp-editor/core` release supports `capabilities.editOps`,
the migration replaces the mirrored wire types with its engine factory:

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

## Verification

The normal Rust suite covers channel exclusivity, array-only host validation,
JSON/address preservation, per-call cleanup, legacy compatibility, real Tauri
argument decoding, and optional/malformed/multi-page layout metadata.

An opt-in released-engine test generates a small HWPX with two identical Korean
phrases, invokes the Rust JSON channel for the second phrase's run address,
and reads the engine's JSON IR to verify that only that phrase becomes bold.
It also checks real page-layout propagation. Run this test alone with
`MARU_HWPED_REAL_TEST_BIN` set to a checksum-verified hwp-cli release at or above
1.3.1; the test is explicitly ignored in the hermetic suite and requires no
existing documents or live editor session:

```sh
cargo test --lib hwped::phase08_21::released_hwp_changes_only_the_addressed_duplicate_and_returns_page_layout -- --ignored --exact --test-threads=2 --nocapture
```

The resulting HWPX is generated test input, not a third-party-authored sample.
This CLI/MockRuntime evidence does not establish WKWebView or Korean IME behavior.

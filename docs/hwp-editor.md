# hwp-editor integration (hwped_*)

Maru hosts the [hwp-editor](https://github.com/STAIxBWLB/hwp-editor) engine
bridge: six Tauri commands (`src-tauri/src/hwped.rs`) that spawn the `hwp`
binary (hwp-cli >= 0.8.7) behind the editor's `HwpEngine` contract. This is a
backend milestone; the published-engine UI migration follows the release
gate described below.

## Commands

All commands are async wrappers over blocking spawns (`spawn_blocking`,
following `check_gws_auth`). Fixed argv, no shell, 60s timeout, 32MB stdout
cap. The global hwp-cli floor is 0.8.7, which keeps read, compose, validate,
render without layout metadata, and legacy `opsArgv` edits available. The JSON
`--ops` channel and render `--layout-json` require hwp-cli 0.20.0. This feature
floor is separate from global binary compatibility and from compatibility with
older JS clients that use `opsArgv`. The worker boundary mirrors the Node
CliEngine (`packages/server/src/cli-engine.ts` in hwp-editor).

| Command | CLI invocation | Returns |
|---|---|---|
| `hwped_read` | `hwp cat <in> --format markdown --with-segments` | CatEnvelope JSON |
| `hwped_render` | `hwp render <in> -o page.<fmt> --format --pages --dpi --report [--layout-json <file>]` | `{ pages: [{ page, width, height, dpi, format, dataBase64, layout? }], notes?: [{ code, message }] }` |
| `hwped_edit` | `hwp edit <in> -o <out> (--ops <file> or <opsArgv...>) [--verify] [--allow-partial]` | `{ name, dataBase64 }` |
| `hwped_compose` | `hwp compose <spec.json> -o <out> --report` | `{ name, dataBase64, report? }` |
| `hwped_validate` | `hwp validate <in> --json` (exit 1 = invalid, report still parsed) | `{ valid, errors }` |
| `hwped_capabilities` | `hwp --version` (enforces >= 0.8.7, memoized) | `{ version, editable, formats, editOps?: "v1" }` |

Documents cross the bridge as `HwpedDocumentRef`: a workspace `path`
(relative paths are resolved against `workspaceRoot` with an escape guard)
when the bytes are already on disk, `dataBase64` otherwise.

`hwped_edit` takes exactly one of `ops` and `opsArgv`. The JSON `ops` channel
accepts a flat `edit-ops-v1` array, writes it to an isolated per-call `ops.json`,
and invokes `hwp edit --ops`; this channel requires hwp-cli 0.20.0 or newer.
Rust checks only the array envelope; the engine owns the operation grammar. Run
addresses and half-open source WCHAR/UTF-16 `chars` ranges pass through unchanged
and are never converted to text selectors.
JSON image paths resolve beside the staged ops file in the temporary directory,
so callers must supply absolute asset paths until an asset-root contract exists.
Legacy clients keep sending
`opsArgv` flag/value pairs and remain supported from the global 0.8.7 floor.
The legacy channel accepts all 28 named edit-operation flags from `opsToArgv`.
CLI controls and file options (`--ops`, `--report`, `--output`, `--verify`, and
`--allow-partial`) are refused. `--insert-image` and `--seal` require an existing
file inside `workspaceRoot`: relative paths resolve there, and canonical paths
must remain contained, including symlink targets. The bridge passes the resolved
absolute path while preserving the anchor and optional size suffix. Missing or
escaping assets fail with a cause and a next step. Values starting with `-` are
accepted only when they parse as finite numbers; other hyphen-leading values use
JSON, which requires the 0.20.0 feature floor.
Both or neither channel, and a nonarray JSON payload, fail with
`hwped_bad_request`. Explicit null keys are present, not an alternative spelling
of omission, and are rejected. Temporary files are removed after output
readback, and edits return new bytes without overwriting the input document.

`hwped_render` requests an optional `hwp-render-layout-v1` artifact with schema
version `1.x` automatically when the binary supports it. `options.layout: false`
disables that request; `options.layout: true` explicitly requires hwp-cli 0.20.0
or newer and returns a structured feature-version error on an older binary. Each
returned page receives its matching `layout` by actual page number, containing
`width_pt`, `height_pt`, `rows` and `truncated`. Point coordinates are
independent of image DPI. Row order, repeated segment IDs, nullable boxes and
source-character ranges are preserved. Source ranges are not Markdown offsets
and must not be used to slice JS text. Row box coordinates must be finite, but
the bridge preserves reversed endpoints because the wire schema allows them;
source-character ranges still require `start <= end`.

When layout metadata is automatic on a 0.20+ binary, missing, malformed or
incomplete metadata does not discard valid rendered pages. The response omits
`layout` for every page and includes one nonfatal note such as
`{ "code": "layout_metadata_unavailable", "message": "..." }`. Metadata is
all-or-nothing across the returned pages. `options.layout: true` instead fails
with `hwp_parse_failed` when the artifact is missing, malformed, or does not
cover every rendered page. `options.layout: false` and automatic rendering on
older supported binaries do not request metadata and omit both `layout` and
`notes`, preserving the legacy image-only response shape.
If an optional layout pass exits nonzero, the bridge retries once without layout
in a fresh output directory and returns a `layout_metadata_unavailable` note on
success. A subsequent SVG-to-PNG fallback keeps layout disabled. Explicit
`layout:true` keeps CLI failures fatal. A failed JSON/layout command invalidates
the selected binary's cached version, so the next call re-probes a manager shim
whose selected engine changed without changing the shim's path or mtime.

`hwped_capabilities` always reports the detected version and base editing
availability. It includes `editOps: "v1"` only when the detected binary meets
the 0.20.0 feature floor; older accepted binaries omit that capability.

The Rust channel and capability are the first milestone of [#563](https://github.com/STAIxBWLB/maru/issues/563).
The frontend switch to published `createTauriEngine`, editor mount and theme-token
mapping wait for the core release that reads `capabilities.editOps`. Existing
Maru wrappers continue using the legacy channel until that migration.

Most errors remain prefixed strings (`cli_missing:`, `hwp_timeout:`,
`hwp_failed:`, `hwp_parse_failed:`, `hwped_bad_request:`), matching the `gws`
convention. Feature-version refusals from JSON edit or explicitly requested
layout use the structured IPC error shape so callers can branch on the code;
the message includes the detected version, required minimum, and upgrade action.

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

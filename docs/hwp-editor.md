# hwp-editor integration (hwped_*)

Maru hosts the [hwp-editor](https://github.com/STAIxBWLB/hwp-editor) engine
bridge: six Tauri commands (`src-tauri/src/hwped.rs`) that spawn the HWP engine
([agent-hwp](https://github.com/STAIxBWLB/agent-hwp) >= 0.8.7, formerly hwp-cli)
behind the editor's `HwpEngine` contract. Maru looks for the engine's own name
`ahwp` first and falls back to `hwp`, the compatibility name every 1.x release
still ships; `MARU_HWP_BIN` overrides both. This is a
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
| `hwped_read` | `hwp cat <in> --format markdown --with-segments`, then `hwp info <in> --json --body-stats` | CatEnvelope JSON, plus `bodyTables?` |
| `hwped_render` | `hwp render <in> -o page.<fmt> --format --pages --dpi --report [--layout-json <file>]` | `{ pages: [{ page, width, height, dpi, format, dataBase64, layout? }], notes?: [{ code, message }] }` |
| `hwped_edit` | `hwp edit <in> -o <out> (--ops <file> or <opsArgv...>) [--verify] [--allow-partial]` | `{ name, dataBase64 }` |
| `hwped_compose` | `hwp compose <spec.json> -o <out> --report` | `{ name, dataBase64, report? }` |
| `hwped_validate` | `hwp validate <in> --json` (exit 1 = invalid, report still parsed) | `{ valid, errors }` |
| `hwped_capabilities` | `hwp --version` (enforces >= 0.8.7, memoized) | `{ version, editable, formats, editOps?: "v1" }` |

Documents cross the bridge as `HwpedDocumentRef`: a workspace `path`
(relative paths are resolved against `workspaceRoot` with an escape guard)
when the bytes are already on disk, `dataBase64` otherwise.

`hwped_read` also reports `bodyTables`, the engine's own table count from
`hwp info --json --body-stats` on the same staged file. It counts tables the
segment envelope publishes no segment for — a table inside a note, header,
footer or hidden comment — which is the disagreement hwp-editor's table-index
guard refuses index-addressed table ops over (`CatEnvelope.bodyTables`). The
extra call never fails the read: it is not made below hwp-cli 0.19.2, and a
failed body walk or a missing `body.tables` returns the envelope without the
field, leaving the guard off exactly as before.

`hwped_edit` takes exactly one of `ops` and `opsArgv`. The JSON `ops` channel
accepts a flat `edit-ops-v1` array, writes it to an isolated per-call `ops.json`,
and invokes `hwp edit --ops`; this channel requires hwp-cli 0.20.0 or newer.
Rust checks only the array envelope; the engine owns the operation grammar. Run
addresses and half-open source WCHAR/UTF-16 `chars` ranges pass through unchanged
and are never converted to text selectors. The JSON channel's `insert_image` and
`seal` ops get the same asset containment as the legacy channel's flags, applied
to every op before the ops file is staged: `workspaceRoot` is required, the path
resolves inside it, its canonical file (symlink targets included) stays inside,
and it is a regular file; the op's `path` is then rewritten to that absolute
path, with the anchor and dimension keys untouched. A non-string `path` is
refused, and a missing one is left to the engine's schema. Because the rewrite
is absolute, a relative asset path never depends on where the temporary ops file
sits. `apply_form_bindings` is refused on this channel instead of contained: it
writes its receipt and preview files outside the editor's workspace contract, so
form bindings run through the `ahwp edit` CLI flow.
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

`src/lib/hwped.ts` holds one factory over the published package and no wire
types of its own:

```ts
import { createHwpedEngine } from "./lib/hwped";

const engine = createHwpedEngine({
  workspaceRoot,
  pathOf: (doc) => /* workspace-relative path when on disk */,
});
```

`pathOf` answers only for the handle the surface opened. An edit comes back from
the host as a new handle carrying the edited bytes, so a rule that matched
edited handles by name would send them back as paths: the next read and the next
apply would start from the untouched file on disk, the page would repaint
unchanged and the first edit would be lost. Mount it by identity
(`document === file`), never by name.

`@hwp-editor/core` and `@hwp-editor/react` are pinned at exactly `1.3.0`. The
engine asks `hwped_capabilities` before an edit and sends the `edit-ops-v1` JSON
array when this host advertises `editOps: "v1"`, which it does; the `opsArgv`
fallback for older hosts lives inside the package, so this repository carries no
dual channel.

The editor mounts through the `.hwpx` surface: `BinaryViewerPane` renders
`HwpxEditorPane`, which shows the read-only preview by default and loads
`HwpEditor` (its own chunk) only when the reader asks for it. Once opened the
editor stays mounted behind the preview, so switching back does not drop an
in-memory edit, and above the preview's own inline bound (`INLINE_HWPX_MAX_BYTES`)
the surface offers no editor at all. `locale` follows maru's UI locale, and the
host element maps maru's tokens onto the editor's `--hwped-*` contract.

Rendered pages are sanitized on the way out of the host. The package paints each
SVG page with `dangerouslySetInnerHTML` behind its own blocklist sanitizer, which
removes `script`/`foreignObject`, `on*` attributes and `javascript:` hrefs but
not SMIL `<set>`/`<animate>`, parser-decoded schemes, or external `data:` and
`url()` references. That sink also sits in the main webview next to Tauri IPC,
over bytes from a document that may come from anywhere. `src/lib/hwped.ts`
therefore wraps `render` and passes every `format: "svg"` page through
`src/lib/hwpedSvg.ts` (DOMPurify's SVG profile, then the href and paint-attribute
scrub it leaves undone) before the package holds the bytes; raster pages pass
through untouched. `check-dom-sanitizer` cannot see this sink, because it lives
in `node_modules`, which is why the wrap is tested in `src/lib/hwped.test.ts`.

Edits stay in memory. Maru has no command that writes an edited document back to
a workspace path, so the surface says so instead of offering a save; giving it
one means a managed write (validate, snapshot, revision-checked atomic replace)
rather than a plain file overwrite.

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
This CLI/MockRuntime evidence does not establish WKWebView or Korean IME
behavior; the native spec below is what covers WKWebView.

The real-app surface is covered by `e2e-native/specs/hwpx-editor.spec.ts`, which
runs in the macOS native-e2e job (the job installs the engine from the
`staixbwlb/hwp` tap first). It opens a seeded copy of
`src-tauri/testdata/hwp-cli-plan-template.hwpx` in the built app, asserts the
read-only preview comes first, proves the painted page is the sanitizer's output
for the engine's page, queues two edits through the editor's own controls, and
requires each apply to change what is painted and listed before the next one
starts. An apply that re-read the file on disk would clear the pending queue and
repaint the original instead. It finally requires the `.hwpx` on disk to be
unchanged.

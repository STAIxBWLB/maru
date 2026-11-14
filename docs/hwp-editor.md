# hwp-editor integration (hwped_*)

Maru hosts the [hwp-editor](https://github.com/STAIxBWLB/hwp-editor) engine
bridge: seven Tauri commands (`src-tauri/src/hwped.rs`) that spawn the HWP engine
([agent-hwp](https://github.com/STAIxBWLB/agent-hwp) >= 0.8.7, formerly hwp-cli)
behind the editor's `HwpEngine` contract. Maru looks for the engine's own name
`ahwp` first and falls back to `hwp`, the compatibility name every 1.x release
still ships; `MARU_HWP_BIN` overrides both. The Rust channel is the backend of the
editor surface; the published engine is mounted in the reader's view (§Frontend).

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
| `hwped_read` | `hwp cat <in> --format markdown --with-segments`, then `hwp info <in> --json --body-stats` | CatEnvelope JSON, plus `bodyTables?`; opt-in `captureSource` adds `source: { dataBase64, revision }` from the same immutable copy |
| `hwped_save` | Private candidate validation and re-read, guarded workspace replacement | `{ revision, sizeBytes, snapshotPath }` |
| `hwped_render` | `hwp render <in> -o page.<fmt> --format --pages --dpi --report [--layout-json <file>]` | `{ pages: [{ page, width, height, dpi, format, dataBase64, layout? }], notes?: [{ code, message }] }` |
| `hwped_edit` | `hwp edit <in> -o <out> (--ops <file> or <opsArgv...>) [--verify] [--allow-partial] [--report <file>]` (`--report` on ahwp >= 1.6.3) | `{ name, dataBase64 }` |
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

The Rust channel and capability are the first half of
[#563](https://github.com/STAIxBWLB/maru/issues/563); the second half is the
frontend (published `createTauriEngine`, the editor mount and the theme-token
mapping), which landed in #609 (§Frontend). No maru code sends `opsArgv` itself
any more: that fallback lives inside the package, and `src/lib/hwped.test.ts`
exercises both columns of it.

Most errors remain prefixed strings (`cli_missing:`, `hwp_timeout:`,
`hwp_failed:`, `hwp_parse_failed:`, `hwped_bad_request:`), matching the `gws`
convention. Feature-version refusals from JSON edit or explicitly requested
layout use the structured IPC error shape so callers can branch on the code;
the message includes the detected version, required minimum, and upgrade action.

**Refused edits (maru#620).** On ahwp >= 1.6.3, `hwped_edit` passes
`--report <stage>/edit-report.json` on every call and reads the report before
the stage dir is removed. The version parser takes plain `X.Y.Z` only, so a
prerelease or build-tagged engine (`1.6.3-rc.1`, `1.6.3+build`) gets no
`--report` and keeps the string error.

A refused run (`hwp_failed:`) with a readable report rejects with the object
hwp-editor's Tauri client reads, `{ code: "failed", message, report,
engineVersion }`, **only when the call carries `structuredRefusal: true`**.
That argument is the client's capability signal that it reads refused edit
reports. It is deliberately not `report: true`: released @hwp-editor/core 1.4.x
already sends `report` for preset batches and block inserts, and its object
branch skips the string classifier, so keying on `report` would cost today's
client its localised refusal classification. hwp-editor's Tauri client must
send `structuredRefusal: true` on edits for this path to apply; until it does,
maru keeps the string error. `message` is always the unchanged legacy string
(including `[work dir <json>]`).

Before it leaves the host, the report is sanitized as hwp-editor's server does:
`output` becomes the caller's document name, and every other string, at any
depth and in unknown fields too, has the stage dir replaced with `<work dir>`
and any absolute path (POSIX, Windows drive, UNC, `file://`) replaced with
`<path>` (`src-tauri/src/hwped/report_paths.rs`, held to upstream
`withoutPaths` by a recorded parity test). Strings under identifier keys
(`anchor`, `style`, an issue's `path`) are user-valued and stay exact. The
report is read through one no-follow handle capped at 4 MiB.

Engines below 1.6.3, a missing, oversized or unparsable report, non-refusal
failures (spawn, timeout, output limit) and calls without `structuredRefusal`
keep the string error, and hwp-editor falls back to stderr classification.

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

`src/lib/hwped.ts` holds the published engine factory. Host capture/save
transport lives in `src/lib/hwpedPersistence.ts` so the core stays lazy:

```ts
import { createHwpedEngine } from "./lib/hwped";

const engine = createHwpedEngine({
  workspaceRoot,
  pathOf: () => undefined, // this editor session uses captured in-memory bytes
});
```

The host opens through `hwped_read` with `captureSource: true`, receiving a
real `DocumentHandle` plus the disk revision from the same bounded immutable
source copy. Every handle, including edited and undo handles sharing the source
name, uses bytes: `pathOf` always returns undefined in this session. Reload uses
the same capture flow. The selected workspace entry supplies the save path;
the engine-returned document name never selects a destination.

`@hwp-editor/core` and `@hwp-editor/react` are pinned at exactly `1.4.0`. The
engine asks `hwped_capabilities` before an edit and sends the `edit-ops-v1` JSON
array when this host advertises `editOps: "v1"`, which it does; the `opsArgv`
fallback for older hosts lives inside the package, so this repository carries no
dual channel.

1.4.0 changed how a page reaches the screen, not the engine contract:
`createTauriEngine`, `HwpEngine`, `DocumentHandle` and `PageImage` typecheck the
same, so the package surface is the pin plus a lockfile regeneration. A page is
now an `<img>` whose source is `data:image/svg+xml;base64,…`
(hwp-editor#161), where 1.3.0 wrote the markup into the element with
`dangerouslySetInnerHTML`; the package's `sanitizeSvg` is still exported and
deprecated. Maru's CSP already allows the new source (`img-src 'self' data:
blob: asset: http://asset.localhost` in `src-tauri/tauri.conf.json`), so the
upgrade moved no configuration. What did move is the one place that read a page
off the DOM: `e2e-native/specs/hwpx-editor.spec.ts` decodes that source and reads
it only once the image has decoded, which is how the painted page's geometry is
still compared with the page the engine rendered. A source the CSP blocked or
that failed to decode keeps an element and a box of its own, so the source alone
would pass for a painted page.

The editor mounts through the `.hwpx` surface: `BinaryViewerPane` renders
`HwpxEditorPane`, which shows the read-only preview by default and loads
`HwpEditor` (its own chunk) only when the reader asks for it. Once opened the
editor stays mounted behind the preview, so switching back does not drop an
in-memory edit. The editor admits at most 32 MiB independently of the read-only
preview's existing inline bound (`INLINE_HWPX_MAX_BYTES`). `locale` follows maru's UI locale, and the
host element maps maru's tokens onto the editor's `--hwped-*` contract.

Rendered pages are sanitized on the way out of the host. `src/lib/hwped.ts`
wraps `render` and passes every `format: "svg"` page through
`src/lib/hwpedSvg.ts` (DOMPurify's SVG profile, then the href and paint-attribute
scrub it leaves undone) before the package holds the bytes; raster pages pass
through untouched.

That pass used to be the guard in front of a live sink, and since 1.4.0 it is
defence in depth. In 1.3.0 the package wrote each page into the element with
`dangerouslySetInnerHTML` in the main webview next to Tauri IPC, behind its own
blocklist `sanitizeSvg`, which removes `script`/`foreignObject`, `on*` attributes
and `javascript:` hrefs but not SMIL `<set>`/`<animate>`, parser-decoded schemes,
or external `data:` and `url()` references. Now the markup only ever reaches an
`<img>` source, a separate document in which scripts and external references do
not run, so the page can no longer reach the host either way.

The wrap is kept, and the reason is not "a sink is still there". It is the one
point in this path maru controls: it bounds what a page may reference whatever
the renderer does next, the packages are pinned exactly so a change of rendering
mode arrives only with a deliberate upgrade, and retiring it would first rework
the native probe (`hwpedRenderProbe`, which compares the wrapped render with the
package's own) and the WKWebView assertions built on it. `check-dom-sanitizer`
scans maru's own sinks and cannot see one inside `node_modules`, which is why the
wrap is tested in `src/lib/hwped.test.ts`, including that an `<img>` page keeps
the root `width`/`height`/`viewBox` its intrinsic size comes from.

## Explicit workspace save

`hwped_save(workspaceRoot, documentPath, dataBase64, expectedRevision)` replaces
only an existing regular `.hwpx`. Its response is `{ revision, sizeBytes,
snapshotPath }`, with a workspace-relative recovery path. The required revision
is lowercase SHA-256 of the exact opened bytes. There is no unconditional
write, autosave, Save As, new-document destination, native `.hwp` write, or
filesystem policy added to the published engine.

Rust admits the complete lexical/physical source aliases, `.maru/versions`,
registry and parent identity before effects, and rechecks owner and write policy
inside that lease. Both original and candidate are bounded at 32 MiB; base64
is bounded at 44,739,244 ASCII bytes before decoding. The selected engine must
validate the staged candidate as HWPX and successfully re-read its envelope.
Missing engines, timeouts, malformed reports, native HWP disguised as HWPX and
read failures refuse before snapshots or replacement. Binary bytes do not enter
frontmatter APIs; the normalized `.hwpx` path still passes managed-write policy.

Every successful overwrite first publishes a private, byte-exact original
snapshot in `.maru/versions/<timestamp>-<uuid>.hwpx`, including ordinary writable
workspaces. Candidate replacement preserves destination permissions, stages and
syncs in the destination directory, then rechecks aliases, pinned parents,
policy and expected revision immediately before rename. File and directory
symlinks retain their entries. A failed replacement preserves the source and
may retain a completed recovery snapshot. No fallible disk read follows commit.
Cooperating in-process aliases serialize; external writers do not participate in
an atomic cross-process compare-and-swap.

The host tracks pending operations separately from current applied bytes and
the persisted baseline. Apply clears pending operations but does not clear
unsaved disk changes; undo to the exact baseline does. Save is enabled only for
a modified, loaded, writable session with no pending operations or engine/save
activity. It never silently applies operations. Composition and new-document
origins cannot overwrite the selected file.

Save captures bytes, revision and session generation and disables mutations
until completion. Only that session's baseline advances on success; preview and
file metadata refresh afterwards. Errors retain edits and baseline. A structured
`document_conflict` offers Keep editing or Reload from disk, with explicit
confirmation before discarding edits. Unknown IPC codes stay plain errors.
Closing the editor, changing file/workspace or closing the window prompts before
discard; navigation waits for a permitted Save to succeed. Focused Save routes
to this host without also invoking text-document saving. All host statuses and
recovery controls use ko/en strings and accessible announcements.

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
repaint the original instead. Before explicit Save, disk bytes remain unchanged.
It then saves Korean/English changes, verifies the exact recovery snapshot,
reopens and re-reads the file, exercises external-modification conflict and
confirmed reload, and blocks the snapshot directory to verify failed-save edit
retention. Its successful artifact records app/package/engine versions.
Korean text insertion through test controls does not establish Korean IME input;
IME remains UNVERIFIED unless separately exercised in the real app.

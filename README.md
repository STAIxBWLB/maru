# Maru

Local-first AI workspace desktop app for Korean knowledge/document operations.
Tauri 2 + Rust + React 19 + TypeScript. Current version **0.4.0**.

Maru is the author SSOT for a single user's `~/workspace/work/` — it edits
markdown with byte-identical frontmatter, ingests an inbox, runs bundled Claude
Code skills, drives Korean document (HWPX/DOCX/PDF) operations, and visualizes
the vault as a knowledge graph. Releases before v0.3.0 shipped under the name
**Anchor**; the M0 rename (`kr.maru.desktop`, `~/.maru/`) landed in v0.3.0.

## Status (2026-07-11)

| Phase | State | Outcome |
|-------|-------|---------|
| 0 — Hardening | ✅ shipped | Open existing workspaces safely. Frontmatter byte-identical round-trip. Multi-workspace registry. ko/en parity. |
| 0.5 — UI polish | ✅ shipped | Topbar, sidebar with type filters + recents, command palette (⌘K), Pretendard Korean typography, light/dark. |
| 1A — Killer feature MVP | ✅ shipped | Doc-selection reliability, frontmatter inline edit (InspectorPane), wikilink autocomplete (Korean IME-aware) + click-to-navigate, typed neighborhood pane, in-memory nav history (⌘[ / ⌘]). |
| 1B — Rich editor / git | ✅ feature-complete | Git status badge + commit-from-app (file list + per-file diff + syntax color). Rayon-parallel workspace scan + cache-backed warm startup. Multi-tab editor (⌘1..⌘8 / ⌘W, dirty stash). BlockNote rich + source + preview 3-way toggle. Browser smoke e2e. **Deferred**: monorepo extraction. |
| 2 — Inbox + AI | ✅ write loop live | Polling scan + notify watcher + Korean date parser + Claude CLI bridge + classifier + Gmail via `gws`, plus `InboxPane` (classify/accept/reject/process, approval gate, Maru labels, `a`/`r`/`p`, bulk actions, mission log tails). |
| 2.5 — Tree + Cursor shell + Terminal | ✅ shipped | Documents/Files Explorer, VS Code-style file tree + copy/move queue, Cursor-style activity rail, split panes (⌘D), Rust-native `alacritty_terminal` PTY tabs (Claude/Codex/Shell), layered `~/.maru/settings.json` + `<workspace>/.maru/workspace-state.json`, signed auto-update, native menu bar. |
| 3 — Unified document ops (M1–M7) | ✅ W1–W6 + skills SSOT | Operations Catalog mode (`ops_catalog::scan`, fs watcher, Hub HTTP read + ETag/offline fallback, drilldown + Reveal), Hub Library client + template-aware new doc, Writing Guideline sidebar. Rust `skill_host` owns tiers (core/public/private/imported/managed), doctor validation, dirty/reconcile. maru-hub backs shared catalog (REST + Alembic + seeds). |
| 4 — Document Studio + Templates | ✅ W7–W12 | 7-step `Studio` mode (source → template → guideline → sections → HWP fields → export → package). `create_document` frontmatter prefill, M4 export pipeline (`export/` plan/validate/dispatch, docx/hwpx/pdf + sha256 manifest), HWPX field map (`hwpx slots` + `template_fill`), 개조식 inline lint (`linter/gaejosik`). |
| 5 — Evidence Binder | ✅ W13 shipped | Right-pane Evidence Binder tab keyed by doc id, state under `<workspace>/.maru/binder/<doc-id>.json`, seeds from inbox-processed files + `<binary>.evidence.yaml` sidecars scoped to the active BU, `kordoc_lite` format detection + HWPX field previews. W14–W18 (section/KPI/checklist bindings + Deck Studio) planned. |
| D — Concept-map Diagram mode | ✅ shipped (Phase 0–7, hardened) + Report Pattern Studio (v8) | `diagram` mode: HWP-style 9-tab ribbon, 13 node kinds, 4-port edges, smart-guide snap, 11 templates, version history, viewport culling for 1000-node smoothness. Report Pattern Studio: v8 schema (report datasets + pattern views, one-time v7 backup at `.maru/diagrams/backups/`), typed table editing, pattern gallery + conversion preview, codec-registry import/export (lossless/structural/visual), and "Insert/Update in report" — managed `maru-diagram:v1` Markdown blocks with rendered assets at `attachments/diagrams/<docId>/`. Storage: `diagrams/*.cmd.json`, `.maru/diagram-patterns/`. New commands: `diagram_backup_document`, `diagram_pattern_save/list/delete`, `diagram_write_report_asset`. See [docs/diagram.md](docs/diagram.md). |
| 8 — Knowledge graph | ✅ 8a/8b/8c + V5 shipped | `graph` mode: stable Sigma WebGL + Graphology multi-directed model, Barnes-Hut ForceAtlas2 worker, visibility reducers, 10k+ node target, vault/workspace sources, local depth/direction controls, background insights, reviewed relationship writes, incremental cache/watch refresh. V5: adaptive workspace tiers (docked/overlay panels), per-source filter profiles + display settings (arrows/labels/scales), single derive pipeline (relation filters, min-visible-neighbors k-core, paused filters), renderer state machine with GPU-recovery/fatal handling, real-Sigma e2e bridge. Managed writes remain schema-gated, revision-checked, snapshotted, and atomic. See [docs/graph.md](docs/graph.md). |
| M0 — Anchor → Maru rename | ✅ shipped (v0.3.0) | Full rename across app id, dirs, CLI, tap. One-time on-disk migration (`~/.anchor → ~/.maru`, `com.anchor.app → com.maru.app`) with back-compat symlink; `.maruignore` preferred with `.anchorignore` fallback read. |

Rule SSOTs live in the work repo at
`~/workspace/work/_meta/rules/{frontmatter-schema,document-lifecycle,hub-contract,evidence-policy}.md`.
The deeper "what's next + how to continue" reference is [ROADMAP.md](ROADMAP.md).

## Modes

The activity rail exposes eleven top-level modes (Settings opens as a separate
window, so it is not an app mode). Diagram and Graph default on; E2E Flow is
flag-gated.

| Mode | Label (ko / en) | What it does |
|------|-----------------|--------------|
| `pkm` | 문서 / Docs | Default. Markdown editor + Documents/Files Explorer + right utility rail. |
| `inbox` | 인박스 / Inbox | Configured drop / pending / processed / Files / Gmail sections with classify + `a`/`r`/`p`. |
| `comms` | 메시지 / Messages | Multichannel comms settings (Telegram auth/mapping, source config, macOS migration). |
| `meetings` | 회의록 / Meetings | Transcript + auto-summary intake and the meeting-notes review workbench. |
| `tasks` | 태스크 / Tasks | File-backed tasks with Google Tasks/Calendar links; edit details, month/week/day calendar. |
| `catalog` | 카탈로그 / Catalog | M1 Operations Catalog — deadlines, in-flight approvals, unlinked evidence, inbox pending. |
| `studio` | 스튜디오 / Studio | M2 Document Studio 7-step authoring wizard. See [docs/studio.md](docs/studio.md). |
| `diagram` | 다이어그램 / Diagram | Concept-map editor. See [docs/diagram.md](docs/diagram.md). |
| `graph` | 그래프 / Graph | Vault knowledge graph. See [docs/graph.md](docs/graph.md). |
| `sites` | 사이트 / Sites | Left-rail site switcher with an embedded native browser pane. |
| `e2e` | E2E 플로우 / E2E Flow | Hidden end-to-end flow console (flag-gated `e2eFlowEnabled`). |

## HTML editing

`.html` and `.htm` documents open in the document editor with three modes
(Markdown files keep their own rich/source/preview modes and saved
preference):

- **Visual** (default) — sandboxed WYSIWYG editing with a formatting toolbar
  (undo/redo, paragraph/heading styles, bold/italic/underline/strike, lists,
  link/unlink, clear formatting).
- **Source** — lossless raw HTML editing.
- **Preview** — sandboxed, read-only rendering.

Preservation guarantees and limits:

- YAML frontmatter, the doctype, `<html>`, `<head>` (including styles and
  scripts), `<body>` attributes, and the surrounding document shell are
  preserved byte-for-byte. After an actual Visual edit, only the body
  contents may receive browser HTML normalization; when Visual mode is
  opened without editing, the source stays byte-identical.
- HTML fragments edit as fragments. Full documents whose `<body>` boundary
  cannot be parsed disable Visual mode with a direct Source-mode action.
- Visual mode is limited to documents up to 2 MiB (UTF-8) or 20,000 DOM
  nodes; larger documents fall back to Source and Preview.

Sandbox behavior:

- Scripts, inline event handlers, meta refresh, nested frames, and forms are
  preserved in the source but never executed: the editing/preview surface is
  a runtime-only iframe clone that strips them and injects a
  Content-Security-Policy blocking scripts, connections, workers, objects,
  frames, form submission, and remote resources. Runtime safety markup and
  rewritten asset URLs are never serialized back to the file.
- Documents containing scripts, event handlers, custom elements, forms, or
  embedded content require a one-time confirmation (per tab and current
  source digest) before Visual editing; source edits and external revisions
  re-arm the confirmation.

Local assets:

- Relative asset URLs (CSS, images, fonts, media), `data:`, and `blob:` URLs
  load through the Tauri asset protocol, authorized read-only and scoped to
  the document's own directory inside the owning registered workspace
  (`prepare_html_editor_assets`). Network resources and paths escaping the
  workspace are blocked.
- File operations (rename/move, duplicate, trash, manual and automatic
  snapshots) preserve the original HTML extension, including case, and the
  vault scanner/watcher recognize HTML extensions case-insensitively.

## Install

Maru ships the desktop app and CLI as separate artifacts. On macOS, both are
distributed through the `STAIxBWLB/homebrew-cask` tap:

```bash
brew tap STAIxBWLB/homebrew-cask

# Desktop app only:
brew install --cask maru-workspace

# Standalone CLI only. Installs the executable as `maru`:
brew install maru-cli

maru --version
```

The app cask installs `Maru.app` and does not create a CLI symlink. The CLI
formula installs only the standalone `maru` executable. The desktop app keeps
using signed Tauri updater metadata from GitHub Releases; Homebrew users can
also upgrade via `brew upgrade --cask maru-workspace` and `brew upgrade maru-cli`.

For repo-local management shortcuts:

```bash
make cli-install
make cli-smoke
make release-preflight
make homebrew-update RELEASE_TAG=v0.4.0 HOMEBREW_TAP_DIR=../homebrew-cask
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Tauri Webview (src/)                                        │
│   React 19 + Radix UI + BlockNote + marked + DOMPurify       │
│   Sigma WebGL + Graphology · CodeMirror · alacritty canvas    │
│                                                               │
│   Activity rail (11 modes):                                  │
│     Docs / Inbox / Messages / Meetings / Tasks /             │
│     Catalog / Studio / Diagram / Graph / Sites / E2E         │
│   Explorer + editor tabs + copy/move queue + terminal panel   │
└──────────────────────────────┬──────────────────────────────┘
                               │ Tauri IPC
┌──────────────────────────────▼──────────────────────────────┐
│  Rust core (src-tauri/src/)                                  │
│   workspace scan — walkdir + .maruignore + cached index      │
│   frontmatter/   — line-by-line YAML edit (preserves order)  │
│   document.rs    — read/save/create/version + field patch    │
│   git.rs         — status/commit/diff via shell-out          │
│   vault_list.rs / vault.rs / vault_graph.rs / vault_guard.rs │
│   inbox.rs / inbox_watcher.rs / inbox_classifier.rs          │
│   gmail_gws.rs / outlook_mso.rs / telegram_io.rs / ai_router │
│   ops_catalog/ · hub_client/ · export/ · studio/ · diagram/  │
│   skill_host/ · agent_host/ · terminal/ · linter/            │
│   maru_dir.rs   — layered settings + .maru rules/templates   │
│   maru_migration.rs — one-time Anchor → Maru on-disk rename  │
└──────┬─────────────────────────────────────────────────────┘
       │ stdio bridge
┌──────▼────────┐ ┌────────────────────┐
│ MCP server    │ │ User's Claude Code │
│ (Node sidecar) │ │ CLI (~/.maru/skills)│
└───────────────┘ └────────────────────┘
```

**Module boundary rules**:
- Rust core **owns** workspace FS / cache / git / frontmatter / inbox
  scan/watch/classification / Gmail `gws` + Outlook + Telegram bridges / layered
  Maru settings / Claude inbox subprocess / integrated terminal PTY + screen
  model / skills registry (`skill_host`) / agent proposal host (`agent_host`) /
  ops catalog / export pipeline / Studio + Diagram + Graph backends.
- React handles **only** BlockNote / command palette / neighborhood / graph
  layout worker / diagram canvas. No business logic.
- Node sidecar (`sidecars/maru-mcp/`) holds the local read-first MCP server.
- **Deferred (Phase 4 original plan, on hold)**: a Whisper (Korean large-v3)
  Python sidecar + MediaPipe voice/gesture editing. Not shipped — Phase 4 was
  repurposed to Document Studio. Voice/gesture remains a future track.

### Integrated terminal reliability contract

- The terminal panel mounts eagerly and keeps its textarea/canvas identity
  across collapse and tab switches. macOS first-mouse activation focuses a
  terminal in one click; activation clicks are not forwarded to a TUI, while
  Shift always forces local selection.
- Each PTY session streams ordered, generation-tagged frames through a Tauri
  Channel. The frontend acknowledges applied frames, the backend keeps at most
  two frames in flight, hidden sessions do not serialize or paint frames, and
  a sequence/dimension mismatch requests a full resync.
- Frames use a palette plus compact `[text,width,style]` cells. Release gates
  cap a 120x30 full frame at 100 KiB and a dirty-row patch at 4 KiB.
- The Rust Alacritty model owns selection and copy semantics, including
  scrollback coordinates, soft wraps, wide CJK cells, resize reflow, semantic
  word selection, and line selection. The canvas keeps an optimistic drag
  overlay for immediate feedback.
- Frontend input is queued before spawn, microtask-batched, and sent in strict
  order. Normal key/text/paste delivery reads mirrored terminal modes without
  contending with the output parser's screen-model lock.

## Phase 3 verification gates (passed)

1. **Catalog watcher + auto-refresh** — notify recursively watches `inbox/items/`, `tasks/{active,calendar}`, every BU's `02-admin-approvals/` + `03-evidence-cert/` + `.maru/bu-config.yaml`; bursts are debounced 500 ms and the React pane re-queries in another 300 ms.
2. **Hub catalog read path** — `hub_client::http::fetch_with_cache` GETs `/api/v1/{templates,guidelines,glossary,...}` with ETag revalidation, falls back to `<workspace>/.maru/cache/hub/` on any network error.
3. **Drilldown dialog + Reveal** — Catalog row → modal showing frontmatter + manifest + README excerpt + sibling paths + "Finder에서 보기".
4. **Real-workspace timing** — `MARU_CATALOG_BENCH_WORKSPACE=~/workspace/work cargo test --lib -- --ignored catalog_real_workspace_smoke` indexed 110 entries across 4 BUs in 986 ms (30× under the 30-second budget).
5. **Template-aware new doc** — `⌘ ⇧ N` / palette "Hub 템플릿으로 새 문서" → BU/category filter → template picker prefills body + title + docType → optional guideline multi-select → `maru:template` / `maru:business_unit` / `maru:guidelines` provenance.
6. **Guideline sidebar** — opening a doc created via the template flow surfaces its guideline bodies in the right-pane `BookOpen` tab.

### Live-Hub verification (operator procedure)

The above gates run fully offline (cache fallback). To exercise the live Hub read path:

```bash
# maru-hub: start FastAPI + sqlite (or run docker compose up -d db for Postgres)
cd dev/maru-hub
uv run python -m scripts.seed_catalog
MARU_HUB_DATABASE_URL=sqlite:///tmp/maru-hub.db uv run uvicorn maru_hub.main:app --port 8017

# maru: flip workspace.config.yaml
#   hub.enabled: true
#   hub.endpoint: http://127.0.0.1:8017/api/v1
#   hub.api_token_ref: ~/workspace/work/.maru/secrets/hub-token (empty file is fine for local)
```

Then in Maru: open Catalog mode → footer "마지막 스캔" populates; ⌘ ⇧ N → toggle "Hub 템플릿에서 시작" → templates load from Hub; pick `business-plan-default` → body prefills with slot hints.

After Phase 6 W21 ships, the same operator procedure will also exercise the `POST /api/v1/documents/{id}/finalize` round-trip — Maru pushes the approved markdown body + rendered artifacts + linked evidence binaries to Hub, and the document then appears under the Hub Finalized tab inside Catalog mode.

## Roadmap

The active plan lives in [ROADMAP.md](ROADMAP.md) — a 7-module (M1–M7)
decomposition with weekly deliverables (W1–W34+) plus the Diagram and Graph side
tracks. Phases 0–5, the Diagram mode, and the Phase 8 graph mode (8a/8b/8c) are
shipped. See [CHANGELOG.md](CHANGELOG.md) for the release-by-release history.

Each phase is defined in **outcomes the user actually exercises**. No phase
exists just to grow infrastructure. The entry gate for each phase is the
verification of the previous one.

### Next up

Git has run ahead of the linear W-plan: Phase 8 (graph mode) shipped before the
remaining Phase 5 evidence work. The nearest pending items:

1. **W14–W15 Evidence bindings** — section/KPI/submission-checklist binding model on the W13 Binder (`evidence_links[].section_bindings`, `kpi_bindings`, checklist bindings), Verify / Mark-as-submitted controls, then Hub `evidence_index` sha256 reuse. Entry files: `src-tauri/src/evidence_binder.rs`, `src/components/evidence/*`, `src/lib/evidenceBinder.ts`.
2. **W16–W18 Deck Studio (M6)** — a `Decks` mode wrapping the gpt-images-deck wizard with the bundled 14-style catalog (`skills/docs/slide-decks/`).
3. **Phase 6 (W19–W22) Approval + Finalize-to-Hub** — submission gates, gate-state polling, and the approval-gated `POST /api/v1/documents/{id}/finalize` write path (the only Maru client path allowed to carry body/binary payloads). Requires a matching `hub_client/safety.rs` pre-flight.
4. **Phase 7 (W23–W26) Certification & KPI bundle** — Hub-backed certification vault, KPI composer, and PDF bundle assembly.

## Hub as published-document SSOT

Maru stays the **author SSOT** — drafting and editing always happen under
`~/workspace/work/`. Maru Hub becomes the **published SSOT** the moment an
approval route closes. Two write paths land on Hub from Maru:

1. **`POST /api/v1/documents/sync`** (planned M7 caller) — drafting metadata only: `document_uri`, `body_sha256`, `frontmatter`, and the evidence link graph. **No body, no binary.** Used for cross-BU lookups and "이미 동기화된 초안" hints.
2. **`POST /api/v1/documents/{id}/finalize`** (Phase 6 W21) — approval-gated canonical push. The instant `submission_gate.state` flips to `approved`, Maru auto-calls finalize with the full markdown body, every rendered artifact in the M4 manifest (docx/hwpx/pdf), and the binary bytes of every evidence file linked via `frontmatter.evidence_links`. On `201`, the local frontmatter `status` flips to `archived-hub:<finalized_id>@v<N>`.

Gate submits made while the Hub is disabled or unreachable persist in
`<workspace>/.maru/queue/hub/` (one JSON per request) and drain FIFO via
the `hub_queue_drain` command — exposed in the Catalog footer as a queue
depth badge with a retry action.

## Development

```bash
pnpm install

# Browser dev (mocked Tauri):
pnpm dev

# Native Tauri dev (cleans stale local app bundles first):
pnpm tauri:dev

# Type check:
pnpm typecheck

# i18n lint (ko/en parity + hardcoded UI string scan; also in make verify):
pnpm lint:i18n

# Production build:
pnpm build

# Full verification (typecheck + vitest + cargo test --lib + build):
make verify

# Signed native release build:
make tauri-build

# Raw pnpm build still requires explicit updater signing env:
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/maru-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(cat ~/.tauri/maru-updater.key.password)"
pnpm tauri:build

# Prune oversized local Tauri debug artifacts (also runs from tauri:dev/build):
pnpm clean:tauri-debug
# Checks once every 24h and prunes src-tauri/target/debug when artifacts exceed 4GiB.

# Rust unit + integration tests (587 declarations; 2 ignored benchmarks):
cd src-tauri && cargo test
# or: make test-rust  (cargo test --lib)

# Frontend unit tests (vitest, 101 test files / 788 tests):
pnpm test
# End-to-end (Playwright, 9 specs):
pnpm test:e2e

# Local Maru MCP sidecar smoke:
MARU_MCP_WORKSPACE="$PWD" node sidecars/maru-mcp/index.mjs

# Skills registry doctor / reconcile:
cargo run --manifest-path src-tauri/Cargo.toml --bin maru-cli -- --version
cargo run --manifest-path src-tauri/Cargo.toml --bin maru-cli -- doctor --json
cargo run --manifest-path src-tauri/Cargo.toml --bin maru-cli -- skills dirty --json
cargo run --manifest-path src-tauri/Cargo.toml --bin maru-cli -- skills reconcile <name-or-id> --accept --dry-run
cargo run --manifest-path src-tauri/Cargo.toml --bin maru-cli -- skills import /path/to/skill --copy

# Bench workspace scan on a real workspace:
cd src-tauri && cargo test --release bench_scan_real_workspace \
    -- --ignored --nocapture --test-threads=1
# → MARU_BENCH_WORKSPACE=/some/path overrides the default ~/workspace/work
```

CI runs `make verify` (typecheck + vitest + cargo test --lib + build) on every
pull request and push to `main` via `.github/workflows/ci.yml`; pushes that
touch only `skills/**` run `make skills-verify` instead of the full app
toolchain. The heavier `release-preflight` (adds CLI + e2e + a debug Tauri
build) runs on version tags.

## Skills Bundle Channel (OTA)

Skills deploy independently of app releases. Merging `skills/**` changes to
`main` triggers `.github/workflows/release-skills.yml`: it verifies and
packages the tree (`make skills-verify` / `make skills-package`), signs the
zip and metadata with the Tauri updater key, and uploads immutable assets to
the fixed `skills-channel` prerelease. The app checks that channel at launch
and applies new bundles automatically when the local skills are clean and
runtime-compatible; `maru skills update --check|--apply [--repair-env]` and
the Skills UI cover manual flows. The binary embeds only a frozen
`src-tauri/skills-bootstrap/` snapshot as the offline first-run fallback, so
editing `skills/` requires no Rust rebuild.

## Release Bundles

Publishing a GitHub Release (a `v*` tag; the skills channel is excluded)
triggers `.github/workflows/release-bundles.yml`.
The workflow builds native Tauri bundles on macOS, Ubuntu, and Windows, then
uploads the generated `.app` / `.dmg`, `.deb` / `.rpm` / `.AppImage`, `.exe`,
and `.msi` assets to that same release. It also uploads signed updater
metadata consumed by the startup auto-updater and native `Check for Updates...`
menu action. A separate macOS CLI job builds `maru-cli`, packages it as a
tarball containing an `maru` executable, and uploads
`maru-cli_<version>_darwin_{aarch64,x86_64}.tar.gz` plus SHA256 files to the
same release.

macOS bundles must be code signed before publishing. Until Apple Developer ID
secrets are configured, Maru uses explicit ad-hoc bundle signing
(`bundle.macOS.signingIdentity = "-"`) so Apple Silicon downloads are not
shipped as unsigned/broken app bundles. For fully trusted Gatekeeper launches,
configure these GitHub Secrets and publish a new release:

- `APPLE_CERTIFICATE` — base64 encoded Developer ID Application `.p12`
- `APPLE_CERTIFICATE_PASSWORD`
- `KEYCHAIN_PASSWORD`
- `APPLE_API_ISSUER_ID`
- `APPLE_API_KEY_ID`
- `APPLE_API_KEY` — base64 encoded App Store Connect API `.p8`

The release workflow imports `APPLE_CERTIFICATE` only inside the macOS signing
prep step, and it sends Apple notarization env vars only to the Developer ID
build branch. It intentionally does not pass unset Apple secrets into
`tauri-apps/tauri-action`, because empty environment variables make Tauri try
to import or notarize with blank credentials.

Minimum Apple Developer setup for direct distribution:

1. In Apple Developer `Certificates, Identifiers & Profiles`, create only a
   `Developer ID Application` certificate. Maru does not need an Identifier
   or Provisioning Profile for the current direct-distribution path because it
   does not use iCloud, Push Notifications, App Groups, or another advanced
   entitlement that requires a Developer ID provisioning profile.
2. Install the downloaded `.cer` into Keychain Access, then export it with its
   private key as a password-protected `.p12`.
3. Encode the `.p12` and set the release secrets:

   ```bash
   tmp_cert_b64="$(mktemp)"
   openssl base64 -A -in DeveloperIDApplication.p12 -out "$tmp_cert_b64"
   gh secret set APPLE_CERTIFICATE --repo STAIxBWLB/maru --body-file "$tmp_cert_b64"
   rm "$tmp_cert_b64"

   gh secret set APPLE_CERTIFICATE_PASSWORD --repo STAIxBWLB/maru
   gh secret set KEYCHAIN_PASSWORD --repo STAIxBWLB/maru
   gh secret set APPLE_API_ISSUER_ID --repo STAIxBWLB/maru
   gh secret set APPLE_API_KEY_ID --repo STAIxBWLB/maru
   gh secret set APPLE_API_KEY --repo STAIxBWLB/maru
   ```

4. Confirm release readiness without printing secret values:

   ```bash
   make macos-distribution-check
   make macos-distribution-local-check
   ```

For a local notarization smoke test, keep Apple files under
`~/workspace/work/.maru/secrets/apple/`:

- `DeveloperIDApplication.p12`
- `AuthKey_<APPLE_API_KEY_ID>.p8`
- `certificate-password`
- `api-issuer-id`
- optional `api-key-id` (defaults to the `AuthKey_<id>.p8` filename)
- optional `keychain-password` (generated locally if missing)

Then run:

```bash
make macos-notarize-local TARGET=aarch64-apple-darwin
```

Keep the Tauri updater secrets (`TAURI_SIGNING_PRIVATE_KEY`,
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) in place; they sign updater metadata and
are separate from Apple Developer ID signing. The workflow fails on partial
Apple signing configuration instead of silently producing an unintended ad-hoc
macOS release.

Release asset versions come from the app metadata in `package.json`,
`src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`; keep those in sync
before tagging or publishing a release. After release assets exist, update the
Homebrew tap with:

```bash
make homebrew-update-commit RELEASE_TAG=v0.4.0 HOMEBREW_TAP_DIR=../homebrew-cask
make homebrew-audit HOMEBREW_TAP_DIR=../homebrew-cask
make homebrew-fetch HOMEBREW_TAP_DIR=../homebrew-cask
```

After downloading the release DMG, verify Gatekeeper-facing state on macOS:

```bash
xcrun stapler validate Maru_*.dmg
spctl -a -vv -t open --context context:primary-signature Maru_*.dmg
codesign --verify --deep --strict --verbose=4 /Applications/Maru.app
spctl -a -vv -t exec /Applications/Maru.app
```

## Workspace Layout

An AI workspace is any folder containing `.md` (or `.markdown`, `.html`, `.htm`) files.

### Scratchpad

The primary private workspace owns one Scratchpad root. `ideation/` and
`memos/` are durable, Git-tracked content; only `temp/` is disposable and
Git-ignored.

```text
<work>/scratchpad/
  ideation/{seeds,developing,proposals,_archive}/
  memos/
  temp/{claude,codex,kiro,kimi,runtime}/
```

`workspace.config.yaml` may set `paths.scratchpad` and the
`scratchpad.{ideation_subdir,memos_subdir,temp_subdir,editable_extensions,temp_stale_days,ideation_review_days,editable_max_bytes}`
policy. Maru exposes the resolved root as `MARU_SCRATCHPAD`, its disposable
subdirectory as `MARU_TEMP`, and places Claude runtime files below
`$MARU_TEMP/runtime/claude` through `CLAUDE_CODE_TMPDIR`.

Scratchpad edits support `.md`, `.markdown`, and `.txt`. Ideation files older
than the review threshold are flagged for review but never cleaned
automatically. Temp cleanup is an explicit, per-file system-Trash operation.
Legacy `.maru/memos` migration is also explicit and verifies each destination
before removing its source. The pane keeps recovery drafts locally when it
cannot flush safely and never mutates tracked files merely by opening.

Verify the frontend contract with `pnpm test`, `pnpm typecheck`,
`pnpm lint:i18n`, and `pnpm build`; Rust containment, revision, migration,
cleanup, and watcher behavior is covered by `cargo test --lib scratchpad`.

Private workspace is the required default. Public workspace is optional and means a provider-managed shared root, not internet publishing. V1 capability support is registry-only: Maru stores non-secret provider metadata in `workspaces.json`, maps a manually entered provider role to coarse capabilities, intersects that with a filesystem writability probe, and gates direct writes in the UI and Rust commands. OAuth, Microsoft Graph, Google Drive, and Nextcloud live API checks are deferred.

Supported public providers are Local, Google Drive, OneDrive, SharePoint, Nextcloud, Obsidian, and Unknown. `workspace.config.yaml` accepts:

```yaml
paths:
  private: ~/workspace/work
  public:
    - label: Team Drive
      path: ~/gdrive-workspace/work
      provider: googleDrive
      providerId: shared-drive-id
      writePolicy: direct
      role: contentManager
    - label: Reference Site
      path: ~/shared/reference
      provider: sharePoint
      writePolicy: readOnly
      role: Can view
```

Maru stores user/global preferences at:

```
~/.maru/
  settings.json    # UI/theme/layout/window/split/terminal/explorer/file-queue/AI defaults
```

Maru stores workspace-local state and resources at:

```
<workspace>/
  .maru/
    cache/           # disposable workspace index for warm startup
    workspace-state.json # collapsed folders, initialization flags, binary patterns, overrides
    versions/        # snapshots created via the "Version" button
    studio/          # per-document Studio wizard state
    binder/          # per-document Evidence Binder state
  .maruignore      # optional, gitignore-style segment patterns (falls back to legacy .anchorignore)
```

`<workspace>/.maru/settings.json` is a legacy migration input only. Maru reads
it when present to build effective settings, but new workspaces do not get that
file.

`.maruignore` example for the user's `~/workspace/work`:

```
node_modules
.venv
dist
build
target
.next
.turbo
.cache
.maru/cache
```

## Critical invariants

1. **Filesystem is authoritative.** The fingerprinted cache (`<workspace>/.maru/cache/workspace-index-v3.json`) is disposable. Warm reconciliation reuses unchanged entries and reparses changed files only; React state remains derived.
2. **Frontmatter key order + comments preserved.** A single-field patch must never disturb the order or comments of any other key (verified by cargo test). `src-tauri/src/frontmatter/ops.rs` is the only allowed write path.
3. **Crash-safe rename.** `.maru-rename-txn/` staging dir + recovery on the next workspace scan.
4. **Dynamic relationship detection.** Any frontmatter field containing `[[wikilink]]` is treated as a relationship. No hard-coded field lists.
5. **Symlinks inside the workspace are honored.** Deliberate user-created symlinks (e.g. `~/workspace/work/inbox/downloads → ~/gdrive-workspace/...`) are considered part of the workspace. Maru uses lexical containment, not `canonicalize()`.
6. **Managed vault writes are schema-gated + snapshotted.** `write_policy: "managed"` writes pass `vault_guard::validate_managed_write` and take a snapshot before mutation; note deletion stays MCP-only.

## Hard "No" list (v1)

Out of scope for v1 by explicit decision:

- Semantic / embedding search (keyword + wikilink + git-grep cover 10k notes).
- Cloud sync, maru account, default telemetry (opt-in only).
- Mobile (Tauri 2 mobile is unstable; Obsidian owns mobile for now).
- Public marketplace server (cloned sources carrying a `maru.source.json`
  manifest are schema-validated on install and rolled back on failure; the
  manifest `signed` flag is a metadata check, not cryptographic signature
  verification — no server, no moderation policy).
- iMessage / Slack ingestion (permission pain > value).
- Multi-user collab, CRDT, realtime (single user, single device, git for history).
- PDF annotation, OCR (file-extracted text is enough).
- Agent-autonomous edits as default behavior. Autonomy is staged behind disposable workspaces, protected writes, approval policy, and audit events.
- iCloud / Dropbox workspace awareness (user's responsibility).
- Unsigned / ad-hoc auto-updater feeds (updates are accepted only through signed GitHub Release artifacts).

## License

No license file is currently published. All rights reserved unless a license is added.

# Maru

Local-first AI workspace desktop app for Korean knowledge/document operations.
Tauri 2 + Rust + React 19 + TypeScript. The current version is defined by the
synced app manifests (`package.json`, `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml`, and `src-tauri/maru-cli/Cargo.toml`).

The current product release is **v1.1.3, Semantic Titles**. Releases
before v0.3.0 shipped under the name Anchor; v0.3.0 completed the application
identifier and on-disk migration to Maru.

## Current Status

| Area | State | Evidence |
|------|-------|----------|
| Product release | v1.1.3 | Signed desktop bundles and standalone CLI for macOS, Windows, and Linux |
| Planning milestone | v1.1 Felt Quality and Native Proof | Phases 6-11; phase 6 complete with 5 plans |
| Application shell | Complete | 18 lazy modes; `MainApp` held to 15 `useState` and 24 `useEffect` calls |
| Verification | Passing | Typecheck, ESLint, unit tests, Rust fmt/clippy, E2E, build, and bundle budgets |
| Typed IPC | ERR-06 closed | Every conflict-emitting command preserves `{ code, message }`; recursive source guard active |
| Active milestone | v1.1, planning phase 10 | Releases ship as 1.1.x while v1.1 is open |

The milestone archive, audit, retrospective, and summary live under
`.planning/milestones/`, `.planning/RETROSPECTIVE.md`, and
`.planning/reports/`.

## Core Principles

- **Filesystem authoritative:** notes, tasks, drafts, evidence, and diagrams
  remain usable without Maru. Caches are disposable.
- **Local-first writes:** ordinary editing happens inside user-owned workspace
  folders. Cloud or Hub writes require an explicit supported path and approval.
- **Byte-stable documents:** a frontmatter field edit preserves unrelated keys,
  comments, order, quoting, and document body bytes.
- **Fail-closed mutation:** revision checks, workspace ownership, write policy,
  path containment, and managed-write validation run again in Rust.
- **Inspectable automation:** AI work is suggestion-first. Protected writes use
  approval staging and durable audit events.
- **Korean document fidelity:** HWPX, DOCX, PDF, Korean filenames, Korean IME,
  and public-document writing workflows are first-class concerns.

Rule SSOTs for the working environment live at:

```text
~/workspace/work/_meta/rules/
  frontmatter-schema.md
  document-lifecycle.md
  hub-contract.md
  evidence-policy.md
```

## Work Surfaces

Settings opens as an overlay and is not counted as an app mode. Diagram and
Graph are enabled by default; E2E Flow is flag-gated.

| Mode | Korean label | Purpose |
|------|--------------|---------|
| `dashboard` | 대시보드 | Today, tasks, schedule, inbox, agents, drafts, git, recent documents, and sync status |
| `pkm` | 문서 | Markdown and HTML document tree, multi-tab editor, outline, references, and utility rail |
| `scratchpad` | 스크래치패드 | Durable memos and disposable result files with Rich, Source, and Preview editing |
| `files` | 파일 | Finder-style folders, direct children, previews, editing, and safe file operations |
| `inbox` | 인박스 | Drop, pending, processed, provider, classification, approval, and processing flows |
| `comms` | 메시지 | Telegram, Outlook/Microsoft 365, and provider readiness configuration |
| `meetings` | 회의록 | Transcript intake, summaries, meeting review, and follow-through |
| `today` | 오늘 | Prepare, execute, review, capacity, calendar selection, and explicit sync |
| `tasks` | 태스크 | File-backed task list, calendar, detail editing, status changes, and AI runs |
| `drafts` | 아이디어 | Idea lifecycle, implementation drafts, promotion, and recurring automation |
| `gap` | 갭 분석 | Compare promoted drafts with frozen baselines and record human revision patterns |
| `agents` | 에이전트 | Runtime status, chat, runs, permissions, schedules, and user-created agents |
| `catalog` | 카탈로그 | Operations catalog for deadlines, approvals, evidence, and inbox signals |
| `studio` | 스튜디오 | Seven-step document authoring, template, guideline, HWP field, export, and package flow |
| `diagram` | 다이어그램 | Concept maps, report patterns, templates, history, and managed report assets |
| `graph` | 그래프 | WebGL vault/workspace graph, neighborhoods, saved views, and reviewed relationship writes |
| `sites` | 사이트 | Site switcher and embedded native browser surface |
| `e2e` | E2E 플로우 | Hidden end-to-end flow console for development and verification |

## Install

The desktop application and standalone CLI are separate artifacts.

```bash
brew tap STAIxBWLB/homebrew-cask

# Desktop application only
brew install --cask maru-workspace

# Standalone CLI only; installs the executable as `maru`
brew install maru-cli

maru --version
```

The cask installs `Maru.app` and does not create a CLI symlink. The desktop app
uses signed Tauri updater metadata from GitHub Releases. Homebrew installations
can also be upgraded explicitly:

```bash
brew upgrade --cask maru-workspace
brew upgrade maru-cli
```

## Architecture

```text
+---------------------------------------------------------------+
| Tauri WebView: React 19 + TypeScript                          |
|                                                               |
| 18 typed lazy mode adapters                                   |
| BlockNote / CodeMirror / DOMPurify / Radix UI                 |
| Sigma WebGL / Graphology / diagram canvas / terminal canvas   |
+-------------------------------+-------------------------------+
                                | Tauri IPC
+-------------------------------v-------------------------------+
| Rust core                                                     |
|                                                               |
| workspace scan + cache       document + frontmatter           |
| inbox + provider bridges     today + tasks + scheduler        |
| terminal PTY + screen model  graph + diagram + Studio         |
| skill host + agent host      Hub client + export pipeline     |
| write policy + approval      atomic files + revision guards   |
+---------------+-------------------------------+---------------+
                | stdio                         | fixed argv
+---------------v--------------+  +-------------v---------------+
| Local MCP sidecar (Node)     |  | External CLIs and skills    |
| Read-first workspace tools   |  | Claude/Codex/Kimi/Kiro/hwp  |
+------------------------------+  +-----------------------------+
```

### Module Boundaries

- Rust owns workspace filesystem access, cache, git operations, frontmatter,
  provider bridges, terminal sessions, skill ownership, agent execution,
  catalog, Studio, export, Diagram, Graph storage, and write enforcement.
- `src/lib/` owns frontend domain logic and module stores.
- React components own rendering, editors, user interaction, graph layout, and
  diagram canvas behavior. They do not bypass Rust write guards.
- `src/lib/` does not import components, except for documented type-only legacy
  boundaries. Nothing imports `src/App.tsx`.
- Shared UI state follows keyed module-store plus `useSyncExternalStore`
  patterns. No additional global state library or provider tree is used.

## Capability Highlights

### Documents and Files

- Markdown uses Rich, Source, and sanitized Preview modes.
- HTML uses Visual, Source, and sandboxed Preview modes. Scripts, event
  handlers, forms, frames, meta refresh, network resources, and paths outside
  the owning workspace are blocked in the runtime clone and never written back.
- Documents support read, save, create, version, rename, move, duplicate, and
  system-Trash operations with optimistic concurrency.
- Files presents folders, direct children, search, binary previews, shared
  document drafts, multi-selection, keyboard control, and collision-safe file
  operations.
- Rename and move use `.maru-rename-txn/` staging with recovery on the next
  scan. Operations never overwrite an existing target.

### Korean Document Operations

- Document Studio guides source selection, template and guideline choice,
  section editing, HWP fields, export, and package freeze.
- Native template publication requires released `hwp` 0.12.1 or newer and
  fails closed on malformed fill reports, unmatched fields, or validation
  failure.
- The lower-level `hwped_*` engine bridge supports read, render, edit, compose,
  validate, and capabilities with `hwp` 0.8.7 or newer.
- Export manifests bind source hashes to DOCX, HWPX, and PDF outputs and record
  partial failures instead of reporting silent success.
- The gaejosik linter supports Korean public-document style during authoring.

### Evidence, Drafts, and Knowledge

- Evidence Binder stores schema-v2 state under
  `<workspace>/.maru/binder/<doc-id>.json`, uses full binary SHA-256 identity,
  revision-checked atomic mutations, explicit targets, local verification, and
  submission selection.
- Drafts use `$MARU_DRAFTS` plus `.maru/drafts/index.json`; promotion is
  approval-gated and freezes a baseline for Gap analysis.
- Diagram documents live at `diagrams/*.cmd.json`; report assets live under
  `attachments/diagrams/<docId>/`; pattern presets live in
  `.maru/diagram-patterns/`.
- Graph uses a multi-directed Graphology model, Sigma WebGL, an off-thread
  ForceAtlas2 worker, visibility reducers, saved views, and schema-gated writes.

### Terminal and AI Runtimes

- The terminal uses `portable-pty` and `alacritty_terminal`, streams ordered
  generation-tagged frames, limits frames in flight, and requires a current
  generation-bearing handle for every session command.
- Terminal and Graph share a persistent bottom/right panel with independent
  themes and remembered layout.
- Claude Code, Codex, Kimi, and Kiro are first-class runtimes. Each named agent
  binds a skill, runtime, permission mode, and optional schedule.
- Provider probes and real integrations have bounded output, timeout,
  cancellation, and stale-request handling. The real-binary integration smoke
  remains separate from hermetic `make verify`.

### Skills and Workspace Sync

- The skill host owns five tiers: core, public, private, imported, and managed.
  One name maps to one tier; doctor, dirty, reconcile, import, and tool-sync
  operations are available through the CLI.
- Codex installs target `$CODEX_HOME/skills` when `CODEX_HOME` is set, otherwise
  `~/.codex/skills`.
- Settings > Jobs manages the external `dot` workspace sync service through its
  versioned JSON API. Maru uses fixed arguments, serializes mutations, and
  confirms destructive or secret-expanding actions.

## Storage and Configuration

Global user state:

```text
~/.maru/
  settings.json
  workspaces.json
  skills/registry.json
  skills/_cache/
```

Workspace-local state:

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

1. **W15 Evidence index** — use the W14 full-sha binding identity for Hub `evidence_index` lookup and reuse hints. Keep binaries local; send only sha256 and metadata through the approval-gated Hub path. Entry files: `src-tauri/src/evidence_binder.rs`, `src-tauri/src/hub_client/*`, `src/components/evidence/*`.
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

# Rust unit + integration tests:
cd src-tauri && cargo test
# or: make test-rust  (cargo test --lib)

# Frontend unit tests:
pnpm test
# End-to-end:
pnpm test:e2e

# Local Maru MCP sidecar smoke:
MARU_MCP_WORKSPACE="$PWD" node sidecars/maru-mcp/index.mjs

# Skills registry doctor / reconcile:
cargo run --manifest-path src-tauri/Cargo.toml -p maru-cli --bin maru-cli -- --version
cargo run --manifest-path src-tauri/Cargo.toml -p maru-cli --bin maru-cli -- doctor --json
cargo run --manifest-path src-tauri/Cargo.toml -p maru-cli --bin maru-cli -- skills dirty --json
cargo run --manifest-path src-tauri/Cargo.toml -p maru-cli --bin maru-cli -- skills reconcile <name-or-id> --accept --dry-run
cargo run --manifest-path src-tauri/Cargo.toml -p maru-cli --bin maru-cli -- skills import /path/to/skill --copy

# Bench workspace scan on a real workspace:
cd src-tauri && cargo test --release bench_scan_real_workspace \
    -- --ignored --nocapture --test-threads=1
# → MARU_BENCH_WORKSPACE=/some/path overrides the default ~/workspace/work
```

Codex skill sync writes to `$CODEX_HOME/skills` when `CODEX_HOME` is set, as
it is for isolated Orca account profiles. Without that variable, it uses the
standard `~/.codex/skills` directory.

CI runs `make verify` (typecheck + vitest + cargo test --lib + build) and
`make test-e2e` on every pull request and push to `main` via
`.github/workflows/ci.yml`. The heavier
`release-preflight` repeats both and adds diff checks, CLI tests/smoke, and a
debug Tauri build on version tags.

## Skills Bundle Channel (OTA)

Skills deploy independently of app releases and live in their own repo,
[`STAIxBWLB/skills`](https://github.com/STAIxBWLB/skills). Every push there
that touches bundle content verifies, packages, signs (same minisign key as
the app updater), and uploads immutable assets to that repo's
`skills-channel` prerelease. The app checks that channel after launch and
every 6 hours, applies new bundles automatically when the local skills are
clean and runtime-compatible, and shows an update-available notification
otherwise; `maru skills update --check|--apply [--repair-env]` and the
Skills UI cover manual flows. The binary embeds only a frozen
`src-tauri/skills-bootstrap/` snapshot as the offline first-run fallback;
refresh it from the newest bundle with `make skills-bootstrap-refresh` when
cutting an app release.

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
- `APPLE_ID`
- `APPLE_PASSWORD` — app-specific password
- `APPLE_TEAM_ID`

The release workflow imports `APPLE_CERTIFICATE` only inside the macOS signing
prep step, and it sends Apple notarization env vars only to the Developer ID
build branch. It intentionally does not pass unset Apple secrets into
`tauri-apps/tauri-action`, because empty environment variables make Tauri try
to import or notarize with blank credentials.

Minimum Apple Developer setup for direct distribution:

1. Create a `Developer ID Application` certificate. The default Maru bundle
   intentionally has no managed entitlement or HTTP/HTTPS browser-role
   declaration, so it does not require an App ID or provisioning profile.
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
   gh secret set APPLE_ID --repo STAIxBWLB/maru
   gh secret set APPLE_PASSWORD --repo STAIxBWLB/maru
   gh secret set APPLE_TEAM_ID --repo STAIxBWLB/maru
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

Browser-passkey packaging is a separate, fail-closed opt-in. The default
`src-tauri/tauri.conf.json` omits both the managed entitlement and HTTP/HTTPS
browser-role metadata; the runtime checks the effective code signature with
`SecTaskCopyValueForEntitlement` and returns `unsupported` before loading or
constructing Apple's browser passkey manager. This keeps `tauri dev`, CI,
ad-hoc bundles, and older supported macOS releases launchable.

`src-tauri/tauri.passkeys.conf.json` is an active, opt-in overlay. The app
bundle contains one Mach-O executable (`maru`) plus an executable
`Contents/Resources/maru-cli` shell wrapper that dispatches to
`../MacOS/maru --maru-cli`; the standalone/Homebrew `maru-cli` Mach-O lives in
the separate `src-tauri/maru-cli` workspace package, outside the app package's
binary targets. This prevents Tauri from applying the
managed entitlement to an unprovisioned helper. Incoming HTTP/HTTPS open
events are filtered into a bounded memory queue, emitted as
`sites://open-requested`, and can be drained after cold start. The Safari
fallback opens `com.apple.Safari` directly so Maru cannot recursively invoke
itself when registered as the default HTTP/HTTPS handler.

Passkey-enabled distribution additionally requires:

1. Register the explicit App ID `kr.maru.desktop` and request Apple's managed
   `com.apple.developer.web-browser.public-key-credential` capability.
2. Confirm that Apple approves the capability for Developer ID distribution.
   If Apple does not offer it for that distribution channel, keep the
   system-browser fallback and do not enable the overlay.
3. Create a Developer ID provisioning profile containing the approved
   entitlement and supply its absolute path through
   `MARU_MACOS_PROVISIONING_PROFILE`.

Validate the profile and build a local provisioned app with:

```bash
export MARU_MACOS_PROVISIONING_PROFILE=/absolute/path/to/Maru.provisionprofile
export APPLE_SIGNING_IDENTITY='Developer ID Application: Example (TEAMID)'
export APPLE_TEAM_ID=TEAMID
make macos-passkey-readiness-check
make macos-passkey-build
```

The probe validates profile expiration, team and application identifiers, the
managed passkey entitlement, the non-Mach-O helper wrapper, and the opened-URL
backend. The build command temporarily stages the ignored fixed profile source,
embeds it as `Maru.app/Contents/embedded.provisionprofile`, builds with the
overlay, verifies the app signature and entitlement, then removes or restores
the staged source. The normal release workflow does not select this overlay;
enable it there only after the approved profile and explicit release variable
are configured. Calling `tauri build` with the overlay directly, without the
staging and readiness checks, is unsupported.

Release asset versions come from `package.json`, `src-tauri/tauri.conf.json`,
the root and CLI Cargo manifests, and their package entries in
`src-tauri/Cargo.lock`; keep them in sync before tagging or publishing a
release. `make macos-distribution-check` asserts the four manifests agree but
does not read the lock file, and nothing checks the tag against the manifests: if the
tag names a version the manifests do not, the bundle jobs still succeed with the
old asset names and `latest.json` advertises the old version, so no installed
client is ever offered the update.

The `homebrew-tap` job in `release-bundles.yml` pushes the tap update
automatically once the bundle and CLI jobs finish. The `make homebrew-*` targets
below are for verifying that result, or for recovering by hand if that job
failed:

```bash
make homebrew-update-commit RELEASE_TAG=v$(node -p "require('./package.json').version") HOMEBREW_TAP_DIR=../homebrew-cask
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
  drafts/
  temp/{claude,codex,kimi,kiro,runtime}/
```

Only `temp/` is disposable. Ideation, memos, and drafts are durable and may be
Git-tracked. Cleanup is explicit and moves selected files to system Trash.

Public workspace configuration is registry-only in v1.1.0. Provider metadata
is non-secret, manually entered roles map to coarse capabilities, and filesystem
writability is probed again before granting direct writes. OAuth and live cloud
role checks are not implied by this metadata.

## Safety Contracts

- `src-tauri/src/frontmatter/ops.rs` is the only allowed frontmatter write path.
- `resolve_inside_vault` and shared containment helpers stay lexical. Deliberate
  symlinks inside a workspace remain supported.
- Managed writes pass `vault_guard::validate_managed_write`, create a snapshot,
  and use revision-checked atomic replacement. Note deletion remains MCP-only.
- Every conflict code the frontend can consume crosses as structured
  `IpcError`. New Rust modules are covered automatically by the ERR-06 guard.
- Error normalization accepts only known contract codes. Unknown or forged
  codes degrade to a plain `Error` and never satisfy recovery branches.
- Provider and subprocess commands use fixed argv rather than a shell whenever
  input can cross a trust boundary.
- The application has no default telemetry, Maru account, cloud-sync engine,
  multi-user CRDT, or autonomous-write default.
- Signed update metadata is mandatory. Unsigned or ad-hoc updater feeds are not
  accepted.

## Development

Requirements:

- Node.js 22 or newer
- pnpm 9.15 or newer
- Rust MSRV 1.77.2; `rust-toolchain.toml` pins the repository verification
  toolchain
- Platform libraries required by Tauri 2

Common commands:

```bash
pnpm install

# Browser development with mocked Tauri IPC
pnpm dev

# Native development
pnpm tauri:dev

# Focused frontend gates
pnpm typecheck
pnpm lint
pnpm lint:i18n
pnpm test
pnpm test:e2e
pnpm build

# Rust gates
make test-rust
make fmt-check
make clippy

# Complete hermetic verification
make verify

# Full verify plus release-only CLI and debug Tauri checks
make release-checks

# Complete local release gate
make release-preflight

# Real installed runtime smoke; not hermetic
make verify-integration
MARU_CLI_SMOKE_ROUNDTRIP=1 make verify-integration

# Local MCP sidecar smoke
MARU_MCP_WORKSPACE="$PWD" node sidecars/maru-mcp/index.mjs
```

Skill registry checks:

```bash
cargo run --manifest-path src-tauri/Cargo.toml -p maru-cli --bin maru-cli -- --version
cargo run --manifest-path src-tauri/Cargo.toml -p maru-cli --bin maru-cli -- doctor --json
cargo run --manifest-path src-tauri/Cargo.toml -p maru-cli --bin maru-cli -- skills dirty --json
cargo run --manifest-path src-tauri/Cargo.toml -p maru-cli --bin maru-cli -- skills sync --check --tools claude,codex --json
```

## Verification and CI

`make verify` covers:

- four TypeScript projects: application, Node config, E2E, and scripts
- ESLint correctness rules with zero warnings
- release-version synchronization and static architecture guards
- frontend tests and Rust library tests
- rustfmt and clippy with warnings denied
- production frontend build and gzip bundle budgets

Pull requests run a lightweight decision job first. Source changes fan out to
`make verify` and Playwright E2E. Version-changing PRs run `make release-checks`
instead of the ordinary verify target, adding release-mode CLI and debug Tauri
checks. Documentation-only and `.planning/**` changes skip expensive CI.

A push to `main` may reuse the exact PR tree only when the successful PR run is
for the identical head SHA. Direct pushes, merge-tree differences, missing
checks, and API failures run the full suite.

CI E2E runs Chromium against Vite with mocked IPC. It does not prove WKWebView,
the native PTY, Korean IME behavior, macOS menus, signing, or notarization.
macOS-affecting changes require a real-app or release-artifact check.

## Release Process

The release version's major and minor come from the active GSD milestone in
`.planning/STATE.md`; releases only increment the patch. Milestone v1.1 ships as
1.1.x, and opening milestone v1.2 moves releases to 1.2.0. There is one tag
namespace and it belongs to releases: milestone completion no longer creates a
git tag.

Version sources must remain synchronized:

```text
package.json
src-tauri/tauri.conf.json
src-tauri/Cargo.toml
src-tauri/maru-cli/Cargo.toml
src-tauri/Cargo.lock (maru and maru-cli package entries)
```

Release sequence:

1. Merge a version PR after release checks and Playwright E2E pass.
2. Verify exact-tree `main` CI.
3. Dispatch and pass Release Preflight.
4. Publish a GitHub Release whose tag is exactly `v<package version>` and whose
   target is the verified `main` commit. `Validate release inputs` enforces the
   prefix and fails before release lookup or bundle creation.
5. Wait for Release Bundles to finish across macOS ARM, macOS Intel, Linux, and
   Windows.
6. Verify the public artifacts, updater manifest, signatures, and Homebrew tap.

The release workflow produces 20 platform assets, then a single finalizer
publishes `latest.json` for 11 updater platforms and updates Homebrew. A complete
release therefore has 21 non-empty assets. Platform jobs never race to write
the manifest.

Useful local checks:

```bash
make release-version-check
node scripts/check-release-version.mjs --tag v$(node -p "require('./package.json').version")
make macos-distribution-check
make macos-distribution-local-check
```

### macOS Signing and Notarization

Public macOS releases fail closed unless all signing secrets are configured:

```text
APPLE_CERTIFICATE
APPLE_CERTIFICATE_PASSWORD
KEYCHAIN_PASSWORD
APPLE_ID
APPLE_PASSWORD
APPLE_TEAM_ID
TAURI_SIGNING_PRIVATE_KEY
TAURI_SIGNING_PRIVATE_KEY_PASSWORD
```

Developer ID signing and Tauri updater signing are separate. The normal release
does not enable the browser-passkey provisioning overlay.

Local Apple material belongs outside the repository:

```text
~/workspace/work/.maru/secrets/apple/
  DeveloperIDApplication.p12
  AuthKey_<APPLE_API_KEY_ID>.p8
  certificate-password
  api-issuer-id
  api-key-id             # optional
  keychain-password      # optional
```

After downloading release artifacts:

```bash
xcrun stapler validate Maru_*.dmg
spctl -a -vv -t open --context context:primary-signature Maru_*.dmg
codesign --verify --deep --strict --verbose=4 Maru.app
spctl -a -vv -t exec Maru.app
```

Homebrew verification:

```bash
make homebrew-audit HOMEBREW_TAP_DIR=../homebrew-cask
make homebrew-fetch HOMEBREW_TAP_DIR=../homebrew-cask
```

The explicit `make homebrew-update*` targets are recovery tools. The release
finalizer normally updates `STAIxBWLB/homebrew-cask` automatically after the
manifest succeeds.

## Skills OTA Channel

Skills deploy independently from the desktop application through
`STAIxBWLB/skills`. Bundle changes are verified, packaged, minisign-signed, and
published to the `skills-channel` prerelease. Maru checks after launch and every
six hours, auto-applies only when local skills are clean and runtime-compatible,
and exposes manual check/apply commands in the CLI and Skills UI.

`src-tauri/skills-bootstrap/` is a frozen first-run fallback, not the live OTA
source. Refresh it deliberately with `make skills-bootstrap-refresh` only when
an application release must carry a newer offline bootstrap.

## Roadmap

The GSD v1.0 Structural Debt Paydown milestone is complete and archived. The
active milestone is v1.1 Felt Quality and Native Proof, spanning phases 6-11.
The long-range product plan remains in [ROADMAP.md](ROADMAP.md), but planned
items there are not active commitments until a GSD milestone promotes them into
requirements.

Milestone v1.1 promoted part of the carried-over backlog into requirements. The
remaining candidates are:

- ERR-05 closed-enum IPC construction
- Hub evidence index, approval/finalize, certification, and Deck Studio tracks

## Scope Boundaries

Maru v1.1.0 intentionally does not include:

- semantic or embedding search
- a Maru account or default telemetry
- a built-in cloud-sync engine
- mobile distribution
- iMessage or Slack ingestion
- multi-user collaboration, CRDT, or realtime editing
- PDF annotation or OCR
- a public skill marketplace server
- agent-autonomous edits as the default behavior
- unsigned updater feeds

## Documentation

- [CHANGELOG.md](CHANGELOG.md): release-by-release shipped changes
- [ROADMAP.md](ROADMAP.md): long-range product tracks
- [docs/agents.md](docs/agents.md): agents and runtime model
- [docs/diagram.md](docs/diagram.md): Diagram and report-pattern contracts
- [docs/graph.md](docs/graph.md): Graph storage, interaction, and write safety
- [docs/studio.md](docs/studio.md): Document Studio and native template flow
- [docs/hwp-editor.md](docs/hwp-editor.md): lower-level HWP engine bridge
- [docs/SSOT-TIERS.md](docs/SSOT-TIERS.md): skill ownership tiers
- [docs/BOUNDARIES.md](docs/BOUNDARIES.md): cross-repository ownership boundaries
- [docs/macos-passkeys.md](docs/macos-passkeys.md): opt-in passkey distribution runbook
- [.planning/reports/MILESTONE_SUMMARY-v1.0.md](.planning/reports/MILESTONE_SUMMARY-v1.0.md): completed structural milestone summary

## License

No license file is currently published. All rights reserved unless a license is
added.

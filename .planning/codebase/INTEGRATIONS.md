# External Integrations

**Analysis Date:** 2026-08-22

Maru is local-first: almost every "integration" is a subprocess bridge to a CLI
the user already installed, or a file-based relay on disk. Only three code paths
open a network socket from the app: `hub_client/http.rs`, the OTA skills-bundle
downloader in `skill_host/bundle_update.rs`, and `tauri-plugin-updater`. All
three go through `reqwest` (blocking, rustls-tls) or the Tauri plugin. The
frontend CSP in `src-tauri/tauri.conf.json` allows no remote origin at all, so
the React layer cannot reach the network directly.

## APIs & External Services

**AI coding CLIs (subprocess, streamed over Tauri events):**
- Claude Code / Codex / Kimi / Kiro - headless prompt invocation for inbox classification, skill runs, agent chat, and scheduled missions
  - SDK/Client: none. `src-tauri/src/ai_router.rs` spawns the binary; argv shape per provider lives in `src-tauri/src/agent_host/provider.rs` (`CliProviderKind::{Claude,Codex,Kimi,Kiro}`, Claude takes `-p`, Codex pipes stdin via `exec -`)
  - Capabilities (resume / usage / add-dirs) are declared in `ProviderCapabilities` and mirrored in `src/lib/agentCapabilities.ts`; a test parses the Rust file and fails the build on drift
  - Auth: inherited from each CLI's own login state. Maru stores no AI API key
  - Binary resolution: `src-tauri/src/cli_path.rs` (`augmented_path`, `resolve_program`) because macOS Tauri apps inherit a sparse PATH
  - Events: `ai://output`, `ai://done`, `ai://error`
- Same CLIs also run interactively as PTY terminal tabs (`src-tauri/src/terminal/`)

**Google Workspace (Gmail, Calendar, Tasks) via the `gws` CLI:**
- `src-tauri/src/gmail_gws.rs` - shells out to `gws gmail +triage --format json` for inbox triage. Deliberately replaced a planned IMAP client: no app password, no TLS state machine
- `src-tauri/src/today_outbox.rs` - Google Tasks mutations, written durably to `<work>/.maru/today/outbox/<id>.json` first, then drained through `gws` with retry backoff (1/5/15/60 min, then hourly) and an `authBlocked` state
- `src-tauri/src/today_calendar.rs` - publish-only Calendar path. Reads capacity from local markdown notes (`calendarStart`/`calendarEnd` frontmatter) so the planner works offline; only explicitly selected blocks are pushed
- Auth: `gws` owns it (system keyring). Maru only classifies auth failure strings
- Config: `workspace.config.yaml` `io.*` plus `<vault>/.maru/inbox.json` for an absolute `gws` path override

**Microsoft 365 (Outlook mail, calendar, Graph) via the `m365` CLI:**
- `src-tauri/src/outlook_mso.rs` (2178 lines, the largest connector) - message listing with an explicit `$select` field set, accept/reject staging, Maru categories (`maru-accepted` / `maru-rejected`), bulk actions
- Auth: `m365` device-code login (`https://microsoft.com/devicelogin`); Maru surfaces auth-required and workspace-mismatch states and never handles tokens
- Output limits: 2 MiB stdout / 64 KiB stderr caps, 10s readiness timeout, sensitive-value scrubbing before diagnostics are shown (`command_output.rs`)

**Telegram:**
- `src-tauri/src/telegram_io.rs` - inbound polling (default 60s, floor 30s) through the bundled `io-telegram` skill script, run with the managed Python from `~/.maru/env`
  - Config: `workspace.config.yaml` `io.providers.telegram.{python_path,script_path}`; `api_id` / `api_hash` in the workspace secret store
- Outbound notification bot token + chat id are stored in settings (`src/lib/api.ts` masks them as `****mock` in the mocked API surface)

**KakaoTalk (file relay, no API):**
- `src-tauri/src/kakao_relay.rs` - a daemon on a separate Mac syncs a Dropbox "relay bus" folder; Maru reads `status/relay.json`, `rooms/rooms.json`, `messages/<room>/<date>/*.json`, and queues outbound sends into `outbox/{pending,attachments,done}/`
  - Tolerates partial Dropbox sync: unparseable JSON is skipped, media younger than 10s is treated as in flight
  - Heartbeat: 300s expected, stale after 900s
  - Config root: `io.providers.kakao.relay_root`

**Maru Hub (self-hosted FastAPI service):**
- `src-tauri/src/hub_client/` - read-mirror of the shared operations catalog and document library
  - Read: `GET /api/v1/<resource>` with ETag / `If-None-Match`, `304` falls back to the local cache (`hub_client/cache.rs`, `http.rs`)
  - Write (approval-gated): `POST /api/v1/documents/sync` (metadata + sha256 only, no body/binary) and `POST /api/v1/documents/{id}/finalize` (full body + rendered artifacts + evidence bytes)
  - Safety pre-flight before any write: `hub_client/safety.rs`. Body/binary/PII upload is forbidden on the read path by design
  - Offline: submits queue at `<workspace>/.maru/queue/hub/` (one JSON per request) and drain FIFO via `hub_queue_drain`
  - Config: `workspace.config.yaml` `hub.{enabled,endpoint,deployment_mode,timeout_ms}`; optional bearer `api_token`

**GitHub (release + OTA distribution):**
- Skills bundles: `GET https://api.github.com/repos/<slug>/releases/tags/skills-channel`, then download + minisign verify + sha256 + zip staging (`src-tauri/src/skill_host/bundle_update.rs`). Caps: 8 MiB metadata, 256 MiB archive, 512 MiB uncompressed, 20k entries
- App updates: `tauri-plugin-updater` polls `https://github.com/STAIxBWLB/maru/releases/latest/download/latest.json` (`src-tauri/tauri.conf.json`, client `src/lib/updater.ts`)

**Local system tools:**
- `git` - status/diff/commit/sync by shell-out, no libgit2 (`src-tauri/src/git.rs`). Commit+push is approval-gated (`GIT_SYNC_COMMIT_PUSH_APPROVAL_KIND`)
- `dot` CLI (>= 2.63.0) - workspace cloud-mirror and Mac-peer sync managed from Settings > Jobs (`src-tauri/src/dot_sync.rs`). Fixed argv, never a shell; mutating actions serialized behind a global lock
- `hwp` / HWPX toolchain - document export and template fill (`src-tauri/src/export/dispatch.rs`, `template_fill.rs`), binary override `MARU_HWPX_BIN`
- macOS `launchd` - migration/registration for scheduled work (`src-tauri/src/launchd_migration.rs`)

**MCP:**
- Local Node sidecar `sidecars/maru-mcp/index.mjs` - stdio MCP server exposing `workspace.search`, `document.read`, and related read-first tools, scoped to `MARU_MCP_WORKSPACE` with a realpath jail
- User-configured MCP servers are stored per workspace at `<workspace>/.maru/mcp.json` (`src-tauri/src/maru_dir.rs`)

## Data Storage

**Databases:**
- None. No SQL, no ORM, no embedded database. `.gitignore` reserves `<vault>/.maru/cache.db` for a future SQLite cache, but no code creates it

**File Storage:**
- Local filesystem only. The workspace is a directory of markdown/HTML plus binaries; all app state is JSON/YAML under `<workspace>/.maru/` and `~/.maru/`
- Writes go through `src-tauri/src/atomic_file.rs` (`write_atomic`) and are gated by `vault_guard.rs` / `vault_list.rs` write assertions
- Dropbox is used as a transport medium for the Kakao relay bus only, not as app storage

**Caching:**
- In-process: parallel workspace scan index with warm-start cache (`src-tauri/src/workspace.rs`)
- On-disk: Hub response cache with ETag (`hub_client/cache.rs`), ops-catalog index (`ops_catalog/index.rs`), skills bundle baselines under `~/.maru/skills/_bundles/`

## Authentication & Identity

**Auth Provider:**
- None for the app itself. Maru is a single-user local app with no login
- Every external identity is delegated to the CLI that owns it: `gws` (Google, keyring), `m365` (Microsoft device code), Telegram API credentials in the workspace secret store, `git` credentials from the user's own config
- Hub uses an optional static bearer token from `workspace.config.yaml`
- Secret hygiene is a first-class feature: `src-tauri/src/secrets.rs` (1421 lines) scans for stray credentials, enforces `<work>/.maru/secrets/` as the managed root (legacy `.secrets` kept as a symlink), checks file permissions, and reports candidates and issues
- macOS browser passkeys: `src-tauri/src/browser_passkeys.rs` only exposes Apple's browser-level permission gate to the main webview; it accepts no relying party, challenge, or credential, so it cannot become a second WebAuthn implementation

## Monitoring & Observability

**Error Tracking:**
- None. No Sentry, no analytics, no telemetry SDK anywhere in `package.json` or `Cargo.toml`

**Logs:**
- Local only. Mission/run logs under `~/.maru` and the workspace (`src-tauri/src/mission_state.rs`, `agent_host/event_store.rs`), tailed in the UI
- `agent_host/cloud_dashboard.rs` produces a redacted run summary (counts and provider/skill names only) for explicit user export, not automatic upload
- Frontend errors surface through an in-app store (`src/lib/errorStore.ts`)

## CI/CD & Deployment

**Hosting:**
- Not a hosted service. Distribution is GitHub Releases on `STAIxBWLB/maru` plus a Homebrew tap (cask `maru-workspace`, formula `maru-cli`, templates in `packaging/homebrew/`)

**CI Pipeline:**
- `.github/workflows/ci.yml` - `make verify` on ubuntu-22.04, with a dedupe step that skips a full run when the exact tree already passed on its merged PR. Installs webkit2gtk deps, pnpm, Node 22.22.3, stable Rust, and Playwright Chromium
- `.github/workflows/release-bundles.yml` - triggered on published release; matrix over macOS (aarch64 + x86_64), Windows, ubuntu-22.04; builds bundles, signs and notarizes macOS, builds the standalone CLI per target, and uploads assets
- `.github/workflows/release-preflight.yml` - pre-tag gate (`make release-preflight`)
- Release helpers: `scripts/publish-updater-manifest.mjs`, `scripts/update-homebrew-tap.mjs`, `scripts/check-release-version.mjs`, `scripts/notarize-local-smoke.mjs`

## Environment Configuration

**Required env vars:**
- None at app runtime. The app starts and runs with an empty environment; every connector degrades to "not configured"
- CI/release secrets: `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID`, `APPLE_SIGNING_IDENTITY`, `APPLE_API_KEY_PATH`, `MARU_MACOS_PROVISIONING_PROFILE`, `MARU_RELEASE_REPO`, `MARU_HOMEBREW_TAP`
- QA/test overrides: `MARU_SKILLS_MANIFEST_URL`, `MARU_SKILLS_PUBKEY`, `MARU_HWPX_BIN`, `MARU_MCP_WORKSPACE`, `MARU_E2E_PORT`, `MARU_TEST_HOME`

**Secrets location:**
- Workspace secret store: `<work>/.maru/secrets/` (gitignored, permission-checked by `secrets.rs`)
- Apple notarization secrets read locally from `~/workspace/work/.maru/secrets/apple` (`make macos-notarize-local`)
- Provider tokens otherwise live in each CLI's own keychain/keyring, outside Maru
- The app never reads `.env` files

## Webhooks & Callbacks

**Incoming:**
- No HTTP server, no listening port, no webhook receiver
- The closest equivalent is `src-tauri/src/web_actions.rs`: the Maru web app commits `maru.web-task-action.v1` receipts to `shared/web/task-actions/pending/YYYY-MM/<uuid>.yaml` in the workspace repo; after `git pull`, an explicit user-invoked command validates each receipt (traversal / dotfile / secret-shape / bucket checks, fail-closed) and applies it through `today_lifecycle.rs` and `today_outbox.rs`, then moves it to `applied/YYYY-MM/`
- Filesystem watchers act as local event sources: `inbox_watcher.rs`, `vault_watcher.rs`, `scratchpad_watcher.rs`, `ops_catalog/watcher.rs` (all `notify` 6)

**Outgoing:**
- Hub `POST /api/v1/documents/sync` and `POST /api/v1/documents/{id}/finalize` (approval-gated, queued when offline)
- Telegram bot notification sends and Kakao relay outbox writes
- `gws` Google Tasks / Calendar mutations via the durable outbox
- The in-app scheduler (`src-tauri/src/scheduler.rs`, 60s tick, `<work>/.maru/schedules.json`) can fire any of the above indirectly by dispatching skill runs; overdue schedules catch up exactly once on launch

---

*Integration audit: 2026-08-22*

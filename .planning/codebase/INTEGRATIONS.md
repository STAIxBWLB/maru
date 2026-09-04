# Maru External Integrations

Maru is local-first: most integrations are subprocess bridges to CLIs the user already installed, or file-based relays on disk. Only a few code paths open network sockets from the app, and the frontend CSP allows no remote origins.

## AI Coding CLIs (Subprocess)

- **Providers:** Claude Code, OpenAI Codex, Kimi, Kiro
- **Usage:** headless prompt invocation for inbox classification, skill runs, agent chat, and scheduled missions
- **Bridge:** `src-tauri/src/ai_router.rs`, `src-tauri/src/skill_host/dispatch.rs`, `src-tauri/src/agent_host/provider.rs`
- **Argv shaping per provider:** Claude uses `-p`; Codex pipes stdin via `exec … -`; Kimi/Kiro have their own shapes
- **Capabilities:** resume, usage/quota, `--add-dir` support declared in `ProviderCapabilities` and mirrored in `src/lib/agentCapabilities.ts`
- **Auth:** delegated to each CLI's own login state; Maru stores no AI API key
- **Events:** `ai://output`, `ai://done`, `ai://error`
- **Interactive use:** same CLIs also spawn as PTY terminal tabs (`src-tauri/src/terminal/`)

## Email, Messaging & Calendar

### Google Workspace via `gws` CLI

- **Gmail inbox triage:** `src-tauri/src/gmail_gws.rs` shells out to `gws gmail +triage --format json`
- **Google Tasks:** `src-tauri/src/today_outbox.rs` writes durable outbox records, then drains via `gws` with retry/backoff and `authBlocked` state
- **Google Calendar:** `src-tauri/src/today_calendar.rs` reads capacity from local markdown notes (`calendarStart`/`calendarEnd` frontmatter) and pushes only explicitly selected blocks via `gws calendar events insert`
- **Auth:** owned by `gws` (system keyring); Maru only classifies auth-failure strings
- **Frontend:** `src/lib/gmail.ts`, `src/lib/today.ts`, `src/lib/todayPlan.ts`

### Microsoft 365 via `m365` CLI

- **Outlook mail:** `src-tauri/src/outlook_mso.rs` lists messages, stages accept/reject decisions, applies Maru categories (`maru-accepted` / `maru-rejected`), and runs bulk actions
- **Auth:** `m365` device-code login (`https://microsoft.com/devicelogin`); Maru surfaces auth-required and workspace-mismatch states
- **Frontend:** `src/lib/outlook.ts`
- **Limits:** 2 MiB stdout / 64 KiB stderr caps, 10s readiness timeout, sensitive-value scrubbing before diagnostics

### Telegram

- **Inbound polling:** `src-tauri/src/telegram_io.rs` polls via the bundled `io-telegram` skill script, using the managed Python from `~/.maru/env` (default 60s interval, 30s floor)
- **Config:** `workspace.config.yaml` `io.providers.telegram.{python_path,script_path}`; `api_id` / `api_hash` in workspace secret store
- **Outbound bot notifications:** bot token + chat id stored in settings
- **Frontend:** `src/lib/telegram.ts`, `src/lib/telegramMonitor.ts`, `src/lib/telegramEventsStore.ts`

### KakaoTalk

- **File relay bus:** `src-tauri/src/kakao_relay.rs` reads a Dropbox folder synced by a separate Mac daemon
- **Reads:** `status/relay.json`, `rooms/rooms.json`, `messages/<room>/<date>/*.json`
- **Outbound:** queues sends into `outbox/{pending,attachments,done}/`
- **Heartbeat:** expected every 300s, stale after 900s
- **Config root:** `io.providers.kakao.relay_root`
- **Frontend:** `src/lib/kakaoRelay.ts`

## Maru Hub (Self-Hosted FastAPI)

- **Client:** `src-tauri/src/hub_client/`
- **Read mirror:** `GET /api/v1/<resource>` with ETag / `If-None-Match`; `304` falls back to local cache
- **Write (approval-gated):** `POST /api/v1/documents/sync` (metadata + sha256 only) and `POST /api/v1/documents/{id}/finalize` (full body + rendered artifacts)
- **Safety:** `hub_client/safety.rs` pre-flight; body/binary/PII upload forbidden on the read path
- **Offline queue:** `<workspace>/.maru/queue/hub/`, drained FIFO via `hub_queue_drain`
- **Config:** `workspace.config.yaml` `hub.{enabled,endpoint,deployment_mode,timeout_ms}`; optional bearer `api_token`
- **Frontend:** `src/lib/hubClient.ts`, `src/lib/hubLibrary.ts`

## GitHub (Release + OTA Distribution)

- **Skills bundles:** `GET https://api.github.com/repos/<slug>/releases/tags/skills-channel`, then download + minisign verify + sha256 + zip staging (`src-tauri/src/skill_host/bundle_update.rs`)
- **App updates:** `tauri-plugin-updater` polls `https://github.com/STAIxBWLB/maru/releases/latest/download/latest.json`
- **Frontend:** `src/lib/updater.ts`, `src/lib/useUpdaterToasts.ts`

## Local System Tools

- **`git`** — status, diff, commit, sync by shell-out (`src-tauri/src/git.rs`). Commit+push is approval-gated (`GIT_SYNC_COMMIT_PUSH_APPROVAL_KIND`)
- **`dot` CLI** (>= 2.63.0) — workspace cloud-mirror and Mac-peer sync (`src-tauri/src/dot_sync.rs`); mutating actions serialized behind a global lock
- **`hwp` / HWPX toolchain** — document export and template fill (`src-tauri/src/hwped.rs`, `src-tauri/src/export/dispatch.rs`, `src-tauri/src/template_fill.rs`); binary override `MARU_HWPX_BIN`
- **Export pipeline** — `pandoc` (Markdown → DOCX/PDF), `lualatex` (PDF engine), `soffice`/`libreoffice` fallback for PDF from HWPX
- **macOS `launchctl`** — migration/registration for scheduled work (`src-tauri/src/launchd_migration.rs`, `src-tauri/src/jobs.rs`)
- **File manager integration** — `open`/`explorer`/`xdg-open` for reveal and open actions (`src-tauri/src/file_manager.rs`)

## Browser / Passkeys

- **Embedded sites:** `src-tauri/src/site_view.rs` creates child webviews for arbitrary `http(s)` sites; no IPC surface is exposed to remote content
- **External browser:** `open`, `rundll32`, `xdg-open`, and macOS Safari-specific path
- **macOS passkeys:** `src-tauri/src/browser_passkeys.rs` exposes Apple's browser-level permission gate to the main webview; accepts no relying party/challenge/credential input
- **Frontend:** `src/lib/siteView.ts`, `src/lib/browserPasskeys.ts`

## MCP

- **Local Node sidecar:** `sidecars/maru-mcp/index.mjs` — stdio MCP server exposing read-first workspace tools, scoped to `MARU_MCP_WORKSPACE` with a realpath jail
- **User-configured MCP servers:** stored per workspace at `<workspace>/.maru/mcp.json`

## Storage Model

- **No database** — all state is JSON/YAML under `<workspace>/.maru/` and `~/.maru/`
- **Documents:** markdown/HTML plus binaries on the local filesystem
- **Writes:** atomic (`src-tauri/src/atomic_file.rs`) and gated by `vault_guard.rs` / `vault_list.rs`
- **Concurrency:** document reads/writes go through `read_document` / `save_document` with `expectedRevision`
- **Caches:** in-process workspace scan index, Hub ETag cache, ops-catalog index, skills bundle baselines under `~/.maru/skills/_bundles/`

## Authentication & Identity

- **No app login** — Maru is single-user and local
- **External auth is delegated:** `gws` (Google/keyring), `m365` (Microsoft device code), Telegram credentials in workspace secret store, `git` credentials from user config
- **Hub:** optional static bearer token from `workspace.config.yaml`
- **Secrets:** managed root at `<work>/.maru/secrets/`; scanned and permission-checked by `src-tauri/src/secrets.rs`

## Web Actions (Maru Web App → Desktop)

- **Receipt files:** the Maru web app commits `maru.web-task-action.v1` YAML receipts to `shared/web/task-actions/pending/YYYY-MM/<uuid>.yaml`
- **Desktop application:** after `git pull`, an explicit user command validates each receipt (traversal, dotfile, secret-shape, bucket checks) and applies it through `today_lifecycle.rs` and `today_outbox.rs`, then moves it to `applied/YYYY-MM/`

## CI/CD & Deployment

- **CI:** `.github/workflows/ci.yml` runs `make verify` on ubuntu-22.04; deduplicates when the exact tree already passed on its merged PR
- **Release:** `.github/workflows/release-bundles.yml` matrix over macOS (aarch64 + x86_64), Windows, ubuntu-22.04; signs/notarizes macOS, builds standalone CLI, uploads assets
- **Preflight:** `.github/workflows/release-preflight.yml` runs `make release-preflight`
- **Native e2e:** `.github/workflows/native-e2e.yml` runs the real app under WebDriver on macOS

## No Network from Frontend

- The React layer has no `fetch()`, `XMLHttpRequest`, or `WebSocket` call sites
- All frontend integration calls go through `invoke()` in `src/lib/api.ts`
- CSP in `src-tauri/tauri.conf.json` blocks remote origins in `default-src` and `connect-src`

# Anchor

Local-first markdown vault desktop app. Tauri 2 + Rust + React 19 + TypeScript.

## Status (2026-04-28)

| Phase | State | Outcome |
|-------|-------|---------|
| 0 — Hardening | ✅ shipped | Open existing vaults safely. Frontmatter byte-identical round-trip. Multi-vault registry. ko/en parity. |
| 0.5 — UI polish | ✅ shipped | Topbar, sidebar with type filters + recents, command palette (⌘K), Pretendard Korean typography, light/dark. |
| 1A — Killer feature MVP | ✅ shipped | Doc-selection reliability, frontmatter inline edit (InspectorPane), wikilink autocomplete (Korean IME-aware) + click-to-navigate, typed neighborhood pane (project / mentions / peers), in-memory nav history (⌘[ / ⌘]). |
| 1B — Rich editor / git | ✅ feature-complete | Git status badge + commit-from-app (file list + per-file diff + syntax color + auto-refresh on focus). `scan_vault` rayon parallelism: 2.78s → 385ms on 7.1k files. Multi-tab editor (per-vault persistence, ⌘1..⌘8 select, ⌘W close, dirty stash). BlockNote rich + source + preview 3-way toggle (frontmatter line preserved). **Deferred**: vault cache (385ms acceptable), Playwright e2e (Phase 2 CI), monorepo extraction (Phase 1B/2 seam). |
| 2 — Inbox + AI | 🚧 starting | Entry sequence: filesystem watcher → Korean NL date parser → Claude CLI bridge → Gmail IMAP → inbox UI. First two land while Phase 1A verification runs in parallel. |
| 3 — Built-in Skills | 📋 planned | |
| 4 — Document Edit Mode | 📋 planned | |

## Next up (immediate)

Phase 2 entry sequence, lightest-first. These ship without UI surface so Phase 1A real-vault verification is unaffected:

1. **Filesystem watcher** (1 day) — `notify` crate watching `~/workspace/inbox/downloads/`, emits `inbox::file_added` events.
2. **Korean NL date parser** (1–2 days) — JS→Rust rewrite, pure logic with exhaustive unit tests.
3. **Claude Code CLI subprocess bridge** (2–3 days) — lift `tolaria/{ai_agents,claude_cli}.rs`. Used by both inbox classification and Phase 3 skills.

After these three, the inbox UI surface (week 8–9) integrates them into the "press `a` to accept" loop.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Tauri Webview (src/)                                        │
│   React 19 + Radix UI + marked (preview) + DOMPurify         │
│   Phase 1B: + BlockNote rich editor + MediaPipe (Phase 4)    │
│                                                               │
│   [PKM] [Inbox] [Skills] [Doc Edit]  ← 4-mode lens (Phase 1+)│
└──────────────────────────────┬──────────────────────────────┘
                               │ Tauri IPC
┌──────────────────────────────▼──────────────────────────────┐
│  Rust core (src-tauri/src/)                                  │
│   vault.rs       — walkdir + .anchorignore + parallel scan   │
│   frontmatter/   — line-by-line YAML edit (preserves order)  │
│   document.rs    — read/save/create/version + field patch    │
│   git.rs         — status/commit/diff via shell-out          │
│   vault_list.rs  — multi-vault registry + active vault       │
│   filename_rules.rs — Korean NFC/NFD safety, Windows reserve │
│                                                               │
│   Phase 2+: + ai_router.rs / inbox/ / skill_host.rs          │
│   Phase 4+: + whisper bridge / mcp lifecycle                 │
└──────┬─────────────────────────────────────────────────────┘
       │ Phase 2+: stdio + WS bridges
┌──────▼────────┐ ┌────────────────────┐ ┌──────────────────┐
│ MCP server    │ │ User's Claude Code │ │ Whisper sidecar  │
│ (Node, Phase 2)│ │ CLI (~/.claude/skills/*)│ │ (Python, Phase 4)│
└───────────────┘ └────────────────────┘ └──────────────────┘
```

**Module boundary rules**:
- Rust core **owns** vault FS / cache / git / frontmatter / inbox scheduler / MCP lifecycle / Claude CLI subprocess.
- React handles **only** BlockNote / command palette / neighborhood / gesture worker / AudioWorklet. No business logic.
- Node sidecar holds the MCP server + marketplace (both Phase 2+).
- Python sidecar holds Whisper only (Phase 4). HWPX is delegated to the user's `hwpx` Claude Code skill — not rewritten.

## Roadmap

Each phase is defined in **outcomes the user actually exercises**. No phase exists just to grow infrastructure. The entry gate for each phase is the verification of the previous one.

### Phase 1B remaining (week 4–6)

**Outcome**: anchor is a first-class editor capable of carrying one project's meeting notes through a full week.

- [x] **BlockNote rich editor + raw + preview 3-way toggle** — `RichMarkdownEditor` wraps `@blocknote/mantine`; frontmatter line is preserved across rich↔source by splitting on the leading `---…---\n` block before parsing. Source tab is the textarea (with Korean IME-aware `[[` autocomplete). Preview tab is `marked` + DOMPurify. Round-trip on real notes still needs the Phase 1A verification pass.
- [x] **Single-window multi-tab editor** — per-vault `anchor:openTabs:v1` persistence, `EditorTab` discriminator, latest-wins selection, ⌘1..⌘8 to select by index, ⌘W to close active. Closing a dirty tab stashes the draft into the existing Phase 1A `discardedEdit` toast (Tauri webview swallows native `confirm()`, so the toast is the non-blocking equivalent).
- [ ] **Vault cache** — lift `tolaria/src-tauri/src/vault/cache.rs` (1,422 LOC). **Trigger threshold raised**: a one-shot 385ms warm scan is bearable. Revisit only if cold scan is painful or BlockNote integration changes the latency budget.
- [ ] **Monorepo extraction** — `crates/anchor-vault`, `crates/anchor-git`. Done at the seam between Phase 1B and Phase 2.
- [ ] **Playwright smoke + e2e** — lift `tolaria/playwright.smoke.config.ts`. Blocked on a node_modules reinstall (pnpm store mismatch); will pick up alongside Phase 2 CI setup.

**Verification gate**: a full week of multi-tab work with project + meeting + people open simultaneously, daily commits, frontmatter preserved.

### Phase 2 — Inbox + AI (week 7–10)

**Outcome**: a "Today's inbox" view that ingests Gmail and dropped files (`inbox/downloads/`), Claude classifies and proposes actions, the user accepts with a single `a` keystroke.

**Entry sequence (lightest-first)**. Phase 1B is effectively done; Phase 2 starts with the two pieces that don't need a UI surface yet so they can ship while Phase 1A verification on the real vault runs in parallel:

1. **Filesystem watcher (1 day)** — `notify` Rust crate watching `~/workspace/inbox/downloads/{kakao,telegram,gmail,sharepoint}/`. Emits `inbox::file_added` events into the Tauri IPC stream. No OS permissions needed; piggybacks on the user's existing ingest-chain folder convention. Source: ground-up Rust (lighter than tidy's chokidar).
2. **Korean NL date parser (1–2 days)** — JS→Rust rewrite of `tidy/app/electron/ipc-handlers.js:20-109`. Pure logic, exhaustive unit tests for the user's actual phrases ("내일", "다음 주 금요일", "3월 15일", "오늘 오후 3시"). Surfaces as `crates/anchor-korean::date::parse(input, now) -> Option<DateTime<FixedOffset>>`.
3. **Claude Code CLI subprocess bridge (2–3 days)** — lift `tolaria/src-tauri/src/{ai_agents,claude_cli}.rs`. stdio launch + SSE streaming. Used both for Phase 2 inbox classification and Phase 3 user-skill invocation.
4. **Gmail IMAP (week 7–8)** — `async-imap` Rust client. App-password auth, no OS permissions. Largest backend slice.
5. **Inbox view + accept-loop UI (week 8–9)** — JSX→TSX adapt of `tidy/app/src/components/InboxCard.jsx` + `pages/Inbox.jsx`. Wires the watcher + IMAP + Claude bridge into the user's "press `a`" flow.
6. **KakaoTalk macOS notification watcher (week 10, optional)** — deferred while the full-disk-access prompt is avoidable.

**AI dispatch**:
- Primary: Claude Code CLI subprocess (user's Max plan, marginal cost $0).
- Fallback: Anthropic API (Haiku for classification, Sonnet for drafting).
- Streaming: tolaria `ai_agents.rs` SSE bridge.

**Skip in Phase 2**: iMessage DB, Slack, Outlook (Phase 3 wraps Outlook via the `ms-office` skill).

**Verification gate**: a real chu.ac.kr admin email arrives → anchor classifies, extracts a task, and proposes a folder within 30 seconds → user presses `a` → inbox-zero in one session.

### Phase 3 — Built-in Skills (week 11–14)

**Outcome**: five daily ops moved out of the terminal into the command palette.

The `runtime: claude-code` lane is the v1 core — the user's `~/.claude/skills/*` are invoked as-is. **Zero lines rewritten**.

Five skills:
1. **inbox-processor** — pick an inbox item → palette → run skill → show diff → stage.
2. **meeting-notes** — palette → emit `meetings/YYMMDD-*.md` template (Phase 4 adds voice).
3. **task-management** — analyze `_inbox/` → sync `TASKS.md`.
4. **lint** — run `/lint` → inline report (read-only; no auto-fix).
5. **hwpx-fill** — pick template → fill fields → emit `.hwpx`.

**Verification gate**: in one day all five run end-to-end without the terminal, with output equivalent to direct CLI execution. The user reports saving 30+ minutes.

### Phase 4 — Document Edit Mode (week 15–18)

**Outcome**: a dedicated mode inside anchor where voice + gesture edit the RISE proposal. The standalone `dev/anchor-editor` falls out of the loop.

**Keep** (generalized):
- Whisper sidecar (Korean large-v3) — lifted from anchor-editor.
- Intent fusion (voice command → edit intent).
- One-Euro filter + gesture worker (prev/next, scroll, accept/reject diff).
- PostToolUse → SSE diff stream (surgical edits, not chat).

**Generalize** (RISE-specific → vault-level):
- Glossary enforcement → `.anchor/glossary.yml` per vault.
- Templates → `.anchor/templates/` per vault.

**Drop**: HoloBackground / R3F HUD (cute demo, no daily value). Hard-coded division/program lists. Next.js shell.

**Verification gate**: a 30-minute voice + gesture editing session produces a clean git commit with glossary violations flagged, and the user did not launch anchor-editor at all that week.

### Phase 5+ (deferred)

In likelihood order:
- **Multi-window** — lift `tolaria/src-tauri/src/window_state.rs`.
- **Conflict resolver** — when the first real merge conflict bites.
- **Public marketplace hosting** — when external user count exceeds 10.
- **Semantic search** — when keyword + relationships + git-grep are demonstrably insufficient.
- **NotebookLM bridge** — low priority.
- **Auto-updater** — once the deployed user count exceeds 2.

## Open decisions (input needed)

Items requiring the user's decision before further phases proceed:

1. **Vault cache trigger threshold** — warm scan is now 385ms (after rayon parallelism). Need to confirm perceived latency before scheduling the cache lift. Cold-cache measurement also needed.
2. **BlockNote ↔ raw default** — rich for general notes; raw for precision-sensitive editing such as the RISE proposal. Per-vault setting vs per-doc setting?
3. **Multi-tab UX** — close-with-dirty confirmation: Obsidian pattern (autosave) vs VS Code pattern (confirm)?
4. **Unresolved-wikilink behavior** — Phase 1A surfaces a soft notice. Phase 1B should pick: (a) red underline + create-new dialog, or (b) auto-stub note then open it.
5. **anchor MCP port** — 9710 (matches tolaria) or fall back to 9712/9713?
6. **anchor-editor archive timing** — archive immediately after the Phase 4 verification gate, or keep around for six months as reference?
7. **AI fallback API key storage** — Tauri stronghold plugin (macOS Keychain) is the recommendation; confirm operational fit.
8. **History shortcuts (lock-in)** — ⌘[ back / ⌘] forward (no browser conflict). Already shipped in Phase 1A; lock unless changing.

## Hard "No" list (v1)

Out of scope for v1 by explicit decision:

- Semantic / embedding search (keyword + wikilink + git-grep cover 10k notes).
- Cloud sync, anchor account, default telemetry (opt-in only).
- Mobile (Tauri 2 mobile is unstable; Obsidian owns mobile for now).
- Public marketplace server (no moderation policy).
- iMessage / Slack ingestion (permission pain > value).
- NotebookLM, podcast, slide export.
- Multi-user collab, CRDT, realtime (single user, single device, git for history).
- PDF annotation, OCR (file-extracted text is enough).
- Agent-autonomous edits (every Claude write goes through accept/reject diff).
- iCloud / Dropbox vault awareness (user's responsibility).
- Auto-updater (`pnpm tauri build` local builds only).

## Development

```bash
pnpm install

# Browser dev (mocked Tauri):
pnpm dev

# Native Tauri dev:
pnpm tauri:dev

# Type check:
pnpm typecheck

# Production build:
pnpm build

# Rust unit + integration tests:
cd src-tauri && cargo test

# Bench scan_vault on a real vault:
cd src-tauri && cargo test --release bench_scan_real_vault \
    -- --ignored --nocapture --test-threads=1
# → ANCHOR_BENCH_VAULT=/some/path overrides the default ~/workspace/work
```

## Vault layout

A vault is any folder containing `.md` (or `.markdown`, `.html`, `.htm`) files. anchor stores per-vault state at:

```
<vault>/
  .anchor/
    versions/        # snapshots created via the "Version" button
  .anchorignore      # optional, gitignore-style segment patterns
```

`.anchorignore` example for the user's `~/workspace/work`:

```
node_modules
.venv
dist
_sys/env
target
```

## Code lift map

Major deliverables come from existing, validated codebases — anchor is integration, not greenfield.

| Phase | Source | Destination | Type |
|-------|--------|-------------|------|
| 0 | `tolaria/src-tauri/src/frontmatter/{yaml,ops}.rs` | `src-tauri/src/frontmatter/` | line-edit, byte-identical |
| 0 | `tolaria/src-tauri/src/vault_list.rs` | `src-tauri/src/vault_list.rs` | multi-vault registry |
| 0 | `tolaria/src-tauri/src/vault/filename_rules.rs` | `src-tauri/src/filename_rules.rs` | NFC/NFD safety |
| 1A | `tolaria/src/utils/wikilinks.ts` | `src/lib/wikilinks.ts` | 255 LOC, verbatim |
| 1A | `tolaria/src/utils/wikilinkSuggestions.ts` | `src/lib/wikilinkSuggestions.ts` | adapted, +memo index |
| 1A | `tolaria/src/utils/neighborhoodHistory.ts` | `src/lib/neighborhoodHistory.ts` | adapted, in-memory only |
| 1A | `tolaria/src/components/InlineWikilinkSuggest.tsx` | `src/components/WikilinkAutocomplete.tsx` | IME-aware adapted |
| 1B | `tolaria/src-tauri/src/vault/cache.rs` (1,422 LOC) | `crates/anchor-vault/src/cache.rs` (planned) | wait until latency demands it |
| 1B | `tolaria/src-tauri/src/git/{status,commit}.rs` | `src-tauri/src/git.rs` (shell-out) | lightweight alternative to git2 |
| 1B | `tolaria/src/components/{Editor,RawEditorView,BlockNote*}.tsx` | `src/components/Editor*.tsx` | one-week budget, fragile |
| 1B | `tolaria/src/hooks/useEditorTabSwap.ts` (1,149 LOC) | `src/hooks/useEditorTabSwap.ts` | simplifiable |
| 1B | `tolaria/playwright.smoke.config.ts` | `e2e/` | smoke + flow tests |
| 2 | `tidy/app/electron/core/scheduler.js` | `crates/anchor-inbox/src/scheduler.rs` | JS → Rust rewrite |
| 2 | `tidy/app/electron/core/{parser,imap}.js` | `crates/anchor-inbox/src/{extract,imap}.rs` | Rust crates: lopdf, async-imap |
| 2 | `tidy/app/electron/ipc-handlers.js:20-109` | `crates/anchor-korean/src/date.rs` + `packages/korean-nl/` | Korean NL date split |
| 2 | `tolaria/src-tauri/src/{ai_agents,claude_cli}.rs` | `src-tauri/src/ai_router.rs` | SSE bridge, verbatim+adapt |
| 4 | `anchor-editor/services/whisper/server.py` | `services/whisper/` | Korean large-v3 |
| 4 | `anchor-editor/apps/web/lib/intent-fusion.ts` | `src/lib/intent-fusion.ts` | RISE-generic generalization |
| 4 | `anchor-editor/apps/web/workers/gesture.worker.ts` | `src/workers/gesture.worker.ts` | One-Euro filter |

**Principle**: tolaria's PKM code + tidy's inbox/AI code + anchor-editor's voice/gesture code, fused into one desktop app. The user's `~/.claude/skills/*` is read-only — anchor only invokes; never rewrites.

## Critical invariants

1. **Filesystem is authoritative.** The cache (`<vault>/.anchor/cache.db`, Phase 1B+) is disposable. React state is derived.
2. **Frontmatter key order + comments preserved.** A single-field patch must never disturb the order or comments of any other key (verified by cargo test).
3. **Crash-safe rename.** `.anchor-rename-txn/` staging dir + recovery on the next vault scan (Phase 1B).
4. **Dynamic relationship detection.** Any frontmatter field containing `[[wikilink]]` is treated as a relationship. No hard-coded field lists.
5. **Symlinks inside the vault are honored.** Deliberate user-created symlinks (e.g. `~/workspace/work/inbox/downloads → ~/gdrive-workspace/...`) are considered part of the vault. anchor uses lexical containment, not `canonicalize()`.

## License

UNLICENSED — internal RISE/Anchor work.

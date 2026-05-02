# Anchor

Local-first markdown vault desktop app. Tauri 2 + Rust + React 19 + TypeScript.

## Status (2026-05-01)

| Phase | State | Outcome |
|-------|-------|---------|
| 0 — Hardening | ✅ shipped | Open existing vaults safely. Frontmatter byte-identical round-trip. Multi-vault registry. ko/en parity. |
| 0.5 — UI polish | ✅ shipped | Topbar, sidebar with type filters + recents, command palette (⌘K), Pretendard Korean typography, light/dark. |
| 1A — Killer feature MVP | ✅ shipped | Doc-selection reliability, frontmatter inline edit (InspectorPane), wikilink autocomplete (Korean IME-aware) + click-to-navigate, typed neighborhood pane (project / mentions / peers), in-memory nav history (⌘[ / ⌘]). |
| 1B — Rich editor / git | ✅ feature-complete | Git status badge + commit-from-app (file list + per-file diff + syntax color + auto-refresh on focus). `scan_vault` rayon parallelism plus cache-backed warm startup for `~/workspace/work`: cached entries + active document render first, then authoritative scan reconciles in the background. Multi-tab editor (per-vault persistence, ⌘1..⌘8 select, ⌘W close, dirty stash). BlockNote rich + source + preview 3-way toggle (frontmatter line preserved). Browser smoke e2e is in place. **Deferred**: monorepo extraction. |
| 2 — Inbox + AI | 🚧 read-only surface live | Backend (polling, watcher, date parser, Claude CLI bridge, classifier, Gmail via `gws` CLI) + UI (`InboxPane` with parallel Files / Gmail sections, classify/accept/reject) all shipped. Accept/reject currently updates UI state only; file-move on accept + Gmail label-modify/archive remain. |
| 3 — Built-in Skills | 📋 planned | |
| 4 — Document Edit Mode | 📋 planned | |

## Next up (immediate)

Phase 2 has crossed the read-only boundary. The next work is the smallest safe write/apply loop:

1. **File accept action** — move accepted drops from `inbox/downloads/<source>/...` into the classifier's `suggestedFolder` when present; otherwise require a user-selected target. Keep all moves inside the vault boundary.
2. **Gmail accept/reject action** — call `gws` to apply Anchor labels and archive accepted mail. Rejected mail should be labelled or left unread until the policy is chosen.
3. **Keyboard accept loop** — add focused inbox selection plus `a` / `r` actions so the button-only UI becomes the promised one-keystroke flow.
4. **Real-vault verification** — verify dropped files, real chu.ac.kr unread mail, Claude classification, and accept/reject in one Tauri session.
5. **Phase 3 bridge prep** — reuse the Claude CLI event stream for command-palette skill invocation after the inbox apply loop is stable.

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
│   vault.rs       — walkdir + .anchorignore + cached scan      │
│   frontmatter/   — line-by-line YAML edit (preserves order)  │
│   document.rs    — read/save/create/version + field patch    │
│   git.rs         — status/commit/diff via shell-out          │
│   vault_list.rs  — multi-vault registry + active vault       │
│   filename_rules.rs — Korean NFC/NFD safety, Windows reserve │
│                                                               │
│   inbox.rs / inbox_watcher.rs / korean_date.rs               │
│   inbox_classifier.rs / gmail_gws.rs / ai_router.rs          │
│   Phase 3+: + skill_host.rs                                  │
│   Phase 4+: + whisper bridge / mcp lifecycle                 │
└──────┬─────────────────────────────────────────────────────┘
       │ stdio bridge + future WS/MCP bridges
┌──────▼────────┐ ┌────────────────────┐ ┌──────────────────┐
│ MCP server    │ │ User's Claude Code │ │ Whisper sidecar  │
│ (Node, Phase 3)│ │ CLI (~/.claude/skills/*)│ │ (Python, Phase 4)│
└───────────────┘ └────────────────────┘ └──────────────────┘
```

**Module boundary rules**:
- Rust core **owns** vault FS / cache / git / frontmatter / inbox scan/watch/classification / Gmail `gws` bridge / Claude CLI subprocess.
- React handles **only** BlockNote / command palette / neighborhood / gesture worker / AudioWorklet. No business logic.
- Node sidecar holds the MCP server + marketplace (Phase 3+).
- Python sidecar holds Whisper only (Phase 4). HWPX is delegated to the user's `hwpx` Claude Code skill — not rewritten.

## Roadmap

Each phase is defined in **outcomes the user actually exercises**. No phase exists just to grow infrastructure. The entry gate for each phase is the verification of the previous one.

### Phase 1B remaining (week 4–6)

**Outcome**: anchor is a first-class editor capable of carrying one project's meeting notes through a full week.

- [x] **BlockNote rich editor + raw + preview 3-way toggle** — `RichMarkdownEditor` wraps `@blocknote/mantine`; frontmatter line is preserved across rich↔source by splitting on the leading `---…---\n` block before parsing. Source tab is the textarea (with Korean IME-aware `[[` autocomplete). Preview tab is `marked` + DOMPurify. Round-trip on real notes still needs the Phase 1A verification pass.
- [x] **Single-window multi-tab editor** — per-vault `anchor:openTabs:v1` persistence, `EditorTab` discriminator, latest-wins selection, ⌘1..⌘8 to select by index, ⌘W to close active. Closing a dirty tab stashes the draft into the existing Phase 1A `discardedEdit` toast (Tauri webview swallows native `confirm()`, so the toast is the non-blocking equivalent).
- [x] **Vault cache** — lightweight JSON cache at `<vault>/.anchor/cache/vault-index-v1.json`. Startup reads the disposable cache first, restores only the active tab before first paint, then runs authoritative `scan_vault` in the background. Full scans also precompute version names once and reuse compiled regexes.
- [ ] **Monorepo extraction** — `crates/anchor-vault`, `crates/anchor-git`. Done at the seam between Phase 1B and Phase 2.
- [x] **Playwright smoke + e2e** — browser smoke covers sample-vault boot, multi-tab open, source tab, and preview tab. Broader inbox/native Tauri e2e still belongs to Phase 2 verification.

**Verification gate**: a full week of multi-tab work with project + meeting + people open simultaneously, daily commits, frontmatter preserved.

### Phase 2 — Inbox + AI (week 7–10)

**Outcome**: a "Today's inbox" view that ingests Gmail and dropped files (`inbox/downloads/`), Claude classifies and proposes actions, the user accepts with a single `a` keystroke.

**Shipped read-only surface**:

1. **Vault polling scan (✓ shipped)** — `scan_inbox_drop(vault_path)` walks `<vault>/inbox/downloads/{*}/...` and returns `InboxDropItem[]` (id, source, size, mtime).
2. **Filesystem watcher (✓ shipped)** — `notify` watches `<vault>/inbox/downloads/` and emits `inbox://file_event`; the frontend treats events as hints to re-run the cheap polling scan.
3. **Korean NL date parser (✓ shipped)** — pure Rust parser for phrases such as "내일", "다음 주 금요일", "3월 15일", and "오늘 오후 3시".
4. **Claude Code CLI subprocess bridge (✓ shipped)** — `start_claude_cli_invocation(prompt, cwd?, extra_args?)` spawns `claude -p` and streams `ai://output`, `ai://done`, and `ai://error`.
5. **Inbox classifier (✓ shipped)** — `build_inbox_classification_prompt(item)` + `parse_inbox_classification(raw)` with a closed category set (`task`/`reference`/`meeting`/`admin`/`noise`) and tolerant JSON parsing.
6. **Gmail via `gws` CLI (✓ shipped)** — Anchor shells out to `gws gmail +triage --format json` and exposes `fetch_gmail_unread(max?, query?) -> GmailMessage[]`.
7. **Inbox UI (✓ shipped)** — `InboxPane` shows parallel Files / Gmail sections and supports classify/accept/reject button actions.
8. **Browser smoke e2e (✓ shipped)** — Playwright verifies sample-vault boot, multi-tab editor open, source tab, and preview tab.

**Remaining write/apply work**:

1. **File accept** — move or route accepted files after user confirmation; reject must avoid destructive deletes.
2. **Gmail accept/reject** — apply labels/archive through `gws`; keep raw mail bodies out of logs and fixtures.
3. **One-keystroke loop** — focused row selection, `a` accept, `r` reject, and visible pending counts.
4. **Native Tauri e2e** — cover watcher events, Claude CLI success/failure, and Gmail CLI failure taxonomy.
5. **KakaoTalk macOS notification watcher (optional)** — still deferred while the full-disk-access prompt is avoidable.

**AI dispatch**:
- Primary: Claude Code CLI subprocess (user's Max plan, marginal cost $0).
- Fallback: Anthropic API (Haiku for classification, Sonnet for drafting).
- Streaming: tolaria `ai_agents.rs` SSE bridge.

**Skip in Phase 2**: iMessage DB, Slack, Outlook (Phase 3 wraps Outlook via the `ms-office` skill).

**Verification gate**: a real chu.ac.kr admin email or dropped file arrives → anchor classifies, extracts a task/date, and proposes a folder within 30 seconds → user presses `a` → item is moved/labelled without leaving the inbox session.

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

1. **Vault cache threshold** — shipped as a lightweight JSON index because `~/workspace/work` startup latency is dominated by the full initial pipeline, not only the Rust scan. Keep measuring cold scan and warm cache paint before lifting to a heavier database cache.
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

# Cold/warm startup expectation:
# 1. first scan creates <vault>/.anchor/cache/vault-index-v1.json
# 2. next app load renders cached entries + active document before the
#    background scan refreshes the index
```

## Vault layout

A vault is any folder containing `.md` (or `.markdown`, `.html`, `.htm`) files. anchor stores per-vault state at:

```
<vault>/
  .anchor/
    cache/           # disposable vault index for warm startup
    versions/        # snapshots created via the "Version" button
  .anchorignore      # optional, gitignore-style segment patterns
```

`.anchorignore` example for the user's `~/workspace/work`:

```
node_modules
.venv
dist
build
_sys/env
target
.next
.turbo
.cache
.anchor/cache
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
| 2 | n/a | `src-tauri/src/inbox.rs` + `src-tauri/src/inbox_watcher.rs` | polling scan + notify watcher |
| 2 | n/a (replaces tidy/imap.js) | `src-tauri/src/gmail_gws.rs` | shell out to user's `gws` CLI; no IMAP code |
| 2 | `tidy/app/electron/ipc-handlers.js:20-109` | `src-tauri/src/korean_date.rs` | Korean NL date parser |
| 2 | `tolaria/src-tauri/src/{ai_agents,claude_cli}.rs` | `src-tauri/src/ai_router.rs` | Tauri event stream bridge, adapted |
| 2 | n/a | `src-tauri/src/inbox_classifier.rs` + `src/lib/aiInvoke.ts` | prompt/parser + frontend orchestration |
| 4 | `anchor-editor/services/whisper/server.py` | `services/whisper/` | Korean large-v3 |
| 4 | `anchor-editor/apps/web/lib/intent-fusion.ts` | `src/lib/intent-fusion.ts` | RISE-generic generalization |
| 4 | `anchor-editor/apps/web/workers/gesture.worker.ts` | `src/workers/gesture.worker.ts` | One-Euro filter |

**Principle**: tolaria's PKM code + tidy's inbox/AI code + anchor-editor's voice/gesture code, fused into one desktop app. The user's `~/.claude/skills/*` is read-only — anchor only invokes; never rewrites.

## Critical invariants

1. **Filesystem is authoritative.** The cache (`<vault>/.anchor/cache/vault-index-v1.json`) is disposable. React state is derived.
2. **Frontmatter key order + comments preserved.** A single-field patch must never disturb the order or comments of any other key (verified by cargo test).
3. **Crash-safe rename.** `.anchor-rename-txn/` staging dir + recovery on the next vault scan (Phase 1B).
4. **Dynamic relationship detection.** Any frontmatter field containing `[[wikilink]]` is treated as a relationship. No hard-coded field lists.
5. **Symlinks inside the vault are honored.** Deliberate user-created symlinks (e.g. `~/workspace/work/inbox/downloads → ~/gdrive-workspace/...`) are considered part of the vault. anchor uses lexical containment, not `canonicalize()`.

## License

UNLICENSED — internal RISE/Anchor work.

# Anchor

Local-first markdown vault desktop app. Tauri 2 + Rust + React 19 + TypeScript.

## Status (2026-04-28)

| Phase | 상태 | Outcome |
|-------|------|---------|
| 0 — Hardening | ✅ shipped | Open existing vaults safely. Frontmatter byte-identical round-trip. Multi-vault registry. ko/en parity. |
| 0.5 — UI polish | ✅ shipped | Topbar, sidebar with type filters + recents, command palette (⌘K), Pretendard Korean typography, light/dark. |
| 1A — Killer feature MVP | ✅ shipped | Doc-selection reliability, frontmatter inline edit (InspectorPane), wikilink autocomplete (Korean IME-aware) + click-to-navigate, typed neighborhood pane (project / mentions / peers), in-memory nav history (⌘[ / ⌘]). |
| 1B — Rich editor / git | 🚧 부분 진행 | Git status badge + commit-from-app (file list + per-file diff + syntax color + auto-refresh on focus) ✅. `scan_vault` rayon 병렬화: 2.78s → 385ms on 7.1k files ✅. **BlockNote editor / multi-tab / vault cache / Playwright e2e — 미진행**. |
| 2 — Inbox + AI | 📋 계획 | |
| 3 — Built-in Skills | 📋 계획 | |
| 4 — Document Edit Mode | 📋 계획 | |

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
│  Rust Core (src-tauri/src/)                                  │
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

**모듈 경계 결정 원칙**:
- Rust core가 vault FS / cache / git / frontmatter / 인박스 스케줄러 / MCP 라이프사이클 / Claude CLI subprocess **소유**.
- React는 BlockNote / 명령 팔레트 / neighborhood / gesture worker / AudioWorklet **만** 담당. 비즈니스 로직 X.
- Node sidecar는 MCP 서버 + 마켓플레이스 (둘 다 Phase 2+).
- Python sidecar는 Whisper 만 (Phase 4). HWPX는 사용자의 `hwpx` Claude Code 스킬에 위임 (재작성 X).

## 향후 개발 계획

각 Phase는 **사용자가 실제로 쓸 수 있는 outcome** 단위. 인프라만 늘리는 phase 없음. Phase 진입 게이트는 직전 phase의 verification 통과.

### Phase 1B 잔여 (week 4–6)

**Outcome**: anchor가 한 프로젝트의 회의록을 일주일간 작성할 수 있는 first-class 편집 환경.

- [ ] **BlockNote rich editor + raw markdown 토글** — `tolaria/src/components/{Editor,RawEditorView,BlockNote*}.tsx` lift. 한국어 inline + KaTeX + 코드블록 round-trip.
- [ ] **단일 윈도우 multi-tab editor** — `tolaria/src/hooks/useEditorTabSwap.ts` (1,149 LOC) 단순화 lift. ⌘1/2/3 전환, 각 탭 dirty 독립.
- [ ] **Vault cache** — `tolaria/src-tauri/src/vault/cache.rs` (1,422 LOC) lift. **트리거 임계치 상향**: 385ms 단발 scan은 견딜 만하므로, BlockNote 통합 후 cold scan 측정 결과로 우선순위 재평가.
- [ ] **Monorepo 추출** — `crates/anchor-vault`, `crates/anchor-git`. Phase 2 진입 직전 정리.
- [ ] **Playwright smoke + e2e** — `tolaria/playwright.smoke.config.ts` lift.

**Verification gate**: 멀티 탭으로 project + 회의 + people 동시 열어두고 일주일 작업, 매일 commit, frontmatter 보존.

### Phase 2 — Inbox + AI (week 7–10)

**Outcome**: "오늘의 인박스" 뷰가 Gmail + 파일 드롭(`inbox/downloads/`)을 인제스트, Claude가 분류 + 액션 제안. 사용자 `a` 한 키로 accept.

**소스 우선순위**:
1. **Gmail (week 7–8)** — async-imap Rust 클라이언트. App password 인증, OS 권한 X.
2. **파일시스템 watcher (week 8)** — `~/workspace/inbox/downloads/{kakao,telegram,gmail,sharepoint}/`. 사용자 기존 ingest-chain 파이프라인 piggyback.
3. **KakaoTalk macOS 알림 watcher (week 10, optional)** — 풀 디스크 액세스 prompt 회피하려면 deferred.

**AI dispatch**:
- Primary: Claude Code CLI subprocess (사용자 Max plan, marginal cost $0)
- Fallback: Anthropic API (Haiku 분류, Sonnet 작성)
- Streaming: tolaria `ai_agents.rs` SSE bridge

**Skip in Phase 2**: iMessage DB, Slack, Outlook (Phase 3에서 `ms-office` 스킬로 wrap).

**Verification gate**: 본교 chu.ac.kr 행정 메일 수신 → anchor가 30초 내 분류 + task 추출 + 폴더 제안 → 사용자 `a` accept → 인박스 zero 한 세션 완주.

### Phase 3 — Built-in Skills (week 11–14)

**Outcome**: 사용자의 일상 ops 5개를 명령 팔레트에서 실행 (터미널 컨텍스트 스위치 X).

`runtime: claude-code` 가 v1 핵심 — 사용자의 `~/.claude/skills/*` 를 그대로 invoke. **재작성 0줄**.

5개 스킬:
1. **inbox-processor** — 인박스 항목 → 팔레트 → 스킬 실행 → diff 표시 + stage
2. **meeting-notes** — 팔레트 → `meetings/YYMMDD-*.md` 템플릿 생성 (Phase 4에서 voice 추가)
3. **task-management** — `_inbox/` 분석 → TASKS.md sync
4. **lint** — `/lint` 실행 → 인라인 리포트 (read-only, 자동 수정 X)
5. **hwpx-fill** — 템플릿 선택 → 필드 입력 → `.hwpx` 생성

**Verification gate**: 하루 안에 5개 모두 end-to-end 실행 (터미널 X). CLI 직접 실행과 출력 동일. 사용자 30분 이상 절약 보고.

### Phase 4 — Document Edit Mode (week 15–18)

**Outcome**: anchor 안의 dedicated 모드에서 음성 + 제스처로 RISE 사업계획서 편집. 기존 `dev/anchor-editor` 미사용.

**유지** (general-purpose 화):
- Whisper sidecar (Korean large-v3) — anchor-editor lift
- Intent fusion (음성 명령 → edit intent)
- One-Euro filter + gesture worker (prev/next, scroll, accept/reject diff)
- PostToolUse → SSE diff stream (chat 대신 surgical edit)

**일반화** (RISE-specific → vault-level):
- 용어집 enforcement → `.anchor/glossary.yml` per-vault
- 템플릿 → `.anchor/templates/` per-vault

**Drop**: HoloBackground / R3F HUD (cute demo, 일상 가치 X). 하드코딩 본부/사업 리스트. Next.js shell.

**Verification gate**: 30분 음성/제스처 편집 세션 + git commit clean + 용어 위반 flagged. anchor-editor 그 주 한 번도 launch 안 됨.

### Phase 5+ (deferred)

likelihood 순:
- **Multi-window** — `tolaria/src-tauri/src/window_state.rs` lift
- **Conflict resolver** — 첫 실제 merge conflict 발생 시
- **Marketplace 공개 호스팅** — 사용자 >10명 요청 시
- **Semantic search** — keyword + relationship + git-grep 부족 demonstrably 입증 시
- **NotebookLM bridge** — 낮은 우선순위
- **Auto-updater** — 배포 사용자 >2명일 때

## Open Decisions (사용자 결정 필요)

Phase 1B 이후 작업 진행 전 확정 필요한 항목:

1. **Vault cache 트리거 임계치** — 현재 warm scan 385ms (rayon 병렬화 후). 사용자 체감 latency 보고 후 cache 우선순위 결정. Cold scan 측정도 함께 필요.
2. **BlockNote ↔ raw 토글의 default** — 일반 노트는 rich, RISE 사업계획서 같은 정밀 편집은 raw. per-vault 설정 vs per-doc 설정 선택.
3. **Multi-tab UX** — 탭 닫기 confirm dirty 처리 (현재 단일 doc은 dismissable toast). Obsidian 패턴 (자동 저장) vs VS Code 패턴 (확인) 결정.
4. **Wikilink 미해결 처리** — Phase 1A는 soft notice. Phase 1B에서 (a) 빨간 underline + create-new dialog (b) 자동 stub 생성 후 편집 — 사용자 워크플로 확인 필요.
5. **anchor MCP 포트** — 9710 (tolaria 동일) 시 환경 충돌 검토. 9712/9713 fallback으로 충분한지.
6. **anchor-editor archive 시점** — Phase 4 verification gate 통과 후 즉시 archive vs 6개월 reference 보존?
7. **AI fallback API 키 보관 위치** — Tauri stronghold plugin (macOS Keychain) 권장하나 사용자 운영 환경 확인 필요.
8. **History 단축키 (확정)** — ⌘[ 뒤로 / ⌘] 앞으로 (브라우저 충돌 없음). Phase 1A에 적용됨. 변경 의사 없으면 lock.

## Hard "No" List (v1)

명시적으로 v1에서 안 할 것:

- Semantic/embedding 검색 (keyword + wikilink + git-grep으로 10k notes 충분)
- Cloud sync, anchor account, 기본 telemetry (opt-in only)
- Mobile (Tauri 2 mobile 불안정 — Obsidian이 mobile 담당)
- 공개 마켓플레이스 서버 (moderation 정책 부재)
- iMessage / Slack 인제스트 (권한 pain > value)
- NotebookLM, podcast, slide export
- Multi-user collab, CRDT, realtime (single user, single device, git for history)
- PDF annotation, OCR (file-extract 텍스트로 충분)
- Agent 자율 편집 (모든 Claude write는 accept/reject diff)
- iCloud/Dropbox vault 인지 (사용자 책임)
- Auto-updater (`pnpm tauri build` 로컬 빌드만)

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

A vault is any folder containing `.md` (or `.markdown`, `.html`, `.htm`)
files. anchor stores per-vault state at:

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

## Code Lift Map

각 phase 별 주요 lift 출처. anchor는 처음부터 새로 쓰지 않고 검증된 코드를 빌려 옵니다.

| Phase | 출처 | 대상 | 비고 |
|-------|------|------|------|
| 0 | `tolaria/src-tauri/src/frontmatter/{yaml,ops}.rs` | `src-tauri/src/frontmatter/` | line-edit, byte-identical |
| 0 | `tolaria/src-tauri/src/vault_list.rs` | `src-tauri/src/vault_list.rs` | multi-vault registry |
| 0 | `tolaria/src-tauri/src/vault/filename_rules.rs` | `src-tauri/src/filename_rules.rs` | NFC/NFD safety |
| 1A | `tolaria/src/utils/wikilinks.ts` | `src/lib/wikilinks.ts` | 255 LOC, verbatim |
| 1A | `tolaria/src/utils/wikilinkSuggestions.ts` | `src/lib/wikilinkSuggestions.ts` | adapted, +memo index |
| 1A | `tolaria/src/utils/neighborhoodHistory.ts` | `src/lib/neighborhoodHistory.ts` | adapted, in-memory only |
| 1A | `tolaria/src/components/InlineWikilinkSuggest.tsx` | `src/components/WikilinkAutocomplete.tsx` | IME-aware adapted |
| 1B | `tolaria/src-tauri/src/vault/cache.rs` (1,422 LOC) | `crates/anchor-vault/src/cache.rs` (planned) | latency 임계 시 |
| 1B | `tolaria/src-tauri/src/git/{status,commit}.rs` | `src-tauri/src/git.rs` (shell-out 채택) | git2 대신 가볍게 |
| 1B | `tolaria/src/components/{Editor,RawEditorView,BlockNote*}.tsx` | `src/components/Editor*.tsx` | 1주 budget, fragile |
| 1B | `tolaria/src/hooks/useEditorTabSwap.ts` (1,149 LOC) | `src/hooks/useEditorTabSwap.ts` | 단순화 가능 |
| 1B | `tolaria/playwright.smoke.config.ts` | `e2e/` | smoke + flow tests |
| 2 | `tidy/app/electron/core/scheduler.js` | `crates/anchor-inbox/src/scheduler.rs` | JS→Rust rewrite |
| 2 | `tidy/app/electron/core/{parser,imap}.js` | `crates/anchor-inbox/src/{extract,imap}.rs` | Rust crates: lopdf, async-imap |
| 2 | `tidy/app/electron/ipc-handlers.js:20-109` | `crates/anchor-korean/src/date.rs` + `packages/korean-nl/` | 한국어 NL date split |
| 2 | `tolaria/src-tauri/src/{ai_agents,claude_cli}.rs` | `src-tauri/src/ai_router.rs` | SSE bridge verbatim+adapt |
| 4 | `anchor-editor/services/whisper/server.py` | `services/whisper/` | Korean large-v3 |
| 4 | `anchor-editor/apps/web/lib/intent-fusion.ts` | `src/lib/intent-fusion.ts` | RISE-generic 화 |
| 4 | `anchor-editor/apps/web/workers/gesture.worker.ts` | `src/workers/gesture.worker.ts` | One-Euro filter |

**원칙**: tolaria 검증된 PKM 코드 + tidy 검증된 인박스/AI 코드 + anchor-editor 검증된 음성·제스처 코드를 한 데스크톱 앱으로 통합. 사용자의 `~/.claude/skills/*` 는 read-only — anchor가 invoke 만, 수정 X.

## Critical invariants

1. **Filesystem is authoritative.** 캐시(`<vault>/.anchor/cache.db`, Phase 1B+)는 disposable. React state는 derive.
2. **Frontmatter key order + comments preserved.** 단일 필드 patch는 다른 키의 순서·주석 절대 건드리지 않음 (cargo test로 검증).
3. **Crash-safe rename.** `.anchor-rename-txn/` staging dir + 다음 vault scan에서 복구 (Phase 1B).
4. **Dynamic relationship detection.** frontmatter 어떤 필드든 `[[wikilink]]` 포함하면 relationship으로 인식. 하드코딩 필드명 X.
5. **Symlinks inside vault are honored.** 사용자가 명시적으로 만든 vault 내 symlink (예: `~/workspace/work/inbox/downloads → ~/gdrive-workspace/...`)는 vault 안으로 간주. lexical containment 사용 (canonicalize 아님).

## License

UNLICENSED — internal RISE/Anchor work.

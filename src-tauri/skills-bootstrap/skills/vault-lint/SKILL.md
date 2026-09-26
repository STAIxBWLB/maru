---
name: vault-lint
trigger: /vault-lint
description: >
  work/ + vault/ 정합성 검증 리포트 생성. dead wiki-link, orphan note,
  스키마 위반, 명명규칙 위반, 스테일 seed, 로그 포맷 위반, 그래프 신선도 등 체크셋을
  실행하여 vault/reports/lint-YYMMDD.md로 리포트. vault 스코프는 결정적 스크립트
  (scripts/lint.py, 읽기 전용)가 판정하고 work 스코프는 에이전트가 검사. 자동 수정 하지 않음(제안만).
  트리거: vault-lint, /vault-lint, lint, 정합성 검사, 건강검진, vault lint, work lint,
  스키마 검사, 명명 검사, orphan 검사, 교차참조 검사, 린트
---

# /vault-lint 스킬

work/ + vault/ 정합성 검증 리포트 생성기. Karpathy "LLM Wiki Method"의 lint 단계를 구현한다.

## 기본 원칙

- **읽기 전용**: 자동 수정 하지 않는다. 제안만 한다.
- **리포트 출력 1곳**: `vault/reports/lint-YYMMDD.md`
- **log append**: `vault/log`에 `LINT` 이벤트 1줄 추가
- **vault 스코프 판정은 스크립트**: `scripts/lint.py`가 `notes/`·`log`·`reports/`를 **fs 읽기 전용**으로 스캔해
  L01·L02·L03·L09·L10·L11·L12를 판정한다(`lib/vault_adapter.md`의 결정적 스크립트 예외, `build-graph.py`와 동일).
  vault **쓰기**(리포트 노트)는 종전대로 MCP Obsidian만 사용.
- **work/ 접근**: Read / Grep / Glob (서브모듈 내부 깊이 검사는 위임)

## 호출 형식

```
/vault-lint [scope]
/vault-lint note=<notes/path.md>
```

| scope | 대상 |
|-------|------|
| `full` (기본) | vault + work 전체 |
| `vault` | vault/notes/ + vault/log |
| `work` | work/ 전체 (서브모듈 루트까지) |
| `inbox` | inbox summary 스키마 (L06) |
| `names` | 파일명 규칙만 (work/ + vault/) |
| `note=<path>` | 단일 vault note 품질·스키마 검증 |

## 체크셋 (L01-L12, 현행 11개 — L05·L11b는 2026-08-19 폐지)

`<ideation>` = `<paths.scratchpad>/<scratchpad.ideation_subdir>` (기본
`work/scratchpad/ideation`). 해석 절차는 `~/.maru/skills/_builtin/lib/scratchpad_adapter.md`.
임계값도 설정에서 읽는다 (`scratchpad.ideation_review_days`,
`scratchpad.temp_stale_days`).

| ID | 대상 | 내용 | 심각도 |
|----|------|------|--------|
| L01 | `vault/notes/` 본문 + frontmatter `topics:` | dead wiki-link (`[[x]]` 대상 부재). frontmatter는 `topics`/`project`/`projects` 등 wiki-link 값 필드 모두 포함 | **error** |
| L02 | `vault/notes/` | 필수 frontmatter 누락 (`type`, `topics`) + 허용값 이탈 (`type`, `confidence`, `status`) | **error** |
| L03 | `vault/notes/` | orphan (in-link 0, topics 0) | warn |
| L04 | `<ideation>/seeds/`, `vault/` ideation | `scratchpad.ideation_review_days` 초과 미갱신 seed | warn |
| L05 | — | **폐지 (2026-08-19)**. 입력이던 `inbox/INDEX.md`는 `inbox/_state/index.jsonl`(수신 영수증 로그)로 대체됐고 라우팅 영수증 정합성은 inbox-intake/inbox-process 소관 | — |
| L06 | `work/**/*-summary.md` (frontmatter 보유분) | 신 스키마 필수 필드 누락 (marker-based scope) | warn |
| L07 | `work/**/*` | `YYMMDD-type-desc.ext` 명명 위반 | warn |
| L08 | `work/**/*` | 한글 파일명 (macOS NFD) | **error** |
| L09 | `vault/log` | **미등록 TYPE**(정규 12종·정규화표 모두 없음)·구조 위반·라인 수 20k 초과만 warn. 정규화표 등재 legacy TYPE은 정보 1줄 | warn |
| L10 | `vault/notes/*` | `project:` frontmatter 값이 vault 노트(wiki-link)도, `project-registry.yaml` id도 아님 | warn |
| L11 | `vault/reports/` | graph report 7일 초과 stale (`graph-report-YYMMDD.md`) | warn |
| L12 | `vault/reports/vault-graph.json` | island community (cross-community edge 0개인 커뮤니티) — 멤버 목록으로 보고, 번호 인용 금지 | warn |

> L11b(workspace-graph 신선도)는 2026-08-19 폐지 — 질의 소비자가 없는 산출물이다(`_meta/rules/knowledge-graph-integration.md` §7). `--work-root` 빌드는 온디맨드로 남는다.

## 실행 절차

### 1단계: scope 해석

| scope | 활성 체크 |
|-------|----------|
| `full` | L01~L12 (L05 제외) |
| `vault` | L01, L02, L03, L09, L10, L11, L12 — 전부 `scripts/lint.py` |
| `work` | L06, L07, L08 |
| `inbox` | L06 |
| `names` | L07, L08 |
| `note=<path>` | L01·L02·L03·L10 (`--note`) + 단일 note quality gates |

### 2단계: vault 스코프 — 스크립트 실행 (L01, L02, L03, L09, L10, L11, L12)

```bash
~/.maru/env/.venv/bin/python3 ~/.maru/skills/vault-lint/scripts/lint.py \
  --vault <vault.path> --registry <workspace-root>/project-registry.yaml
# 단일 노트: --note notes/<x>.md   / 자체 점검: --self-test
```

- 표준출력 = 리포트 본문(markdown, L01~L12 섹션 + 정보 줄), 표준에러 = `SUMMARY errors=N warnings=M`
- 읽기 전용(fs). PyYAML로 frontmatter 파싱(블록 시퀀스·flow 배열·folded 스칼라 모두 처리 — 2026-08-19 L02 오탐 원인 제거)
- 판정 규칙(스크립트 구현, 문서는 요약):
  - **L01**: 본문 `[[x]]` + frontmatter wiki-link 필드(`topics`·`project`·`projects`·`supersedes`·`superseded_by`; alias `[[name|display]]`는 `name`만)가 `notes/<x>.md`로 해소되지 않으면 error. **MOC 정책**(2026-05-22): `topics:`는 MOC만 허용 — 키워드 wiki-link는 L01 error(동일 가드: vault-extract §Preconditions, vault_adapter §Summary To Vault Fields)
  - **L02**: `type` ∈ `insight | decision | observation | person | project | method | moc | reference`; `topics` 필수(단 `type: moc`는 `topics` 미요구 + `description` 필수); `confidence` ∈ `proven | likely | experimental`, `status` ∈ `active | superseded | archived` — **값이 있을 때만** 검사(없으면 통과). `status`는 노트 생애주기이지 사업 진행 상태가 아니다(작업 상태는 본문에). 정보 줄: `status: superseded` 건수(0이면 supersede 프로토콜 미가동 표시)
  - **L03**: topics 0 AND in-link 0 → orphan. **hub MOC `notes/index.md`는 예외**(3-tier 루트, 설계상 in-link·topics 없음). 도메인 MOC는 예외 아님
  - **L09**: 아래 §L09 참조
  - **L10**: `project:` 값이 `[[x]]`면 `notes/x.md` 실존, plain이면 registry id — 둘 다 아니면 warn
  - **L11**: 최신 `graph-report-YYMMDD.md`가 7일 초과/부재 → warn(`/vault-graph build` 권장)
  - **L12**: `vault-graph.json`에서 cross-community edge 0인 커뮤니티 → warn, **멤버 목록(≤10 + N more)으로 보고**. 커뮤니티 번호는 빌드 로컬이라 인용 금지(KG 규칙 §5.1). singleton은 정보 줄
- `note=<path>` 스코프: `--note`로 L01/L02/L03/L10을 해당 노트로 제한한 뒤, 에이전트가 note quality gates(description test·composability·source)를 추가 검토

### 3단계: work 스코프 — 에이전트 검사 (L04, L06, L07, L08)

- `work/project-registry.yaml`, `Glob work/**/*-summary.md` (L06), `Glob work/**/*` (L07, L08), `Glob <ideation>/seeds/*.md` (L04)

**L04 — stale seed**
1. `Glob <ideation>/seeds/*.md` + vault 쪽 ideation 노트 (있으면)
2. 각 파일 mtime 확인 (work은 Bash stat, vault은 MCP `get_notes_info`)
3. 현재 - mtime > `scratchpad.ideation_review_days`(기본 90) → 위반

**L06 — 신 스키마 불일치 (marker-based scope)**

`*-summary.md` 파일명은 inbox-process 출력뿐 아니라 사람이 직접 쓴 회고·리뷰·참고자료(`99-review/`, `06-refs/`, `drafts/`)에도 사용된다. inbox summary 스키마 강제는 inbox item에서 만든 파일에만 적용한다. **검사 대상 식별 marker는 frontmatter 존재 여부**.

1. `Glob work/**/*-summary.md`
2. 각 파일 Read → 첫 줄 `---` 확인
3. **`---` 없음 → 스킵** (inbox-process 출력 아님, 사람 손작업 회고/리뷰/refs 등)
4. `---` 있음 → frontmatter 파싱 → 필수 필드 누락 시 → warn
   - 필수: `title`, `received`, `type`, `project`
   - 출처 필수 (택1): `source` (inbox 경유) **또는** `source_url`/`source_detail_url` (웹 직접 참조). 둘 다 없으면 위반.
5. 구 포맷 H1 + `- **원본**:` 블록 검사는 폐기 (marker-based scope에서 자연 제외)

이렇게 정의하면 진짜 회귀(frontmatter 있는데 필드 누락)만 잡고, 사람이 만든 비-체인 summary는 자연스레 스코프 밖이다.

**L07 — 명명 규칙**
1. `Glob work/**/*` (서브모듈 제외, 예외 파일/경로 제외 — §Legacy Exemptions 참조)
2. 파일명이 `YYMMDD-[a-z0-9][a-z0-9-]*\.[a-z]+` 패턴에 맞는지
3. 예외: `README.md`, `AGENTS.md`, `CLAUDE.md`, `INDEX.md`, `.git*`, `_guides/*`, `_templates/*`, `templates/*`, 회의록(`YYMMDD-meeting-<slug>.md` 영문 패턴)
4. 패턴 위반 → 위반 (단 Legacy Exemptions 경로는 제외)

**L08 — 한글 파일명**
1. `Glob work/**/*` 결과에서 파일명 또는 경로에 `[가-힣]` 포함 여부
2. 있으면 → 위반
3. 예외 (§Legacy Exemptions 참조): `trips/**`, legacy 계약/MOU/연구 과제 경로
4. `meetings/**` 는 **무조건 면제하지 않는다**. 날짜 게이트 적용 (`_meta/rules/naming-and-placement.md` §A4 권위):
   legacy 회의록(mtime/파일명 날짜가 2026-05-26 이전, 또는 신규 `YYMMDD-meeting-<slug>.md` 패턴에 맞지 않는 한글 파일)만 면제하고,
   영문화 대상(2026-05-26 이후 신규 생성 또는 마이그레이션 대상)인 한글 회의록 파일명은 여전히 위반으로 플래그한다.

### Legacy Exemptions (L07, L08 공통)

Legacy exemptions are workspace policy, not skill-package policy. Load them from the workspace rules directory when available. If no workspace rule exists, use only generic defaults:

- hidden/runtime directories such as `.git`, `.github`, `.obsidian`, `.vscode`, `.cache`, `.venv`, `node_modules`, framework build folders, and secret stores
- generated inbox/drop or raw-source folders
- independent submodules or vendored repositories with their own naming conventions
- legally preserved originals such as contracts, signed documents, travel receipts, and external forms

These exemptions are not permission to create new badly named files. They only prevent noisy lint output for historical or tool-owned content.

**[G3] 표준 OSS 메타 파일 (filename allowlist, 어디서나 허용)**

L07 명명 규칙에서 다음 파일명은 위치 무관하게 통과 (한글 미포함이라 L08 영향 없음):

```
README.md, README, AGENTS.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md,
CHANGELOG.md, LICENSE, LICENSE.md, NOTICE, SECURITY.md,
CLAUDE.md, INDEX.md, _index.md,
package.json, package-lock.json, pnpm-lock.yaml, yarn.lock,
tsconfig.json, jsconfig.json, tsconfig.*.json,
requirements.txt, requirements*.txt, pyproject.toml, poetry.lock, setup.py, setup.cfg,
uv.lock, Cargo.toml, Cargo.lock, go.mod, go.sum,
Makefile, Dockerfile, docker-compose.yml, docker-compose.*.yml,
*.code-workspace,
.gitignore, .gitmodules, .gitattributes, .editorconfig, .nvmrc, .gitkeep,
.dockerignore, .npmignore, .eslintrc*, .prettierrc*,
.pre-commit-config.yaml, .coveragerc, .copier-config.yaml, .copierignore,
manifest.json, mkdocs.yml, _config.yml,
dependabot.yml, dependabot.yaml
```

**신규 파일 규칙은 변함없다**:
- 위 경로 밖 신규 파일은 L07/L08 error
- 위 경로 내 신규 파일이라도 에이전트가 생성한 것이라면 리뷰에서 반려
- Exemption은 과거 누적분 + 도구 상태 영역에 대한 pragmatic 처리

**L09 — 로그 포맷** (스코프 정본: `_meta/rules/ingest-chain.md` §"lint L09 스코프")

`vault/log`는 append-only라 과거 라인은 소급 수정할 수 없다. 따라서 warn은 **해결 가능한 신규 위반**에 한정한다:

1. **미등록 TYPE** — 정규 12종(`INGEST ROUTE EXTRACT CONNECT DIGEST LEARN LINT TASK GRAPH SYNC RETHINK SOURCE`)에도, 정규화표(`CREATE UPDATE MIGRATE REFACTOR MERGE MOVE RELOCATE RENAME DRAFT REVIEW RESEARCH REF CLEANUP CLOSE DONE SUPERSEDED DUPLICATE SKIP EDIT CORRECT`)에도 없는 TYPE
2. **구조 위반** — `YYYY-MM-DD HH:MM  TYPE  ...` 형태가 아닌 라인(불릿 접두, 시각 컬럼 누락 등; 경계 위반 라인도 여기서 잡힌다)
3. 라인 수 20k 초과 → "수동 아카이브 권장"

정규화표 등재 legacy TYPE은 warn이 아니라 **정보 1줄**(건수 + 최종 사용일 + "신규 발생 없음")로만 표기한다. 스크립트의 TYPE 목록은 규칙 파일과 keep-aligned 주석으로 묶여 있다 — 규칙 표를 바꾸면 `scripts/lint.py` 상수도 같이 고친다.

### 4단계: 리포트 생성

`vault/reports/lint-YYMMDD.md`를 `mcp__obsidian__write_note`로 생성. vault 스코프 섹션은 2단계 스크립트 출력을 그대로 붙이고, work 스코프 섹션(L04·L06·L07·L08)을 에이전트가 채운다:

```markdown
---
type: report
generated: YYYY-MM-DDTHH:MM
scope: full
summary:
  errors: N
  warnings: N
---

# Lint Report YYYY-MM-DD

## 요약

- error: N건
- warn: N건
- scope: full

## L01 — dead wiki-link (error, N건)

- `notes/foo.md`: `[[missing-target]]` → 대상 노트 없음. 추정: `[[foo-bar]]`
- ...

## L02 — 필수 frontmatter 누락 (error, N건)

- `notes/bar.md`: `type` 필드 없음
- ...

## L03 — orphan (warn, N건)

- `notes/baz.md`: in-link 0, topics 0

## L04 — stale seed (warn, N건)

- `work/scratchpad/ideation/seeds/2025-11-15-foo.md`: 146일 미갱신

## L06 — 신 스키마 불일치 (warn, N건)

- `work/projects/rise/admin/260101-report-summary.md`: frontmatter 없음 (구 포맷)

## L07 — 명명 규칙 (warn, N건)

- `work/projects/foo/Report Draft.md`: 공백 포함, 소문자 아님

## L08 — 한글 파일명 (error, N건)

- `work/projects/bar/보고서.pdf`

## L09 — 로그 포맷 (warn, N건)

- `log:42`: TYPE `FOO` 미등록 (정규 12종·정규화표 모두 없음)
- `log:1798`: 구조 위반 (불릿 접두, 시각 컬럼 누락)

정보: legacy TYPE 45건 (정규화표 등재), 최종 사용 2026-07-19, 신규 발생 없음

## L10 — project 미등록 (warn, N건)

- `notes/xyz.md`: `project: unknown-project` (registry 없음)

## L11 — graph report staleness (warn, N건)

- `vault/reports/graph-report-260406.md`: 7일 초과 (최신: 260406, 현재: 260413). `/vault-graph build` 재실행 권장

## L12 — island community (warn, N건)

- island community (2 notes): `soohyon-kim`, `ki-young-park` — `/vault-connect` 필요

nodes 446 / edges 2457 / communities 9; singleton 6개: `brain-personal-ai`, `christopher-manning`, ...

## 제안 조치

- L01: wiki-link 수정 또는 대상 노트 생성 (`/vault-extract`)
- L02: `~/.maru/skills/_builtin/lib/vault_adapter.md` 정책에 맞춰 frontmatter 보강
- L03: `/vault-connect` 재실행 또는 topics 추가
- L11: `/vault-graph build` 재실행으로 graph report 갱신
- L12: `/vault-connect` 재실행으로 island community 노트에 cross-community wiki-link 추가
- L06: 신 스키마로 점진 마이그레이션 (수동)
- L08: 파일명 영문화 (즉시 수정 권장)
```

### 5단계: log append

`vault/log`에 1줄 append:

```
YYYY-MM-DD HH:MM  LINT  -  vault/ + work/  — E errors, W warnings
```

append는 fs 직접 append(`>>`)로 수행. `vault/log`는 plain logfile(확장자 없음)로 vault MCP-only 쓰기 원칙의 유일 예외. 노트(.md) 쓰기는 종전대로 MCP 전용.

## 가드레일

- **자동 수정 금지**: 리포트만 생성. 수정은 사용자가 별도 스킬(`/vault-extract`, `/vault-connect`, `inbox-process`)로 실행.
- **vault 쓰기는 MCP Obsidian만**: `write_note`, `update_frontmatter`, `patch_note` 사용. 파일시스템 `Write`/`Edit` 금지. 읽기는 `scripts/lint.py`가 fs 읽기 전용으로 수행(결정적 스크립트 예외).
- **서브모듈 내부 깊이 검사 안 함**: 서브모듈은 해당 저장소의 자체 lint로 위임.
- **성능**: vault 스코프는 스크립트 1회 실행(456 노트 < 1초). work 스코프(L07/L08 `Glob work/**/*`)가 비용의 대부분이므로 필요 시 `/vault-lint vault`로 분리.
- **대용량 log**: L09가 라인 수 20k 초과 감지 시 "수동 아카이브 권장" warn만 추가 (자동 롤오버 안 함).
- **중복 리포트**: 같은 날 여러 번 실행 시 `vault/reports/lint-YYMMDD.md`를 덮어쓴다 (최신 상태 유지). 이력은 `vault/log`의 `LINT` 이벤트로 추적.

## 실행 빈도

- **주간**: `/vault-lint full` 1회 권장
- **수시**: 대규모 ingest 후 `/vault-lint vault`
- **CI 불가**: 로컬 vault 접근 필요하므로 CI 파이프라인 등록하지 않음

## 응답 원칙

1. **한국어 소통**
2. **실행 전 scope 확인**: 사용자에게 scope 선택 제시 (기본 full)
3. **진행 상황**: 각 체크 완료 시 한 줄 요약 (`L01: 0 error`)
4. **최종 요약**: error/warn 건수 + 리포트 경로 + log append 확인

## 관련 문서

- `_meta/rules/ingest-chain.md` — 체인 전체 그림과 log 포맷
- `~/.maru/skills/_builtin/lib/vault_adapter.md` — vault 접근·스키마 정책
- `~/.maru/skills/_builtin/lib/scratchpad_adapter.md` — scratchpad 경로·임계값 해석
- `~/.maru/skills/inbox-process/SKILL.md` — inbox processing skill
- `work/project-registry.yaml` — 프로젝트 id 단일 소스
- `~/.maru/skills/inbox-process/references/summary-schema.md` — 요약 스키마

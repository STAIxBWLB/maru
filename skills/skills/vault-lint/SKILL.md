---
name: vault-lint
trigger: /vault-lint
description: >
  work/ + vault/ 정합성 검증 리포트 생성. dead wiki-link, orphan note,
  스키마 위반, 명명규칙 위반, 스테일 seed, 로그 포맷 위반, 그래프 신선도 등 체크셋을
  실행하여 vault/reports/lint-YYMMDD.md로 리포트. 자동 수정 하지 않음(제안만).
  트리거: vault-lint, /vault-lint, lint, 정합성 검사, 건강검진, vault lint, work lint,
  스키마 검사, 명명 검사, orphan 검사, 교차참조 검사, 린트
---

# /vault-lint 스킬

work/ + vault/ 정합성 검증 리포트 생성기. Karpathy "LLM Wiki Method"의 lint 단계를 구현한다.

## 기본 원칙

- **읽기 전용**: 자동 수정 하지 않는다. 제안만 한다.
- **리포트 출력 1곳**: `vault/reports/lint-YYMMDD.md`
- **log append**: `vault/log.md`에 `LINT` 이벤트 1줄 추가
- **vault 접근**: MCP Obsidian 도구만 사용 (파일시스템 직접 접근 금지)
- **work/ 접근**: Read / Grep / Glob (서브모듈 내부 깊이 검사는 위임)

## 호출 형식

```
/vault-lint [scope]
/vault-lint note=<notes/path.md>
```

| scope | 대상 |
|-------|------|
| `full` (기본) | vault + work 전체 |
| `vault` | vault/notes/ + vault/log.md |
| `work` | work/ 전체 (서브모듈 루트까지) |
| `inbox` | inbox item manifests + inbox state receipts |
| `names` | 파일명 규칙만 (work/ + vault/) |
| `note=<path>` | 단일 vault note 품질·스키마 검증 |

## 체크셋 (12개)

| ID | 대상 | 내용 | 심각도 |
|----|------|------|--------|
| L01 | `vault/notes/` 본문 + frontmatter `topics:` | dead wiki-link (`[[x]]` 대상 부재). frontmatter는 `topics`/`project`/`projects` 등 wiki-link 값 필드 모두 포함 | **error** |
| L02 | `vault/notes/` | 필수 frontmatter 누락 (`type`, `topics`) | **error** |
| L03 | `vault/notes/` | orphan (in-link 0, topics 0) | warn |
| L04 | `work/ideation/seeds/`, `vault/` ideation | 90일 이상 미갱신 seed | warn |
| L05 | `inbox/INDEX.md` | destination 파일 부재 (라우팅 후 사라짐) | **error** |
| L06 | `work/**/*-summary.md` (frontmatter 보유분) | 신 스키마 필수 필드 누락 (marker-based scope) | warn |
| L07 | `work/**/*` | `YYMMDD-type-desc.ext` 명명 위반 | warn |
| L08 | `work/**/*` | 한글 파일명 (macOS NFD) | **error** |
| L09 | `vault/log.md` | 포맷 위반 라인 (컬럼 수, TYPE 집합, 라인 수 20k 초과) | warn |
| L10 | `vault/notes/*` | `project:` frontmatter 값이 vault 노트(wiki-link)도, `project-registry.yaml` id도 아님 | warn |
| L11 | `vault/reports/` | graph report 7일 초과 stale (`graph-report-YYMMDD.md`) | warn |
| L12 | `vault/reports/vault-graph.json` | island community (cross-community edge 0개인 커뮤니티) | warn |

## 실행 절차

### 1단계: scope 해석

| scope | 활성 체크 |
|-------|----------|
| `full` | L01~L12 모두 |
| `vault` | L01, L02, L03, L09, L10, L11, L12 |
| `work` | L06, L07, L08 |
| `inbox` | L05, L06 |
| `names` | L07, L08 |
| `note=<path>` | L02 + 단일 note quality gates |

### 2단계: 데이터 로드

공통:
- `work/project-registry.yaml` → 프로젝트 id 집합 (L10)
- `vault/notes/` 노트 목록 (`mcp__obsidian__list_directory`) (L01~L03, L09, L10)
- `vault/log.md` (`mcp__obsidian__read_note`) (L09)
- `inbox/INDEX.md` (Read) (L05)

scope별 추가:
- work: `Glob work/**/*-summary.md` (L06), `Glob work/**/*` (L07, L08)
- ideation: `Glob work/ideation/seeds/*.md` (L04)

### 3단계: 체크 실행

각 체크는 **위반 항목 리스트**를 반환한다.

**L01 — dead wiki-link (본문 + frontmatter)**
1. 모든 노트를 `mcp__obsidian__read_multiple_notes`로 읽기 (10개씩 배치)
2. **본문**에서 `[[x]]` 추출 (Regex: `\[\[([^\]]+)\]\]`)
3. **frontmatter**에서 wiki-link 값 추출 — 검사 대상 필드:
   - `topics:` array (inline `[...]` + multiline `- [[...]]` 모두)
   - `project:` 단일 값 (`[[x]]` 형식인 경우)
   - 기타 wiki-link을 값으로 받는 필드 (예: `projects:`, alias `[[name|display]]` 의 `name` 부분만 검사)
4. 추출한 `x` (alias `[[name|display]]` 의 `name` 부분만)가 `vault/notes/<x>.md` 또는 vault MOC에 존재하는지 확인
5. 미존재 → 위반 (노트 경로, 링크 위치 `body|topics|project`, 링크 텍스트, 추정 의도)

> **MOC 정책 강제** (2026-05-22 도입): `topics:`는 MOC만 허용 (`vault/CLAUDE.md §Schema`). 일반 키워드 wiki-link(`[[credit-recognition]]`, `[[partnership-mapping]]` 등)는 L01 error. 동일 가드는 vault-extract SKILL.md §Preconditions와 vault_adapter.md §Summary To Vault Fields에 명시.

**L02 — 필수 frontmatter**
1. 각 노트 `mcp__obsidian__get_frontmatter`
2. `type` 없거나 허용값이 아니면 → 위반 (`insight | decision | observation | person | project | method | moc | reference`)
3. `topics` 없거나 빈 배열이면 → 위반
4. **예외 (hub MOC)**: `type: moc` 인 노트는 `topics` 미요구 — domain/topic hub 자체이므로 self-loop 회피. 단 `type: moc` 노트는 `description` 필드 필수 (hub의 역할 명시).

**L03 — orphan**
1. 각 노트의 `topics` 배열 크기 확인
2. 각 노트에 대한 in-link 수 계산 (L01 스캔 결과 역방향)
3. topics 0개 AND in-link 0 → orphan

**L04 — stale seed**
1. `Glob work/ideation/seeds/*.md` + vault 쪽 ideation 노트 (있으면)
2. 각 파일 mtime 확인 (work은 Bash stat, vault은 MCP `get_notes_info`)
3. 현재 - mtime > 90일 → 위반

**L05 — destination 부재**
1. `inbox/INDEX.md` 파싱 → (status, destination) 추출
2. `status: routed`인 항목의 `destination` 경로 존재 확인 (Glob)
3. 미존재 → 위반

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
3. 예외: `README.md`, `CLAUDE.md`, `INDEX.md`, `.git*`, `_guides/*`, `_templates/*`, `templates/*`, 회의록(`MM-DD [회의유형]` 한글 패턴)
4. 패턴 위반 → 위반 (단 Legacy Exemptions 경로는 제외)

**L08 — 한글 파일명**
1. `Glob work/**/*` 결과에서 파일명 또는 경로에 `[가-힣]` 포함 여부
2. 있으면 → 위반
3. 예외 (§Legacy Exemptions 참조): `meetings/**`, `trips/**`, legacy 계약/MOU/연구 과제 경로

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

**L11 — graph report staleness**
1. `Glob vault/reports/graph-report-*.md` — 가장 최신 파일 찾기
2. 파일명에서 날짜 추출 (`YYMMDD`)
3. 현재 날짜 - 파일 날짜 > 7일 → warn "graph report stale, run `/vault-graph build`"
4. 파일 없음 → warn "graph report 없음, 첫 빌드 필요: `/vault-graph build`"

**L12 — island community**
1. `vault/reports/vault-graph.json` 존재 확인. 없으면 스킵 (L11에서 이미 경고)
2. JSON 로드 → NetworkX graph 복원 (`json_graph.node_link_graph`)
3. 커뮤니티 속성(`community`)별 노드 그룹핑
4. 각 커뮤니티에 대해: 다른 커뮤니티로의 edge 수 계산
5. cross-community edge 0개인 커뮤니티 → warn "island community: 멤버 N개, `/vault-connect` 필요"
6. 싱글톤 커뮤니티(1 note)는 별도 카운트: "N개 singleton — MOC에만 연결된 고립 노트"

**L09 — 로그 포맷**
1. `vault/log.md` 각 라인 파싱
2. 컬럼 구조 검증 (`datetime TYPE project path — note`)
3. TYPE이 고정 집합에 속하는지
4. 라인 수 20k 초과 시 "수동 아카이브 권장" 경고 추가

**L10 — project 값 검증**

vault/CLAUDE.md schema는 `project:` 필드를 wiki-link로 정의(`projects: project (wiki link), alternatives, ...`). 동시에 work-side `project-registry.yaml`의 id도 historical 호환을 위해 허용한다. 두 형식 모두 정합으로 처리.

1. `get_frontmatter`로 각 노트의 `project` 값 수집 (null/missing은 통과)
2. 값이 `[[note-name]]` 형식이면 → vault `notes/<note-name>.md` 실존 확인 → 있으면 통과
3. 값이 plain string이면 → `work/project-registry.yaml`의 id 집합과 대조 → 있으면 통과
4. 둘 다 아니면 위반 (alias `[[note|alias]]` 형식은 `note` 부분만 추출하여 검사)

위반 분류:
- `[[x]]` 형식이지만 대상 노트 없음 → "dead wiki-link in project field"
- plain string이지만 registry id 아님 → "unregistered project id"

### 4단계: 리포트 생성

`vault/reports/lint-YYMMDD.md`를 `mcp__obsidian__write_note`로 생성:

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

- `work/ideation/seeds/2025-11-15-foo.md`: 146일 미갱신

## L05 — destination 부재 (error, N건)

- `inbox/INDEX.md` entry `2026-03-15 routed → projects/X/`: 경로 존재하지 않음

## L06 — 신 스키마 불일치 (warn, N건)

- `work/projects/rise/admin/260101-report-summary.md`: frontmatter 없음 (구 포맷)

## L07 — 명명 규칙 (warn, N건)

- `work/projects/foo/Report Draft.md`: 공백 포함, 소문자 아님

## L08 — 한글 파일명 (error, N건)

- `work/projects/bar/보고서.pdf`

## L09 — 로그 포맷 (warn, N건)

- `vault/log.md:42`: TYPE `FOO` 미등록

## L10 — project 미등록 (warn, N건)

- `notes/xyz.md`: `project: unknown-project` (registry 없음)

## L11 — graph report staleness (warn, N건)

- `vault/reports/graph-report-260406.md`: 7일 초과 (최신: 260406, 현재: 260413). `/vault-graph build` 재실행 권장

## L12 — island community (warn, N건)

- Community 10 (2 notes): cross-community edge 0. 멤버: `soohyon-kim`, `ki-young-park`. `/vault-connect` 필요
- Singleton 6개: `brain-personal-ai`, `christopher-manning`, ... (MOC에만 연결)

## 제안 조치

- L01: wiki-link 수정 또는 대상 노트 생성 (`/vault-extract`)
- L02: `_sys/skills/lib/vault_adapter.md` 정책에 맞춰 frontmatter 보강
- L03: `/vault-connect` 재실행 또는 topics 추가
- L05: `inbox/INDEX.md` 엔트리 정리 또는 destination 복원
- L11: `/vault-graph build` 재실행으로 graph report 갱신
- L12: `/vault-connect` 재실행으로 island community 노트에 cross-community wiki-link 추가
- L06: 신 스키마로 점진 마이그레이션 (수동)
- L08: 파일명 영문화 (즉시 수정 권장)
```

### 5단계: log append

`vault/log.md`에 1줄 append:

```
YYYY-MM-DD HH:MM  LINT  -  vault/ + work/  — E errors, W warnings
```

append는 `mcp__obsidian__patch_note(path: "log.md", operation: "append", ...)` 또는 동등한 방법으로 수행. 파일시스템 직접 쓰기 금지.

## 가드레일

- **자동 수정 금지**: 리포트만 생성. 수정은 사용자가 별도 스킬(`/vault-extract`, `/vault-connect`, `inbox-process`)로 실행.
- **vault 쓰기는 MCP Obsidian만**: `write_note`, `update_frontmatter`, `patch_note` 사용. 파일시스템 `Write`/`Edit` 금지.
- **서브모듈 내부 깊이 검사 안 함**: 서브모듈은 해당 저장소의 자체 lint로 위임.
- **성능**: 노트 1000개 이하 기준. 초과 시 L01/L03 비용 증가 → 체크 분리 실행 권장 (`/vault-lint vault` 등).
- **대용량 log.md**: L09가 라인 수 20k 초과 감지 시 "수동 아카이브 권장" warn만 추가 (자동 롤오버 안 함).
- **중복 리포트**: 같은 날 여러 번 실행 시 `vault/reports/lint-YYMMDD.md`를 덮어쓴다 (최신 상태 유지). 이력은 `vault/log.md`의 `LINT` 이벤트로 추적.

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

- `_sys/rules/ingest-chain.md` — 체인 전체 그림과 log.md 포맷
- `_sys/skills/lib/vault_adapter.md` — vault 접근·스키마 정책
- `_sys/skills/skills/inbox-process/SKILL.md` — inbox processing skill
- `work/project-registry.yaml` — 프로젝트 id 단일 소스
- `_sys/skills/skills/inbox-process/references/summary-schema.md` — 요약 스키마

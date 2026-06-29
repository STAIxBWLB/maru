---
name: hwpx
description: >
  한국 공문서 스타일의 HWPX 문서 작성·편집 스킬. 공문서, 기안문(내부결재/대외시행),
  사업계획서, 보고서, 회의록 템플릿 + {{anchor}} 치환 기반 문서 생성. 생성·변환·렌더는
  hwp-cli(Rust) 네이티브에 위임(읽기·편집·검증·HTML·텍스트선택 PDF), 슬롯/구조 편집은 lxml.
  MVP는 템플릿 채우기 중심.
  트리거: hwpx, 공문, 공문서, 기안문, 결재문서, 내부결재, 대외시행, 사업계획서, 보고서,
  회의록, 한글 문서 작성, .hwpx 생성/수정, 공문 써줘, 기안문 만들어줘, 한컴 문서
  사용하지 않음: 바이너리 .hwp 직접 파싱 (→ hwp-cli; read는 자동 위임), .docx (→ docx 스킬), .pdf
---

# hwpx — HWPX 공문서/기안문 authoring toolkit

## Overview

HWPX는 한/글(Hancom Office)의 **XML 기반 공식 포맷**이며, 2021년부터 대한민국 정부 공문서의 법정 저장 형식이다. 내부 구조는 zip + OWPML(Open Word-Processor Markup Language, KS X 6101). 이 스킬은 raw ZIP/XML 처리(lxml, 슬롯·구조 편집)와 hwp-cli(Rust) 네이티브 위임(생성·변환·렌더·검증)을 사용하여 다섯 가지 작업 경로를 지원한다:

1. **양식 따라가기 (`styled --reference`)** — 주어진 공식 양식 파일의 폰트·여백·스타일을 그대로 사용하여 본문만 채움. 사업 공고 HWP 양식이 있을 때 최우선 경로.
2. **보기 좋은 신규 생성 (`styled --preset`)** — 양식이 없을 때 공문서 표준에 맞춘 폰트·여백·줄간격·헤더/푸터·페이지번호로 깔끔한 문서를 생성.
3. **템플릿 채우기 (`fill`)** — 내장 `templates/*.hwpx`의 `{{anchor}}` 치환. 기안문/사업계획서 뼈대 사용.
4. **편집** (`edit`, `edit-section`, `unpack`+`repack`) — 기존 문서 수정.
5. **레퍼런스 양식 복원·편집 (`analyze` → `fill`/`edit-section` → `validate` → `guard`)** — 첨부된 임의 공문 양식의 서식·구조를 보존하며 본문만 안전하게 교체하는 권장 경로. 아래 "robust 편집 엔진" 참조.

### robust 편집 엔진 (`scripts/hwpx_xml.py`)

`edit`/`edit-section`/`fill-form`/`analyze`/`guard`/`styled --reference`는 직렬화 문자열 치환이 아니라 **lxml 트리 편집 엔진**을 쓴다(`fill`·`slots`는 충실도 보존을 위해 hwp-cli `fill`/`slots`에 위임). 핵심 보장:
- **run 경계를 넘나드는 `{{anchor}}`도 매칭** (`<hp:t>` 텍스트를 연결해 치환, 앵커 밖 run·서식은 보존).
- **`<hp:linesegarray>` 자동 삭제** — 텍스트 수정 후 줄배치 캐시를 지워 글자 겹침 방지(한글이 열 때 재계산).
- **sec 직계자식 인덱스 기반** 섹션 경계 처리 (텍스트 검색 아님), **deepcopy 참조 단락 복제**, mimetype-first STORED 재패키징.
- 편집 엔진 의존성은 lxml뿐 (python-hwpx·번들 Java 미사용). 생성·변환·렌더는 hwp-cli 위임.

바이너리 `.hwp`(v5 OLE2 포맷)의 읽기·변환은 **hwp-cli**(Rust 단일 바이너리 `hwp`)로 처리한다 — `./hwpx read legacy.hwp`가 자동 위임. 이 스킬 자체는 HWPX 작성·편집 전용.

## Quick Reference

| 작업 | 명령 |
|------|------|
| 읽기 (markdown) | `./hwpx read <file.hwpx>` (text/md는 hwp-cli `cat` 우선·lxml 폴백) |
| 메타 요약 | `./hwpx summary <file.hwpx>` |
| 구조화 JSON | `./hwpx read <file.hwpx> --format json` |
| **보기 좋은 생성 (양식 없음)** | `./hwpx styled --preset gongmun --markdown <md> -o <out>` |
| **양식 따라가기** | `./hwpx styled --reference <양식.hwpx> --markdown <md> -o <out>` |
| 템플릿 채우기 (run-aware) | `./hwpx fill <template> --kv key=value -o out.hwpx` |
| find/replace (run-aware) | `./hwpx edit <in> <out> --replace OLD NEW` |
| **편집 청사진 (sec 인덱스 맵)** | `./hwpx analyze <file.hwpx>` |
| **본문 단락 범위 교체** | `./hwpx edit-section <file> --start N --end M --lines lines.txt -o out` |
| **라벨-값 양식 채우기** | `./hwpx fill-form <form> --kv 성명=홍길동 --kv 소속=… -o out` |
| **드리프트 게이트 (레이아웃 보존 검증)** | `./hwpx guard --reference <ref> --output <out>` |
| unpack → XML 직접 편집 | `./hwpx unpack <file> <dir>` → `./hwpx repack <dir> <out>` |
| 단순 신규 생성 | `./hwpx create <out> --title T --body "1줄\n2줄"` (→ hwp-cli new) |
| markdown → HWPX (레거시 별칭) | `./hwpx write-java <out> --markdown <md>` (→ hwp-cli new) |
| 검증 | `./hwpx validate <file.hwpx>` |
| PDF 변환 | `./hwpx to-pdf <file.hwpx>` (기본 hwp-cli 네이티브 **텍스트 선택가능** PDF; `--engine soffice` 폴백) |

경로 기준: `~/.anchor/skills/hwpx/hwpx`

## 한국 공문서 작성 규정 (핵심 cheat sheet)

근거: 「행정 효율과 협업 촉진에 관한 규정 시행규칙」 별표 서식. 상세는 `references/korean-official-format.md`.

| 항목 | 규정 |
|------|------|
| 용지 | A4 세로 |
| 여백 | 위 30mm / 아래 15mm / 왼쪽 20mm / 오른쪽 15mm |
| 본문 폰트 (기안문 현행) | **맑은 고딕 11.5pt**, 장평 100, 자간 0 |
| 본문 폰트 (보고서 전통) | **휴먼명조 15pt** 또는 함초롬바탕 15pt |
| 줄간격 | **160%** |
| 종결 방식 | **개조식** (명사형: "~함", "~임", "~할 것") — 상세는 `gaejosik` 스킬 |
| 번호 체계 | **4단계**: `1.` → `가.` → `1)` → `가)` |
| 붙임 표기 | "붙임  1. 파일명 1부." + 마지막에 "**끝.**" |
| 페이지 번호 | 하단 중앙, "n/총페이지" 또는 숫자만 |
| 관인(직인) | **전자결재 시스템이 자동 삽입** — 스킬이 생성하지 않음 |

## 1. 보기 좋은 문서 생성 (`styled`) — 권장 기본 경로

사용자가 공문서·결재문서·사업계획서·보고서를 "**만들어달라**"고 요청할 때의 기본 명령. `docx` 스킬처럼 폰트·여백·줄간격·헤더/푸터·페이지번호가 설정된 완성형 HWPX를 생성한다.

### 1-A. 양식 파일이 주어진 경우 (`--reference`)

사업 공고에 첨부된 HWP 양식(예: `2026_사업계획서_양식.hwpx`)이 있으면 그 **양식의 폰트·여백·스타일을 그대로 물려받아** 본문만 채운다. 가장 안전한 경로.

```bash
./hwpx styled \
  --reference 2026_사업계획서_양식.hwpx \
  --markdown 사업계획.md \
  --footer "- # / ## -" \
  -o 최종_사업계획서.hwpx
```

양식이 `.hwp` (바이너리)이면 먼저 Hancom Office에서 열어 `.hwpx`로 저장해달라 요청하거나, `hwp convert 양식.hwp -o 양식.hwpx --to hwpx`로 변환 후 사용.

### 1-B. 양식이 없는 경우 (`--preset`)

두 가지 프리셋 제공:

| 프리셋 | 본문 폰트 | 본문 크기 | 줄간격 | 주 용도 |
|--------|-----------|-----------|--------|---------|
| `gongmun` | **맑은 고딕** | 11.5pt | 160% | 공문·기안문 (현행 표준) |
| `bogoseo` | **함초롬바탕** | 15pt | 160% | 보고서·사업계획서 (전통) |

공통 적용: A4 세로, 여백 30·15·20·15mm, 가운데 정렬 제목·소제목, 좌측정렬 본문, 굵기 있는 소제목.

```bash
# 공문·기안문
./hwpx styled --preset gongmun \
  --markdown 기안문.md \
  --header "예시대학교 AI학과" \
  --footer "- # / ## -" \
  -o out.hwpx

# 사업계획서·보고서
./hwpx styled --preset bogoseo \
  --markdown 사업계획.md \
  --header "2026 regional innovation 사업계획서" \
  --footer "- # -" \
  -o out.hwpx
```

### 입력 markdown 규칙

단순한 문법을 지원한다:

```
# 대제목            → 가운데 정렬, bold, 큰 글씨
## 소제목 (H1)       → 좌측 정렬, bold
### 작은제목 (H2)    → 좌측 정렬, bold, 본문보다 약간 큼
---                  → 빈 줄 (구분선)
(빈 줄)              → 구분선
기타 모든 줄         → 본문 단락 (들여쓰기 유지 → 4단계 번호 그대로 표현)
```

예시 (보고서):

```markdown
# 2026학년도 AI 교육센터 운영계획

## I. 추진 배경
1. 제주 regional innovation 체계 전환에 따른 대학 역할 재정립 필요함
2. international cooperation-TIU 사업과 연계로 글로벌 확장성 확보 가능함

## II. 주요 추진 내용
1. 교과목 개편
  가. AI 기초·심화 커리큘럼 재설계함
  나. 산업 실무 프로젝트 통합함

붙임  1. 운영계획 상세(안) 1부.  끝.
```

### 머리글 / 바닥글 (header / footer)

- `--header "텍스트"` — 상단 머리글 (가운데 정렬)
- `--footer "템플릿"` — 하단 바닥글. `#`는 현재 쪽, `##`는 전체 쪽수 placeholder
- 기본 footer: `- # / ## -` (예: "- 1 / 3 -")
- footer 끄기: `--footer ""`

**페이지 번호 동작**: `#` / `##`는 플레이스홀더다. Hancom Office에서 파일을 연 후 **삽입 → 쪽 번호** 메뉴로 변환하면 자동 갱신된다. LibreOffice+H2Orestart로 렌더하면 리터럴 "#" / "##"로 표시되므로 PDF 변환 전에는 Hancom에서 한 번 열어 변환을 권장.

### JSON 입력

markdown 대신 구조화된 JSON으로 넘기려면:

```bash
cat > plan.json <<'EOF'
{
  "title": "2026 사업계획서",
  "subtitle": "제주 regional innovation AI 인재양성",
  "blocks": [
    {"kind": "heading", "text": "I. 사업 개요", "level": 1},
    {"kind": "para", "text": "1. 사업명: ..."},
    {"kind": "separator"},
    {"kind": "heading", "text": "II. 추진 배경", "level": 1},
    {"kind": "para", "text": "가. 제주 지역 AI 인재 수급 미스매치 해소 필요함"}
  ]
}
EOF
./hwpx styled --preset bogoseo --json plan.json -o plan.hwpx
```

stdin으로도 가능: `... | ./hwpx styled --preset gongmun --stdin-json -o out.hwpx`

### 폰트 커스터마이징 / 기관 양식 준수

프리셋 폰트가 기관 요건에 맞지 않으면 두 가지 경로:

1. **양식 따라가기** (권장): 기관의 정식 양식 `.hwpx`에 `{{본문}}`, `{{제목}}` 같은 slot을 넣고 `--reference`로 넘김
2. **생성 후 수정**: Hancom Office에서 열어 `서식 → 글자 모양`으로 수정

현재 hwp-cli `new` 생성 경로는 단락 중심 MVP다. 정교한 표·이미지·기관별 폰트/여백은 기관 양식 파일을 기준으로 slot 치환하거나 Hancom Office에서 최종 검수한다.

## 2. 템플릿 채우기 (`fill`)

### 기본 템플릿

| 파일 | 용도 |
|------|------|
| `templates/공문서_기본.hwpx` | 대외시행 공문 기본형 (수신/경유/제목/본문/붙임/발신명의) |
| `templates/기안문_내부결재.hwpx` | 내부결재 (결재란 자리 표시 + 기안자/협조자/시행번호) |
| `templates/기안문_대외시행.hwpx` | 대외시행 공문 (수신자 + 관인 자리 + 접수번호) |
| `templates/보고서_일반.hwpx` | 휴먼명조/개조식 보고서 (배경/내용/계획/행정사항) |
| `templates/사업계획서_기본.hwpx` | 9-section skeleton (개요/배경/목표/세부내용/일정/예산/효과/지표/붙임) |
| `templates/회의록.hwpx` | 참석자/안건/논의/결정사항/후속조치/차기회의 |

### 공통 anchor 명

모든 템플릿이 공유하는 placeholder (없는 템플릿은 무시됨):

```
{{기관명}} {{수신}} {{경유}} {{제목}} {{본문}} {{붙임}} {{발신명의}}
{{기안자}} {{기안자직위}} {{검토자}} {{협조자}} {{결재자}}
{{시행번호}} {{시행일자}} {{접수번호}} {{접수일자}}
{{주소}} {{홈페이지}} {{전화}} {{팩스}} {{이메일}} {{공개구분}}
```

템플릿별 추가 anchor는 템플릿 자체를 `./hwpx read`로 확인.

### 사용 예

**방법 1 — `--kv` 플래그 (간단한 경우)**:
```bash
./hwpx fill templates/기안문_내부결재.hwpx \
  --kv 기관명="예시대학교" \
  --kv 제목="AI 교육센터 운영계획(안)" \
  --kv 본문="1. 목적
  가. 2026학년도 AI 교육센터 운영 방향 확립함
2. 추진계획
  가. 상반기 교과목 개편함" \
  --kv 붙임="운영계획 상세(안) 1부" \
  --kv 발신명의="AI학과장" \
  -o /tmp/gianmun.hwpx
```

**방법 2 — JSON 파일**:
```bash
cat > data.json <<'EOF'
{
  "기관명": "예시대학교",
  "제목": "…",
  "본문": "1. 목적\n  가. …",
  "붙임": "…",
  "발신명의": "AI학과장"
}
EOF
./hwpx fill templates/기안문_내부결재.hwpx --data data.json -o out.hwpx
```

**방법 3 — stdin JSON (다른 도구와 파이프)**:
```bash
echo '{"제목":"테스트","본문":"본문"}' | \
  ./hwpx fill templates/공문서_기본.hwpx --stdin-json -o out.hwpx
```

출력 문서는 반드시 `./hwpx validate` 통과시킬 것.

## 3. 읽기와 분석

```bash
./hwpx read report.hwpx              # markdown (기본)
./hwpx read report.hwpx --format text
./hwpx read report.hwpx --format json  # 섹션/단락/이미지 구조화
./hwpx summary report.hwpx            # 메타데이터 요약
./hwpx to-md report.hwpx -o out.md    # markdown 파일로 저장
```

`inbox-process` 추출 단계에서 이 명령으로 `.hwpx` 내용 추출에 사용된다.

## 4. 편집

### 단순 find/replace (run-aware)

```bash
./hwpx edit input.hwpx output.hwpx --replace "OLD" "NEW"
./hwpx edit input.hwpx output.hwpx --replace "구버전" "신버전" --limit 1
```

lxml 엔진이 `<hp:t>` 텍스트를 연결해 치환하므로 **run 경계를 넘나드는 텍스트도 매칭**되고, 수정 단락의 `linesegarray`는 자동 정리된다(이전의 "한 run으로 저장" 제약 해소).

### 레퍼런스 양식 편집 워크플로우 (권장)

첨부된 임의 공문 양식의 서식·구조를 보존하며 본문만 교체:

```bash
# 1) 청사진: sec 직계자식 인덱스 + 스타일 ID 확인 (텍스트가 아닌 인덱스로 경계 파악)
./hwpx analyze 양식.hwpx

# 2a) 앵커가 있으면 fill (run-aware)
./hwpx fill 양식.hwpx --kv 제목="…" --kv 본문="…" -o 결과.hwpx
# 2b) 본문 단락 블록을 통째 교체하려면 edit-section (analyze 인덱스 사용, 서식 복제)
./hwpx edit-section 양식.hwpx --start 12 --end 18 --ref-index 12 --lines body.txt -o 결과.hwpx

# 3) 무결성 검증
./hwpx validate 결과.hwpx

# 4) 레이아웃 보존 게이트 (필수) — 문단/표/쪽수·텍스트길이 드리프트 검사
./hwpx guard --reference 양식.hwpx --output 결과.hwpx
```

`guard`가 FAIL이면(문단 수 변동, 텍스트 길이 과다 등) 완료로 보지 않고 본문을 압축/조정 후 재빌드한다. 여러 본문 블록을 교체할 때는 **마지막 섹션부터 역순**으로 `edit-section`을 호출해 인덱스 어긋남을 방지한다(엔진 `replace_section_body`도 동일 전제). 복잡한 in-place 편집은 `analyze` 결과를 보고 `scripts/hwpx_xml.py`의 `clone_para`/`replace_section_body`/`replace_in_paragraph`를 인라인 Python으로 직접 호출할 수 있다.

### unpack → XML 직접 편집 → repack

복잡한 구조 변경(표 행 추가, 스타일 변경 등)에 사용:

```bash
./hwpx unpack input.hwpx workdir/
# 이 단계에서 Edit 도구로 workdir/Contents/section0.xml 등을 직접 수정
./hwpx repack workdir/ output.hwpx
./hwpx validate output.hwpx
```

**주의**:
- `mimetype`은 zip의 **첫 번째 엔트리**이며 **STORED(무압축)**이어야 한다. `repack` 커맨드는 이를 자동 보장한다. 수동 zip 사용 금지.
- `Contents/content.hpf`에 나열되지 않은 새 파일 추가 시 manifest도 함께 갱신해야 한다.

상세는 `references/hwpx-structure.md`, `references/raw-zip-fallback.md`.

## 5. 단순 신규 생성 (`create`)

```bash
./hwpx create out.hwpx --title "제목" --body "한 줄\n다른 줄"
./hwpx create out.hwpx --markdown input.md
./hwpx create out.hwpx --json '{"title": "...", "paragraphs": ["1", "2"]}'
```

**현재 MVP 한계**:
- markdown 파싱은 "한 줄 = 한 단락" 수준. 헤딩/리스트/표 등 포매팅 미지원.
- 표·이미지·복잡한 헤더/푸터는 raw ZIP/XML 편집 또는 Hancom Office 기반 양식 보정 필요.
- 복잡한 공문서는 템플릿 채우기 경로를 쓸 것.

## 5-A. 문서 생성 (`create`, `styled`, `write-java`)

문서 생성은 모두 **hwp-cli `new`**에 위임한다 (번들 Java writer·JRE 제거됨).

- `create` / `write-java` — markdown(또는 title/body/JSON 블록)을 받아 `hwp new --from`으로 HWPX 생성. `write-java`는 레거시 별칭(앵커 export 폴백 계약 유지, 더 이상 Java 미사용).
- `styled --preset gongmun|bogoseo --markdown <md> -o <out>` — `hwp new --preset`으로 프리셋(본문 글자 크기) 적용 생성.
- `styled --reference <양식> ...` — 참조 템플릿의 `{{슬롯}}`을 lxml 엔진(`hwpx_xml.edit_text`)으로 채움(충실도 보존).

```bash
./hwpx create out.hwpx --title "제목" --body "본문"
./hwpx write-java out.hwpx --markdown report.md
./hwpx styled --preset bogoseo --markdown report.md -o out.hwpx
```

`export-html`(HTML→HWPX)은 소비자가 없어 제거됨. PDF/HTML 출력은 §1·§7의 hwp-cli 네이티브 경로 사용.

## 6. OWPML 핵심 요소

| 요소 | 위치 | 역할 |
|------|------|------|
| `<hp:sec>` | `Contents/sectionN.xml` | 섹션 (페이지 설정 + 단락 흐름) |
| `<hp:p>` | section 내부 | 단락. `paraPrIDRef`로 paraPr 참조 |
| `<hp:run>` | 단락 내부 | 런(문자 속성 단위). `charPrIDRef`로 charPr 참조 |
| `<hp:t>` | run 내부 | 실제 텍스트 |
| `<hp:tbl>` / `<hp:tr>` / `<hp:tc>` | block-level | 표/행/셀 |
| `<hp:pic>` | block-level | 이미지 (BinData/<id>.<ext> 참조) |
| `<hh:charPr>`, `<hh:paraPr>`, `<hh:style>` | `Contents/header.xml` | 스타일 딕셔너리 (ID 기반 참조) |

상세는 `references/owpml-quickref.md`.

## 7. 변환과 렌더링

### PDF

`to-pdf`는 기본적으로 **hwp-cli 네이티브**로 변환한다 (DisplayList → `pdf-writer`, 임베드
CIDFont + ToUnicode). **텍스트 선택·검색 가능**, 레이아웃 정확, LibreOffice 불필요.
(Phase 1 한계: 폰트 서브셋 미적용 → 전체 폰트 임베드로 파일이 큼. 이미지 본문 미지원.)

```bash
./hwpx to-pdf document.hwpx -o document.pdf            # 기본: hwp-cli (선택가능)
./hwpx to-pdf document.hwpx --engine hwp               # hwp-cli 강제
./hwpx to-pdf document.hwpx --engine soffice           # LibreOffice 폴백 (벡터)
```

- `--engine auto`(기본): hwp-cli 네이티브 우선, 미발견/실패 시 soffice 폴백.
- `--engine hwp`: hwp-cli 강제. `render-pdf`와 동일.
- `--engine soffice`: LibreOffice 경로. **H2Orestart 확장** 필요:

```bash
brew install --cask libreoffice
# H2Orestart: https://extensions.libreoffice.org/en/extensions/show/27504
# 다운로드 후 LibreOffice → 도구 → 확장 관리자 → 추가
```

(`render-pdf`는 `to-pdf --engine hwp`와 동일한 하위호환 별칭.)

### 레거시 `.hwp` (바이너리)

이 스킬은 HWPX 작성·편집 전용이나, **`./hwpx read legacy.hwp`는 자동으로 `hwp-cli`(`hwp cat`)에 위임**하여 텍스트를 추출한다 (탐색 순서: `$HWP_CLI` → `~/.cargo/bin/hwp` → `~/workspace/work/dev/hwp-cli/target/release/hwp` → 검증된 PATH의 `hwp`). 변환·렌더·PDF도 hwp-cli 경유:

```bash
./hwpx read legacy.hwp                              # → hwp-cli 자동 위임 (텍스트 추출)
./hwpx render-pdf legacy.hwp -o legacy.pdf          # 텍스트 선택가능 PDF (hwp-cli 네이티브, to-pdf --engine hwp 별칭)
./hwpx to-html legacy.hwp -o legacy.html            # markdown 수준 HTML
hwp convert legacy.hwp -o legacy.hwpx --to hwpx     # .hwp → .hwpx (직접 hwp-cli)
hwp edit legacy.hwp -o out.hwp --replace "구=>신"    # .hwp 직접 편집(hwp-cli만 가능)
```

## 8. 통합

- **inbox-process**: `.hwpx`·`.hwp` 모두 `./hwpx read <file>`로 내용 추출 — **hwp-cli(`hwp cat`)가 1순위 엔진**(.hwpx는 text/md에 우선 사용·실패 시 lxml 폴백, .hwp는 자동 위임). `read --format json`·`summary`는 구조 스키마 안정을 위해 lxml 유지. 공유 env 추출기(`extract_all.py`)도 1순위 엔진으로 hwp-cli 사용.
- **gaejosik 스킬**: 본문 생성 시 개조식 종결("~함", "~임") 적용. 이 스킬은 `--kv 본문="…"`으로 받은 텍스트를 그대로 치환만 한다.
- **io-mso 스킬**: 생성된 HWPX를 Microsoft 365 mail/share workflow로 전송.
- **meeting-notes 스킬**: 회의록 markdown → `./hwpx fill templates/회의록.hwpx` 경로 가능.

## 9. 자주 발생하는 실수

| 증상 | 원인 | 해결 |
|------|------|------|
| Hancom Office에서 파일 열리지 않음 | mimetype이 zip 첫 엔트리가 아니거나 DEFLATE | `./hwpx repack`으로 다시 묶기 (수동 `zip` 명령 금지) |
| `{{anchor}}` 치환이 0건 | anchor 철자/공백 불일치 (run 분할은 이제 엔진이 처리) | `./hwpx slots`로 실제 앵커명 확인 후 정확히 지정 |
| 채운 문서가 레퍼런스보다 쪽수 증가 | 본문이 원본 레이아웃 초과 | `./hwpx guard`로 드리프트 확인 → 본문 압축/조정 후 재빌드 |
| 한글이 깨짐 | 생성 시 인코딩 | 입력 JSON/텍스트 UTF-8 확인 |
| to-pdf `--engine soffice` 실패 | LibreOffice에 H2Orestart 미설치 | 확장 설치 후 `soffice --headless` 1회 실행으로 캐시 빌드. 또는 기본 엔진(hwp-cli, LibreOffice 불필요) 사용 |
| render-pdf 빈/깨진 페이지 | 함초롬(HCR) 등 CJK 폰트 미해결 | `HWP_FONT_DIR=<폰트 디렉토리>` 지정 (`~/.anchor/env/fonts` 또는 `~/Library/Fonts`) |
| 관인(직인)이 안 찍힘 | 스킬은 관인 삽입 안 함 | 정상 동작 — e-결재 시스템(온나라/K-Office)이 발송 시 자동 삽입 |
| `.hwp` 파일 읽기 | 바이너리 HWP | `./hwpx read`가 hwp-cli(`hwp cat`)에 자동 위임 (미발견 시 `cargo install --path crates/hwp-cli` 또는 `HWP_CLI` 지정). HWPX 작성·편집은 이 스킬 전용 |

## 10. 의존성

- **Python**: 공유 venv 또는 system `python3`
  - `lxml` — 슬롯/구조 편집 엔진 (fill-form·edit-section·analyze·guard·styled --reference)
- **hwp-cli** (`hwp`): 생성·변환·렌더·검증의 1순위 엔진. 탐색: `$HWP_CLI` → `~/.cargo/bin/hwp` → `dev/hwp-cli/target/release/hwp` → 검증된 PATH `hwp`.
- **선택**: LibreOffice + H2Orestart 확장 (`to-pdf --engine soffice` 벡터 PDF용; 기본 hwp-cli 경로엔 불필요)
- **선택**: Hancom Office 한/글 (템플릿 편집/검수용)

CLI 진입점은 `./hwpx` 래퍼가 자동으로 venv python을 사용한다.

## 11. 참고 문서

- `references/hwpx-structure.md` — zip 레이아웃, mimetype 규칙, 네임스페이스 표
- `references/owpml-quickref.md` — 주요 OWPML 요소 빠른 참조
- `references/korean-official-format.md` — 행정효율규정 기안문 구조 상세
- `references/raw-zip-fallback.md` — zipfile+lxml로 직접 다루기
- `references/library-landscape.md` — raw ZIP/XML / hwpxlib / pyhwpx / pyhwp 비교

## 응답 원칙

1. 한국어 소통
2. 공문서 규정 준수 — 여백·폰트·줄간격·번호체계·"끝." 표기
3. 템플릿 있으면 템플릿 채우기 우선, 없으면 신규 생성 경로
4. 생성 직후 반드시 `./hwpx validate` 실행
5. 관인·결재란은 절대 이미지로 삽입하지 않음 (e-결재 시스템 담당)
6. 개조식 본문 필요 시 `gaejosik` 스킬 먼저 호출하여 텍스트 생성 후 fill

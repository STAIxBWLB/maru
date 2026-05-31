---
name: hwpx
description: >
  한국 공문서 스타일의 HWPX 문서 작성·편집 스킬. 공문서, 기안문(내부결재/대외시행),
  사업계획서, 보고서, 회의록 템플릿 + {{anchor}} 치환 기반 문서 생성. raw ZIP/XML 처리와
  bundled OpenJDK + hwpxlib(Apache-2.0) writer 기반. 읽기·편집·검증·PDF 변환 지원.
  MVP는 템플릿 채우기 중심.
  트리거: hwpx, 공문, 공문서, 기안문, 결재문서, 내부결재, 대외시행, 사업계획서, 보고서,
  회의록, 한글 문서 작성, .hwpx 생성/수정, 공문 써줘, 기안문 만들어줘, 한컴 문서
  사용하지 않음: 바이너리 .hwp (→ hwp-toolkit), .docx (→ docx 스킬), .pdf
---

# hwpx — HWPX 공문서/기안문 authoring toolkit

## Overview

HWPX는 한/글(Hancom Office)의 **XML 기반 공식 포맷**이며, 2021년부터 대한민국 정부 공문서의 법정 저장 형식이다. 내부 구조는 zip + OWPML(Open Word-Processor Markup Language, KS X 6101). 이 스킬은 raw ZIP/XML 처리와 bundled Java writer를 사용하여 네 가지 작업 경로를 지원한다:

1. **양식 따라가기 (`styled --reference`)** — 주어진 공식 양식 파일의 폰트·여백·스타일을 그대로 사용하여 본문만 채움. 사업 공고 HWP 양식이 있을 때 최우선 경로.
2. **보기 좋은 신규 생성 (`styled --preset`)** — 양식이 없을 때 공문서 표준에 맞춘 폰트·여백·줄간격·헤더/푸터·페이지번호로 깔끔한 문서를 생성.
3. **템플릿 채우기 (`fill`)** — 내장 `templates/*.hwpx`의 `{{anchor}}` 치환. 기안문/사업계획서 뼈대 사용.
4. **편집** (`edit`, `unpack`+`repack`) — 기존 문서 수정.

바이너리 `.hwp`(v5 OLE2 포맷)은 별도 `hwp-toolkit` 스킬에서 처리한다. 이 스킬은 HWPX 전용.

## Quick Reference

| 작업 | 명령 |
|------|------|
| 읽기 (markdown) | `./hwpx read <file.hwpx>` |
| 메타 요약 | `./hwpx summary <file.hwpx>` |
| 구조화 JSON | `./hwpx read <file.hwpx> --format json` |
| **보기 좋은 생성 (양식 없음)** | `./hwpx styled --preset gongmun --markdown <md> -o <out>` |
| **양식 따라가기** | `./hwpx styled --reference <양식.hwpx> --markdown <md> -o <out>` |
| 템플릿 채우기 | `./hwpx fill <template> --kv key=value -o out.hwpx` |
| find/replace | `./hwpx edit <in> <out> --replace OLD NEW` |
| unpack → XML 직접 편집 | `./hwpx unpack <file> <dir>` → `./hwpx repack <dir> <out>` |
| 단순 신규 생성 | `./hwpx create <out> --title T --body "1줄\n2줄"` |
| **번들 Java 라이터 (Apache-2.0)** | `./hwpx write-java <out> --markdown <md>` |
| **HTML → HWPX (cascade)** | `./hwpx export-html <html> <out> --template-id report` |
| 검증 | `./hwpx validate <file.hwpx>` |
| PDF 변환 | `./hwpx to-pdf <file.hwpx>` (LibreOffice + H2Orestart 필요) |

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

양식이 `.hwp` (바이너리)이면 먼저 Hancom Office에서 열어 `.hwpx`로 저장해달라 요청하거나, `hwp-toolkit convert --to hwpx`로 변환 후 사용.

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

현재 bundled writer 경로는 단락 중심 MVP다. 정교한 표·이미지·기관별 폰트/여백은 기관 양식 파일을 기준으로 slot 치환하거나 Hancom Office에서 최종 검수한다.

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

### 단순 find/replace

```bash
./hwpx edit input.hwpx output.hwpx --replace "OLD" "NEW"
./hwpx edit input.hwpx output.hwpx --replace "구버전" "신버전" --limit 1
```

런(run) 경계를 넘나드는 텍스트는 매칭되지 않는 제약이 있음 — 그 경우 unpack 경로 사용.

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

## 5-A. 번들 Java 라이터 (`write-java`, `export-html`)

**번들된 OpenJDK 21 + hwpxlib(Apache-2.0)** 을 통해 HWPX를 생성하는 자가완결형 경로. tidy 앱(`<workspace-root>/dev/tidy`)의 export 스택을 가져와 스킬화한 것이다.

**언제 쓰나**:
- 시스템에 별도 java/python을 설치하지 않은 환경에서 일관된 결과가 필요할 때.
- HTML 입력(예: 에디터/뷰어에서 export)을 cascade로 안전하게 HWPX로 떨궈야 할 때.

### 사전 셋업 (1회)

```bash
bash ~/.anchor/skills/_builtin/envs/default/setup.sh --target ~/.anchor/env
# → ~/.anchor/env/jre/bin/java (Temurin 21 JDK runtime) 설치 + 동작 검증
```

스크립트는 멱등하다. Temurin API에서 플랫폼별 JDK 21 runtime을 다운로드한다. runtime 디렉토리(`~/.anchor/env/jre/`)는 로컬 산출물이다.

### `write-java` — 저수준 라이터

stdin 또는 markdown/text 파일을 받아 hwpxlib `HwpxWriter`로 직접 HWPX를 떨군다. mimetype STORED 정규화는 자동 적용 (Hancom Office/검증기 모두 통과).

```bash
# stdin: 한 줄 = 한 단락. H1:/H2:/H3:/P: 태그 prefix 지원.
printf "H1:테스트\nP:본문 단락임.\nP:\nH2:중간 제목\nP:끝.\n" \
  | ./hwpx write-java /tmp/out.hwpx

# markdown 모드: '#' → H1:, '##' → H2:, 일반 줄 → P:
./hwpx write-java /tmp/out.hwpx --markdown report.md

# 평문 텍스트 모드: 한 줄 = 한 P: 단락
./hwpx write-java /tmp/out.hwpx --input notes.txt
```

**범위**: `HwpxWriter.java`(MVP, ~80 LOC)는 단락만 출력한다. 표·이미지·다단 폰트가 필요하면 `styled --reference`의 slot 양식 또는 raw ZIP/XML 경로로 처리한다.

### `export-html` — HTML → HWPX cascade

tidy의 `document:export-hwp` IPC 핸들러를 Python으로 옮긴 경로. 두 엔진을 순차 시도하고, 처음 성공한 엔진의 결과를 반환한다.

| Stage | 엔진 | 의존 | 강점 |
|-------|------|------|------|
| 1 | bundled-hwpx-java | `~/.anchor/env/jre/` + hwpxlib | 가장 빠름, 시스템 의존 0 |
| 2 | pypandoc-hwpx | 외부 설치 시 | 마지막 폴백 |

```bash
./hwpx export-html input.html /tmp/out.hwpx --template-id report
# stdout JSON: {"engine": "bundled-hwpx-java", "output": "..."}

# template-id 옵션은 호환을 위해 남아 있으나 현재 bundled Java/pypandoc 경로에서는 사용하지 않음
```

Stage 1의 HTML 평탄화는 단순화된 MVP다(블록 태그 → H1:/H2:/P: 라인). 표·셀 병합·테두리 색상 등 tidy의 `htmlToHwpxBlocks`/`rewriteHwpxWithBlocks`(JS, 1500+ LOC) 후처리는 후속 작업으로 분리되어 있다.

### 라이선스 비교

| 라이브러리 | 경로 | 라이선스 | 비고 |
|-----------|------|---------|------|
| raw ZIP/XML | `read` / `fill` / `edit` / `slots` / `validate` | 표준 라이브러리 + lxml | 의존 최소화 |
| hwpxlib 1.0.5 | `write-java` / `styled` / `export-html` Stage 1 | Apache-2.0 | 자유 |
| pypandoc-hwpx | `export-html` Stage 2 (옵션) | 상황에 따라 | 시스템 설치 필요 |

상세 비교는 `references/library-landscape.md`, 패턴 설명은 `references/bundled-jre-writer.md`.

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

```bash
./hwpx to-pdf document.hwpx -o document.pdf
```

필요 조건: LibreOffice + **H2Orestart 확장** (HWPX 읽기 지원). 설치:

```bash
brew install --cask libreoffice
# H2Orestart: https://extensions.libreoffice.org/en/extensions/show/27504
# 다운로드 후 LibreOffice → 도구 → 확장 관리자 → 추가
```

### 레거시 `.hwp` (바이너리)

이 스킬은 HWPX만 처리한다. `.hwp` 읽기·변환은 `hwp-toolkit` 스킬로 위임:

```bash
~/workspace/work/dev/hwp-toolkit/hwp read legacy.hwp
~/workspace/work/dev/hwp-toolkit/hwp convert legacy.hwp --to pdf
```

## 8. 통합

- **inbox-process**: `.hwpx` → `./hwpx read <file>`로 내용 추출. `.hwp`는 별도 HWP reader로 처리.
- **gaejosik 스킬**: 본문 생성 시 개조식 종결("~함", "~임") 적용. 이 스킬은 `--kv 본문="…"`으로 받은 텍스트를 그대로 치환만 한다.
- **io-mso 스킬**: 생성된 HWPX를 Microsoft 365 mail/share workflow로 전송.
- **meeting-notes 스킬**: 회의록 markdown → `./hwpx fill templates/회의록.hwpx` 경로 가능.

## 9. 자주 발생하는 실수

| 증상 | 원인 | 해결 |
|------|------|------|
| Hancom Office에서 파일 열리지 않음 | mimetype이 zip 첫 엔트리가 아니거나 DEFLATE | `./hwpx repack`으로 다시 묶기 (수동 `zip` 명령 금지) |
| `{{anchor}}` 치환이 0건 | anchor가 여러 run으로 쪼개짐 | 템플릿을 다시 열어 한 run으로 저장 (Hancom Office에서 전체 선택→단일 서식) |
| 한글이 깨짐 | 생성 시 인코딩 | 입력 JSON/텍스트 UTF-8 확인 |
| PDF 변환 실패 | LibreOffice에 H2Orestart 미설치 | 확장 설치 후 `soffice --headless` 1회 실행으로 캐시 빌드 |
| 관인(직인)이 안 찍힘 | 스킬은 관인 삽입 안 함 | 정상 동작 — e-결재 시스템(온나라/K-Office)이 발송 시 자동 삽입 |
| `.hwp` 파일에 대해 오류 | 바이너리 HWP는 지원하지 않음 | `hwp-toolkit` 스킬 사용 |

## 10. 의존성

- **Python**: 공유 venv 또는 system `python3`
  - `lxml` — HWPX XML 읽기/검증에 사용
- **Bundled Java**: `~/.anchor/env/jre` + `runtime/hwpxlib-1.0.5.jar`
- **선택**: LibreOffice + H2Orestart 확장 (PDF 변환용)
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

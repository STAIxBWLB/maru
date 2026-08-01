---
name: md2docx
description: >
  Markdown → 세련된 Word(.docx) 변환 스킬. docx-js(`docx` npm) 기반 — pandoc 변환 금지.
  맑은 고딕(한글 eastAsia)·테마 헤더(mineral/koica/mono)·표 zebra/얇은 그리드·작은 불릿·
  머리말/PAGE 푸터·〔확인필요〕 적색 강조를 프로그램적으로 제어. Maru env에 번들된 Node
  런타임 + docx 패키지로 실행하며 어느 프로젝트에서나 호출 가능.
  트리거: docx, .docx, 워드, word 문서, 보고서 docx, md to docx, markdown to docx,
  마크다운 변환, 마크다운 docx, docx-js, docx 생성, 워드로 변환, 문서 산출물, 한글 워드
  사용하지 않음: .hwpx 공문서(→ hwpx 스킬), .pdf, 스프레드시트(→ xlsx-toolkit), 슬라이드(→ pptx-toolkit)
---

# md2docx — markdown → refined .docx (docx-js)

## Overview

`.docx` 생성·변환은 **항상 docx-js**(`docx` npm)로 한다. **pandoc 변환은 금지** — 밋밋하고
한글 폰트 치환 이슈가 있어 사용자가 명시적으로 거부함. 이 스킬은 self-contained 마크다운
파서 + docx-js 문서 조립기로, 맑은 고딕(eastAsia 슬롯)·테마 컬러 헤더·zebra 표·작은
불릿·머리말/페이지번호·인라인 서식(**bold**/`code`/〔…〕 적색)을 정밀 제어한다.

**markdown이 SSOT, docx는 산출물** — 수정은 `.md`에서 하고 재변환한다.

런타임: Maru env(`~/.maru/env`)에 번들된 Node + `docx` 패키지. wrapper가 env Node를
해소하고 `NODE_PATH=~/.maru/env/node_modules`를 export하여 변환기가
`createRequire("docx")`로 패키지를 로드한다(ESM 정적 import는 bare specifier에 NODE_PATH를
적용하지 않으므로 createRequire 사용).

## Quick Reference

| 작업 | 명령 |
|------|------|
| 기본 변환 (mineral) | `./md2docx <file.md>` |
| 출력 경로 지정 | `./md2docx <file.md> -o <out.docx>` |
| KOICA 네이비 테마 | `./md2docx <file.md> --theme koica` |
| 모노크롬 테마 | `./md2docx <file.md> --theme mono` |
| 한글 명조 본문(격식) | `./md2docx <file.md> --serif` |
| 개조식 기호 사다리 | `./md2docx <file.md> --gaejosik` |
| 머리말 override / 제거 | `./md2docx <file.md> --header "제목"` · `--no-header` |
| 다중 파일 일괄 | `./md2docx a.md b.md c.md` |

경로 기준: `~/.maru/skills/md2docx/md2docx`

## 테마 (palette)

| 테마 | 용도 | 헤더/액센트 |
|------|------|------------|
| `mineral` (기본) | 일반 보고서·기획서, 차분한 에디토리얼 | muted teal/ink |
| `koica` | KOICA·공식 제출물 | 네이비(#0F2344) + KOICA 블루(#2563EB) |
| `mono` | 흑백 인쇄·미니멀 | monochrome |

## 개조식 모드 (`--gaejosik`)

한국어 공식 문서(보고서·계획서·검토의견서)의 기호 사다리를 docx에 반영한다. 테마(`--theme`)와
직교적이다(테마는 색상만, 이 플래그는 불릿 글리프와 들여쓰기만 바꾼다).

| 단 | 마크다운 소스 | `--gaejosik` docx 출력 |
|----|--------------|------------------------|
| 1 | `□ 내용` (독립 단락) | 글리프 유지 + 내어쓰기 (left 360, hanging 360) |
| 2 | `○ 내용` (독립 단락) | 글리프 유지 + 1단 들여쓰기 (left 720, hanging 360) |
| 3 | `- 내용` (리스트) | 네이티브 불릿 글리프 `-` |
| 4 | `  - 내용` (중첩 리스트) | 네이티브 불릿 글리프 `·` |

플래그 없이 변환하면 리스트는 docx-js 기본 불릿(`● ○ ■` 순환), `□`/`○` 단락은 일반 단락으로
나간다. 원 기호는 `○`(U+25CB)만 사용하고 `◦`·ASCII `o`·`ㅇ`·`❍`는 쓰지 않는다.

리스트 단은 그룹 내 상대 깊이로 판정한다. `○` 아래에 2칸 들여쓴 `-` 리스트도 1단(`-`)이며,
그 아래 중첩된 항목이 2단(`·`)이 된다.

제목 번호는 소스에 리터럴로 적는다(`## Ⅰ. 대항목` → `### 1. 중항목` → `#### 가. 소항목` →
`##### 1) 세항목`). 변환기는 제목에 자동 번호를 붙이지 않으므로 소스 표기가 그대로 나온다.

문장 규칙(명사형 종결·금지 종결어)은 `gaejosik` 스킬 소관. 작업공간에 별도 서식 SSOT가 있으면
그것이 우선한다.

## 줄바꿈 동작

- **단일 줄바꿈은 공백으로 합쳐진다.** 연속된 본문 줄은 한 단락으로 병합된다.
- **빈 줄 = 새 단락.** `□`·`○` 줄을 각각 별도 단락으로 내려면 앞뒤에 빈 줄이 있어야 한다.
- **리스트 항목은 각자 한 줄.** `-` 항목은 병합되지 않으므로 사이에 빈 줄이 불요하다.
- `<br>`은 본문 단락·표 셀 모두에서 강제 줄바꿈으로 변환된다(굵게·기울임 등 인라인 서식 유지).
  다만 공식 문서 본문에서는 `<br>` 대신 빈 줄로 단락을 나누는 편이 hwpx 등 다른 변환 경로와
  호환된다.
- 행말 공백 2칸(마크다운 하드 브레이크)과 행말 역슬래시는 지원하지 않는다.

## 지원 마크다운

YAML frontmatter(`title:` → 중앙 H1 승격), H1–H6(H1 다음 `_부제_` 자동 인식), 인라인
`**bold**`·`_italic_`/`*italic*`·`` `code` ``(적색)·`〔…〕`·`<br>`, 링크 `[t](url)`/bare URL,
표(`:---:` 정렬, 빈 헤더=라벨셀, zebra/얇은 그리드), 중첩 불릿(`-`/`*`)·번호(`1.`),
체크리스트(`- [ ]`/`- [x]`), 인용(`>`), 펜스 코드블록, 구분선(`---`), HTML 주석 제거.

폰트: 맑은 고딕(한글 eastAsia) + Calibri(라틴) / `--serif`는 바탕 + Cambria. 본문 라인 1.15,
A4 여백 2cm, 머리말=문서 제목(저시인성), 바닥글=현재/전체 페이지.

## 런타임 점검

```bash
bash ~/.maru/skills/_builtin/envs/default/setup.sh --target ~/.maru/env --verify
# → venv / node: docx 존재 / node-runtime: vNN + docx require OK / jre 확인
```

Node 또는 docx 패키지가 없으면:
```bash
bash ~/.maru/skills/_builtin/envs/default/setup.sh --target ~/.maru/env
```
가 번들 Node 설치 + `docx` 재설치를 수행한다.

## 참고

- 변환기 구현: `scripts/md2docx.mjs` (self-contained, `docx`만 의존)
- 런타임 해소 규약: `skills/envs/default/REFERENCE.md` (Python/JRE/Node 해소 순서)
- 공문서(.hwpx)는 `hwpx` 스킬, 스프레드시트는 `xlsx-toolkit`, 슬라이드는 `pptx-toolkit`.

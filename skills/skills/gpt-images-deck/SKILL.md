---
name: gpt-images-deck
description: |
  ChatGPT Images 2.0 / Codex native image generation 기반 슬라이드 덱 제작 스킬. Use when the user wants to turn source files, notes, or a prompt into a page-numbered slide image deck using the local _sys/docs/slide-decks style catalog. Orchestrates DESIGN.md, slide_plan.json, slide_prompts.json, sequential page_N.png generation, and visual QA. Triggers: gpt-images-deck, ChatGPT Images slide deck, slide images, 슬라이드 이미지 생성, PPT 이미지 덱, 디자인 카탈로그 슬라이드, _sys/docs/slide-decks 스타일로 덱 만들기.
---

# GPT Images Deck

`gpt-images-deck`은 `_sys/docs/slide-decks/`의 스타일 카탈로그를 디자인 권위로 삼아, 사용자 콘텐츠를 ChatGPT Images 2.0용 슬라이드 이미지 덱으로 변환한다.

- 스타일 카탈로그: `_sys/docs/slide-decks/`
- 스타일 선택 보조: `~/.anchor/skills/notebooklm-deck/references/style-decision-tree.md`
- 긴 산출물 스키마: [`references/output-schemas.md`](references/output-schemas.md)
- 최종 산출물: `DESIGN.md`, `slide_plan.json`, `slide_prompts.json`, `page_1.png` ... `page_N.png`

## 언제 사용

- 사용자가 "ChatGPT Images 2.0로 슬라이드 덱 만들기", "slide image deck", "스타일 카탈로그 기반 PPT 이미지"를 요청할 때
- NotebookLM/Canva용 짧은 프롬프트가 아니라, 실제 페이지 이미지 파일을 순차 생성해야 할 때
- 사용자 소스 파일, 회의록, 보고서, 메모를 발표용 슬라이드 이미지로 재구성해야 할 때
- 사용자가 14종 스타일 중 하나를 지정하거나, 분위기만 말하고 스타일 추천까지 요구할 때

## 카탈로그 스타일

전체 설명은 `_sys/docs/slide-decks/README.md`를 읽는다. 빠른 매칭은 아래 기준을 사용한다.

| 맥락 | 우선 스타일 |
|------|-------------|
| AI/agent 제품·연구 비전 | Anti-Gravity |
| 회사·연구실·regional innovation 결과 보고 | Refined Minimal Portfolio |
| 브랜드 캠페인·강연 키노트 | Blood Orange Agency |
| 강의·튜토리얼·학과 OT | Comic Story |
| 개발자 컨퍼런스·AI 도구 | Neo-Retro Dev |
| 청년·트렌드·학생 행사 | Yellow Fashion Mag 또는 Vitamin Pop |
| 앱·SaaS·UI/UX 런치 | Premium Mockup |
| 정책·연구·학술 분석 | Constructivism Tech |
| 매뉴얼·가이드·AI 리터러시 | Flat Illustration |

## 워크플로우

항상 이 순서로 진행한다. 사용자가 중간 산출물만 요청한 경우에만 해당 단계에서 멈춘다.

### 1단계 - 입력 정리

확인할 정보:

- 발표 목표와 청중
- 사용할 파일, 폴더, 메모, 원문
- 원하는 슬라이드 수 또는 밀도
- 선호 스타일, 또는 원하는 vibe
- 최종 산출 위치

이미 메시지와 파일 경로에서 충분히 알 수 있으면 재질문하지 않는다. 스타일이 불명확하면 decision tree로 1순위와 2순위를 제안하고 선택을 받는다. 사용자가 "알아서"라고 했으면 가장 적합한 1종을 선택하고 근거를 짧게 남긴다.

### 2단계 - DESIGN.md 작성

선택된 스타일 파일 `_sys/docs/slide-decks/{style-slug}.md`를 읽고 `DESIGN.md`를 작성한다.

- 스타일 파일과 카탈로그 README를 디자인 권위로 사용한다.
- 사용자가 별도 reference slide image를 제공하면, 이미지에서 관찰한 디자인을 우선 반영하되 카탈로그 스타일과 충돌하는 부분은 명시한다.
- 콘텐츠 요약을 DESIGN.md에 섞지 않는다. DESIGN.md는 시각 시스템만 설명한다.
- 관찰 가능한 규칙과 추론한 규칙을 분리한다.
- body slide layout discipline, header/body/footer 구조, chart/table/icon/diagram 규칙을 반드시 포함한다.

### 3단계 - slide_plan.json 작성

사용자 목표와 소스 파일을 근거로 덱의 논리 구조를 계획한다.

- 파일 업로드 순서가 아니라 설득 흐름으로 배열한다.
- 각 슬라이드는 하나의 핵심 메시지와 존재 이유를 가진다.
- evidence가 부족한 슬라이드는 줄이거나 evidence-light로 표시한다.
- 너무 조밀한 주제는 adjacent mini-sequence로 나누되, cosmetic split은 금지한다.
- 표, 차트, metric cards, diagram flow 중 무엇이 중심 시각인지 계획 단계에서 결정한다.
- opener, body, end page의 역할을 분리한다.

### 4단계 - slide_prompts.json 작성

`DESIGN.md`와 `slide_plan.json`을 이용해 페이지별 생성 프롬프트를 만든다.

- 한 슬라이드당 하나의 상세 prompt를 작성한다.
- header/body/footer placement를 명시한다.
- body slides는 제한된 반복 layout family를 재사용한다.
- 아이콘, infographic cards, diagram connectors는 의미 역할이 있을 때만 허용한다.
- "modern", "clean" 같은 추상 지시만 쓰지 않는다.
- 무작위 badge, 장식 도형, generic four-card template, title hierarchy drift를 명시적으로 금지한다.

### 5단계 - ChatGPT Images 2.0로 페이지 이미지 생성

Codex native image generation을 사용한다. 커스텀 OpenAI SDK runner를 만들지 않는다.

1. `DESIGN.md`와 `slide_prompts.json`을 다시 읽고 slide count를 확인한다.
2. `slide_number` 순서대로 한 장씩 생성한다.
3. 각 페이지 생성 직후 이미지를 inspect한다.
4. major composition, header/body/footer, 텍스트 가독성, style consistency를 확인한다.
5. 통과한 이미지를 workspace output folder에 `page_N.png`로 저장한다.
6. 실패한 페이지는 다음 페이지로 넘어가기 전에 regenerate한다.

기본 output folder는 사용자가 지정한 폴더다. 지정이 없으면 현재 작업 위치 아래 `gpt-images-deck-output/`을 사용한다. 기존 `page_N.png`가 있으면 사용자가 regeneration을 요청한 해당 번호만 덮어쓴다.

## 산출물 규칙

- `DESIGN.md`: 디자인 시스템 문서
- `slide_plan.json`: narrative and page-system plan
- `slide_prompts.json`: page-level generation prompts
- `page_N.png`: 최종 선택된 슬라이드 이미지

긴 템플릿은 [`references/output-schemas.md`](references/output-schemas.md)를 읽고 그대로 따른다. JSON은 valid JSON으로 저장한다.

## 품질 기준

- 한 덱의 body slides는 같은 시스템의 변주처럼 보여야 한다.
- 슬라이드마다 시각 중심을 하나로 둔다.
- 표 중심 슬라이드는 표 중심이라고 명시하고, chart/card/diagram으로 억지 변환하지 않는다.
- chart-led slide는 chart family, primary data, annotation rail을 구분한다.
- end page는 단순 종료가 아니라 요약, ask, implication 중 하나를 수행한다.
- 모든 페이지 prompt는 생성기가 전체 레이아웃을 추측하지 않아도 될 정도로 구체적이어야 한다.

## 금지

- source evidence 없이 숫자, 차트, legend 만들기
- `_sys/docs/slide-decks/` 내용을 다른 스킬이나 프로젝트 폴더에 복제하기
- NotebookLM/Canva용 prompt를 그대로 ChatGPT Images prompt로 사용하기
- 모든 body slide를 "제목 + 4개 카드"로 획일화하기
- 페이지별로 테마, 아이콘 스타일, 차트 스타일을 임의 변경하기
- 시각 검수 없이 여러 장을 batch 생성하고 완료 선언하기

## 관련 스킬

- `notebooklm-deck` - 같은 카탈로그의 NotebookLM용 긴 master prompt 조립
- `canva-deck` - 같은 카탈로그의 Canva용 압축 prompt 조립
- `pptx-toolkit` - 생성된 이미지를 PPTX 후처리할 때 참고
- `gaejosik` - 한국어 공식 보고서 톤의 슬라이드 문구가 필요할 때

---
name: notebooklm-deck
description: |
  NotebookLM Slide Deck / Visual Overview용 디자인 시스템 프롬프트를 쉽게 선택·조립·복사할 수 있게 돕는 스킬. _sys/docs/slide-decks/에 보관된 14종 스타일 카탈로그(Anti-Gravity, Refined Minimal Portfolio, Blood Orange Agency, Comic Story, Neo-Retro Dev, Yellow Fashion Mag, Red Accent Editorial, Royal Watercolor, Premium Mockup, Sports Energy, Sculpture Pop, Constructivism Tech, Vitamin Pop, Flat Illustration)에서 발표 맥락에 맞는 스타일을 추천하고, Master Prompt + Topic/Source + 스타일별 추가 파라미터(Palette, Protagonist 등)를 한 블록으로 조립하여 사용자가 NotebookLM Studio에 통째로 붙여넣을 수 있게 한다.
  트리거: notebooklm, NotebookLM 슬라이드, 슬라이드 덱 프롬프트, 발표 스타일, slide deck style, slide style, presentation prompt, visual overview, /notebooklm-deck, 슬라이드 스타일 추천, 발표 디자인 시스템, deck prompt, 슬라이드 디자인 프롬프트, 마스터 프롬프트, NotebookLM 프롬프트, deck style picker
---

# NotebookLM Slide Deck Skill

NotebookLM Studio의 Slide Deck / Visual Overview 생성 시 일관된 디자인 시스템을 강제하기 위한 14종 마스터 프롬프트 카탈로그를 쉽게 선택·조립한다.

- 카탈로그 위치: `_sys/docs/slide-decks/`
- 단일 진입점: 본 스킬 (`notebooklm-deck`)
- 출력: NotebookLM에 통째로 붙여넣을 수 있는 완성된 프롬프트 블록 1개

## 언제 사용

- 사용자가 NotebookLM 슬라이드 덱 / Visual Overview 생성을 언급할 때
- "발표 자료 디자인 가이드 줘", "슬라이드 스타일 추천해줘" 같이 디자인 톤이 필요한 발표를 만들 때
- 사용자가 카탈로그 14종 중 하나를 직접 지정하거나, 맥락만 제공하고 추천을 요청할 때

## 14종 카탈로그 한눈에 (vibe → 스타일)

| 발표 맥락 / 분위기 | 추천 스타일 | 파일 |
|-------------------|------------|------|
| AI/agent 제품·연구 비전 (calm tech) | **Anti-Gravity** | `anti-gravity.md` |
| 회사·연구실 소개, 포트폴리오 (architectural grid) | **Refined Minimal Portfolio** | `refined-minimal-portfolio.md` |
| 브랜드 캠페인, 강연 키노트 (editorial agency) | **Blood Orange Agency** | `blood-orange-agency.md` |
| 강의·튜토리얼·OT (warm narrative) | **Comic Story** | `comic-story.md` |
| 개발자 컨퍼런스, AI 도구 소개 (retro pixel) | **Neo-Retro Dev** | `neo-retro-dev.md` |
| 청년·트렌드·학생 행사 (magazine pop) | **Yellow Fashion Mag** | `yellow-fashion-mag.md` |
| 룩북·디자인 키노트 (refined fashion) | **Red Accent Editorial** | `red-accent-editorial.md` |
| 인문·예술·전시 (painterly literary) | **Royal Watercolor** | `royal-watercolor.md` |
| 앱·SaaS 런치, UI/UX (Apple mockup) | **Premium Mockup** | `premium-mockup.md` |
| 스포츠·챌린지 킥오프 (athletic energy) | **Sports Energy** | `sports-energy.md` |
| 트렌드·문화 캠페인 (surreal collage) | **Sculpture Pop** | `sculpture-pop.md` |
| AI 사상서·연구 분석 (avant-garde academic) | **Constructivism Tech** | `constructivism-tech.md` |
| 커뮤니티·청년 강의 (organic SNS pop) | **Vitamin Pop** | `vitamin-pop.md` |
| 안내 매뉴얼·가이드·리터러시 (picture-book) | **Flat Illustration** | `flat-illustration.md` |

전체 카탈로그 인덱스: `_sys/docs/slide-decks/README.md`
스타일 결정 트리: [`references/style-decision-tree.md`](references/style-decision-tree.md)

## 워크플로우

### 1단계 — 의도 파악 (필수)

다음 정보를 사용자로부터 확인. 이미 메시지에 충분히 들어 있으면 재질문하지 않는다.

- **Topic / Source**: 발표 주제 또는 NotebookLM에 업로드된 소스 노트 명
- **Audience**: 청중 (전문가 / 학생 / 일반인 / 행정 / 기업 / 학회 등)
- **Vibe**: 사용자가 원하는 분위기 (calm·tech / 매거진 / 친근 / 학구적 / 스포츠 / 예술 / etc.)
- **Language**: 발표 언어 (기본은 입력 언어 자동 감지)

### 2단계 — 스타일 매칭

사용자가 스타일을 직접 지정한 경우(예: "Anti-Gravity로 줘") → 즉시 3단계로.
지정하지 않은 경우 → [§14종 카탈로그 표] + [`references/style-decision-tree.md`]를 참조해 **1순위 + 2순위** 두 개를 추천하고 사용자에게 선택을 요청.

추천 시 한 줄 근거를 함께 제시한다. 예:
> 청년 대상 트렌드 발표라면 **Vitamin Pop**(SNS 친화 organic pop) 또는 **Yellow Fashion Mag**(매거진 톤 + 스티커 팝). 정보량이 많으면 Vitamin Pop을 추천.

### 3단계 — Master Prompt 로드

선택된 스타일의 파일을 `_sys/docs/slide-decks/{slug}.md`에서 Read.
파일 안의 `📋 Master Prompt` 섹션의 코드 블록(``` ``` 사이)만 추출해 사용한다.

### 4단계 — 추가 파라미터 수집 (스타일별)

다음 스타일은 Master Prompt 마지막에 추가 줄이 필요하다. 사용자에게 한 번에 묻기:

| 스타일 | 추가 입력 |
|--------|-----------|
| 모든 스타일 | `Topic / Source: ...` (필수) |
| Comic Story | `Protagonist / 주인공: <청중과 닮은 1명을 한 줄로 묘사>` |
| Flat Illustration | `Palette: <bg + 일러스트 2색 — 예: cream / peach / sage>` (+ 선택적으로 Character 라인) |
| Neo-Retro Dev / Sculpture Pop | (선택) 필요 시 컬러 사이클 또는 메인 강조 색을 명시 |

각 스타일 파일의 *변형 가이드* 표를 참고해 발표 맥락에 맞는 패턴 조합도 함께 제안하면 품질이 올라간다.

### 5단계 — 최종 블록 조립 + 출력

사용자에게 **하나의 코드 블록**으로 출력. 형식:

````markdown
## NotebookLM Slide Deck Prompt — {Style Name}

> {파일 경로} 기반. NotebookLM Studio → Slide Deck (또는 Video Overview) → Customize에 통째로 붙여넣기.

```
{Master Prompt 본문 — 코드 블록 안의 내용 전체}

---
Topic / Source: {사용자가 입력한 주제}
{스타일별 추가 라인이 있으면 여기에}
```

추천 패턴 조합: {변형 가이드에서 발표 맥락에 맞는 한 줄}
````

이 블록을 그대로 복사해 NotebookLM에 붙여넣으면 된다.

### 6단계 — 후속 제안 (선택)

- 같은 주제로 **다른 스타일도 시도해보겠는지** 묻기 (1순위 + 2순위 둘 다 생성하면 비교 가능)
- 발표 컨텍스트가 회의·미팅이면 vault 노트 자동 추출 제안 (`/extract`)
- 결과 슬라이드를 PDF로 내보낼 예정이면 hwpx/docx 변환은 별도 스킬 안내

## 사용 예시

### 예시 1 — 사용자가 스타일 직접 지정
> "regional innovation 2년차 결과 보고를 Refined Minimal Portfolio 스타일로 NotebookLM 프롬프트 만들어줘."

→ 1·2단계 스킵 → 3단계: `_sys/docs/slide-decks/refined-minimal-portfolio.md` Read → 4단계: Topic만 추가 → 5단계 출력. 추천 패턴 조합: "Text + Data Emphasis → Vertical Timeline → Chart → Two Columns(Problem vs Solution)"

### 예시 2 — vibe만 제공
> "AI 윤리 강의용 슬라이드 만들 건데 학생들이 어렵게 느끼지 않게 하고 싶어. NotebookLM 프롬프트 줘."

→ 추천: 1순위 **Comic Story**(친근·서사·주인공), 2순위 **Vitamin Pop**(organic·정보량·SNS) → 사용자 확인 → Comic Story 선택 시 Protagonist 입력 요청 → 5단계 출력.

### 예시 3 — 두 가지 동시 비교
> "콜라보 제안서를 농업 기업에 발표할 건데 두 가지 톤으로 비교해보고 싶어."

→ 1·2순위 동시 출력(예: **Refined Minimal Portfolio** vs **Blood Orange Agency**). 두 개의 완성 블록을 한 응답에 나란히.

## 운영 원칙

- **카탈로그 단일 소스**: `_sys/docs/slide-decks/`만 참조. 다른 곳에 동일 프롬프트 복제 금지
- **언어 정책 보존**: Master Prompt 안의 *"the language should be what users said in the prompt"* 문구는 NotebookLM이 입력 언어를 자동 감지하므로 절대 삭제하지 말 것
- **사용자 입력 우선**: 사용자가 14종에 없는 새 스타일을 원하면, 우선 가까운 스타일을 추천하되, 정착할 가치가 있으면 새 파일 추가를 제안 (`_sys/docs/slide-decks/{kebab-case}.md` + README 업데이트)
- **vault 연동 금지**: 본 스킬은 work/ 내부 자원만 다룸. vault 노트 추출이 필요하면 별도로 `/extract` 호출
- **출력 안정성**: 항상 코드 블록(```)으로 감싸 출력. 사용자가 raw text로 복사할 수 있도록 유지

## 관련 스킬

- `meeting-notes` — 회의록 → NotebookLM 소스로 사용 시 사전 정리
- `gaejosik` — 한국어 공식 보고서 톤이 필요한 경우 본문 톤 보정
- `pptx-toolkit` — 결과 슬라이드를 .pptx로 받았을 때 후처리
- `hwpx` — 발표 결과를 한국 공문서 양식으로 변환 시

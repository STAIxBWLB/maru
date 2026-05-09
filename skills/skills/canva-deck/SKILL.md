---
name: canva-deck
description: |
  Canva 슬라이드 덱(Magic Design for Presentations / AI 프레젠테이션 / Docs to Decks)용 디자인 시스템 프롬프트 조립 스킬. _sys/docs/slide-decks/에 보관된 14종 스타일 카탈로그(Anti-Gravity, Refined Minimal Portfolio, Blood Orange Agency, Comic Story, Neo-Retro Dev, Yellow Fashion Mag, Red Accent Editorial, Royal Watercolor, Premium Mockup, Sports Energy, Sculpture Pop, Constructivism Tech, Vitamin Pop, Flat Illustration)에서 발표 맥락에 맞는 스타일을 선택하고, Canva의 짧은 프롬프트 입력 박스에 맞춰 압축된 1-2문단 프롬프트를 조립한다. 또한 Canva의 템플릿 검색 키워드(예: "minimal architectural deck", "comic style presentation")와 폰트·컬러 추천도 함께 제시.
  트리거: canva, Canva 슬라이드, Canva 발표, Canva AI, Magic Design, Magic Write, Docs to Decks, Canva 프롬프트, Canva 템플릿, /canva-deck, 캔바 슬라이드, 캔바 프레젠테이션, 캔바 AI, Canva presentation prompt
---

# Canva Slide Deck Skill

Canva의 AI 프레젠테이션 도구(Magic Design for Presentations / AI 프레젠테이션 / Docs to Decks)에 입력할 디자인 시스템 프롬프트를 14종 카탈로그에서 압축·조립한다.

- 카탈로그 위치: `_sys/docs/slide-decks/` (NotebookLM·Canva 공유 단일 소스)
- 단일 진입점: 본 스킬 (`canva-deck`)
- 출력: Canva의 짧은 프롬프트 입력에 맞춘 1-2문단 + 템플릿 검색 키워드 + 폰트·컬러 명세

## 왜 별도 스킬인가

| 항목 | NotebookLM | Canva |
|------|-----------|-------|
| 입력 길이 | 사실상 무제한 (긴 master prompt 가능) | 짧음 (Magic Design 입력은 ~150-300자, AI 프레젠테이션 prompt도 단문 위주) |
| 스타일 컨트롤 | 프롬프트가 곧 디자인 시스템 | Canva 템플릿 + brand kit이 우선, 프롬프트는 보조 |
| 슬라이드 수 | NotebookLM이 자동 결정 | 사용자가 직접 지정 가능 (5/10/15/20) |
| 레이아웃 어휘 | 자유 서술 | Canva 내장 템플릿 카테고리에 맞춰야 효과적 |
| 이미지 | 텍스트→AI 일러스트 | 자체 stock + Magic Media 생성 가능 |

→ NotebookLM용 master prompt를 그대로 붙이면 Canva가 무시한다. Canva는 **압축된 톤 + 템플릿 검색어 + 슬라이드 개수 + 청중**의 4-5요소 조합을 선호.

## 14종 카탈로그 한눈에 → Canva 템플릿 매핑

| 스타일 | 파일 | Canva 템플릿 검색어 (영문) |
|--------|------|--------------------------|
| Anti-Gravity / Living Artifact | `anti-gravity.md` | `minimal AI presentation`, `tech keynote calm gradient` |
| Refined Minimal Portfolio | `refined-minimal-portfolio.md` | `minimal architectural deck`, `agency portfolio presentation` |
| Blood Orange Agency | `blood-orange-agency.md` | `editorial agency presentation`, `bold magazine deck` |
| Comic Story | `comic-story.md` | `illustrated comic presentation`, `storytelling slides hand drawn` |
| Neo-Retro Dev Deck | `neo-retro-dev.md` | `retro pixel presentation`, `developer keynote pop` |
| Yellow Fashion Mag | `yellow-fashion-mag.md` | `yellow magazine presentation`, `editorial fashion deck` |
| Red Accent Editorial | `red-accent-editorial.md` | `minimal red accent deck`, `fashion lookbook presentation` |
| Royal Watercolor | `royal-watercolor.md` | `watercolor presentation`, `painterly literary slides` |
| Premium Mockup | `premium-mockup.md` | `app launch mockup deck`, `Apple device presentation` |
| Sports Energy | `sports-energy.md` | `sports presentation italic`, `athletic campaign deck` |
| Sculpture Pop | `sculpture-pop.md` | `pop art collage presentation`, `surreal vaporwave deck` |
| Constructivism Tech | `constructivism-tech.md` | `editorial research dossier deck`, `avant-garde academic slides` |
| Vitamin Pop | `vitamin-pop.md` | `colorful pop deck`, `friendly community presentation` |
| Flat Illustration | `flat-illustration.md` | `flat illustration presentation`, `picture book slides` |

전체 카탈로그 인덱스: `_sys/docs/slide-decks/README.md`
스타일 결정 트리: 동일 폴더의 `notebooklm-deck` 스킬 references/style-decision-tree.md 재사용

## 워크플로우

### 1단계 — 의도 파악 (필수)

다음 5요소를 사용자로부터 확인. 메시지에 충분히 들어 있으면 재질문하지 않는다.

- **Topic**: 발표 주제 (한 줄)
- **Audience**: 청중 (학생 / 전문가 / 일반인 / 행정 / 기업)
- **Slide count**: 슬라이드 수 (5 / 10 / 15 / 20)
- **Vibe / Style**: 14종 중 하나 또는 vibe 키워드
- **Language**: 발표 언어 (기본: 입력 언어 자동 감지)

### 2단계 — 스타일 매칭

- 사용자가 직접 지정 → 즉시 3단계로
- 미지정 → 14종 카탈로그 + decision tree 참조해 1순위 + 2순위 추천. 사용자 확인 받은 뒤 진행

### 3단계 — Canva-friendly 프롬프트 조립

선택된 스타일의 `_sys/docs/slide-decks/{slug}.md`를 Read. Master Prompt에서 **핵심 형용사·컬러·레이아웃 키워드**만 추출해 다음 형식으로 압축:

```
[Topic] presentation for [Audience], [N] slides.
Style: [3-5 형용사], [컬러 팔레트], [헤드라인 폰트 스타일].
Layout: [Canva 템플릿 키워드 영문].
Tone: [한 줄 톤 디스크립션].
Language: [언어].
```

압축 규칙:
- **150-250자 내외** (Canva Magic Design 입력 박스에 들어가도록)
- 영문 키워드 우선 (Canva가 영문 디자인 어휘를 더 잘 이해)
- 컬러는 HEX 1-3개 명시
- 폰트는 Canva 내장 폰트 이름으로 (예: "Helvetica Now", "Recoleta", "Druk Wide")

### 4단계 — 보조 명세 출력

다음 4블록을 함께 출력:

1. **Canva Prompt** (위에서 조립한 압축 프롬프트)
2. **Template Search Keywords** (Canva 템플릿 라이브러리에서 검색할 영문 키워드 2-3개)
3. **Brand Kit Spec** (선택 시 Brand Hub에 등록할 색·폰트)
   - 컬러: 1-4 HEX
   - 폰트: Heading / Body 추천 (Canva 폰트 라이브러리에 존재하는 이름)
4. **Slide-by-slide Outline** (선택, 사용자가 원하면) — 각 슬라이드 1줄

### 5단계 — Canva 사용 가이드 안내

사용자가 처음이라면 다음 경로를 안내:

- **Magic Design for Presentations**: Canva 홈 → "Create" → "Presentation" → 상단 "Magic Design" 또는 "AI 프레젠테이션" 클릭 → 프롬프트 입력 박스에 `Canva Prompt` 블록 붙여넣기
- **Docs to Decks**: 긴 마크다운/텍스트가 있을 때 → Canva Docs에 붙여넣고 "Convert to Deck" 사용 → 슬라이드 톤 커스터마이즈
- **Brand Hub**: 반복 사용하는 스타일은 Brand Hub에 색·폰트·로고 등록 → 모든 신규 덱에 자동 적용

### 6단계 — 후속 제안 (선택)

- 같은 주제로 NotebookLM 버전도 만들지(`notebooklm-deck` 스킬 호출) 묻기
- 결과 .pptx export → 본교 발표 시 hwpx 변환 필요하면 `hwpx` 스킬 안내

## 사용 예시

### 예시 1 — 간단 요청
> "regional innovation 2년차 결과 보고를 Canva로 10장 만들 건데 Refined Minimal Portfolio 스타일로 프롬프트 줘."

→ 1·2단계 스킵 → 3단계로 직진. 출력:

```
Canva Prompt:
regional innovation Year 2 results report for academic and government stakeholders, 10 slides.
Style: minimal, architectural, archival, grid-driven, generous whitespace.
Palette: light gray #E9E9E9, jet black #000, charcoal #333.
Typography: heading in Helvetica Now (English) + Korean gothic (small body).
Layout: top-left section nav (e.g., "01. INTRO"), strict grid alignment, oversized numerals for data.
Tone: professional, restrained, archival. Korean primary, English labels.

Template Search Keywords: minimal architectural deck, agency portfolio presentation, archival report

Brand Kit Spec:
- Colors: #E9E9E9 / #FFFFFF / #000000 (accent: thin black rules only)
- Fonts: Heading "Helvetica Now Display Bold" · Body "Noto Sans KR Light"
```

### 예시 2 — vibe만 제공
> "캐주얼 캠페인 제안서를 Canva로 7장 만들고 싶어."

→ 추천 1순위: Blood Orange Agency, 2순위: Yellow Fashion Mag → 사용자 선택 → 3단계 출력

### 예시 3 — 인터랙티브 outline
> "위 프롬프트로 슬라이드별 outline도 같이 줘."

→ 4단계 4번째 블록 추가: 10장 각 슬라이드 한 줄씩 (Cover / Setup / Year 2 KPIs / Pivot / Outcomes / etc.)

## 운영 원칙

- **카탈로그 단일 소스**: `_sys/docs/slide-decks/`만 참조. 새 스타일 추가 시 거기에 파일 추가하면 본 스킬과 `notebooklm-deck` 둘 다 자동 인식
- **압축 우선**: NotebookLM master prompt 통째로 붙이지 말 것. Canva가 길면 무시함
- **영문 키워드 + 한국어 본문**: Canva의 디자인 어휘는 영문이 더 정확. 톤 설명만 입력 언어로
- **Brand Kit 권장**: 동일 스타일을 반복 사용하면 Brand Hub에 등록해 일관성 자동화
- **이미지는 Magic Media로**: 사진·일러스트가 필요하면 Canva Magic Media 프롬프트로 별도 생성. 본 스킬은 텍스트·레이아웃·컬러만 정의

## 관련 스킬

- `notebooklm-deck` — 같은 카탈로그의 NotebookLM 버전. 둘 다 만들고 싶을 때
- `meeting-notes` — 회의록 → Canva Docs to Decks 입력 소스
- `gaejosik` — Canva에 들어갈 한국어 본문 톤 보정 (개조식)
- `pptx-toolkit` — Canva → .pptx export 후 후처리

## 레퍼런스

- [`references/canva-prompt-format.md`](references/canva-prompt-format.md) — Canva AI 도구별(Magic Design / AI 프레젠테이션 / Docs to Decks) 프롬프트 입력 길이·형식·예시

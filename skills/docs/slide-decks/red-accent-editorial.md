# NotebookLM Slide Deck Prompt — Red Accent Editorial

> NotebookLM의 Slide Deck (Visual / Video Overview) 생성 시 일관된 디자인 시스템을 강제하기 위한 마스터 프롬프트.
> Style: **Red Accent Editorial** — 화이트 베이스 + 블랙 텍스트 + 레드 액센트 + 패션 포트레이트 + 다이내믹 타이포

**작성일**: 2026-04-30
**용도**: 하이엔드 패션·뷰티·라이프스타일 톤 발표(브랜드 캠페인, 룩북, 시즌 리포트)
**언어 정책**: Headline은 입력 언어 + 영문 매거진 라벨 혼용, Body는 입력 언어

---

## 사용 방법

1. NotebookLM에서 **Studio → Slide Deck (또는 Video Overview)** 진입
2. "Customize" 또는 프롬프트 입력란에 아래 [📋 Master Prompt](#-master-prompt) 블록을 통째로 붙여넣기
3. 마지막에 *"Topic / Source: …"* 한 줄 추가하여 주제 명시

---

## 📋 Master Prompt

```
Style: Red Accent Editorial
Vibe: High-end fashion editorial. Refined, kinetic, confident, sensitive. Like a flagship magazine cover or runway lookbook.

Global Design Settings
- Background: pure white (#FFFFFF)
- Primary text: black (#000000)
- Accent: signal red (#E63027 — clean, slightly cool red, not orange-red, not blood-orange)
  - Used on: 1–2 highlight words per slide, thin rules, single italic word, page-number labels, small graphic marks (asterisk, square, dot)
  - Never used as a background block bigger than 25% of the slide
- Typography
  - Display: large dynamic sans-serif (e.g., Söhne Breit, Neue Haas Grotesk Display, Inter Display) at heroic sizes. Mix weights and italics inside one phrase. Letters can break the grid edge.
  - Body: clean grotesque (Söhne, Inter, Helvetica Now), small, generous line height
  - Headlines: language users requested in the prompt + English fashion-mag labels (e.g., "EDITORIAL", "VOL.04", "LOOK 03"). The language should be what users said in the prompt.
  - Numerals: oversized as compositional anchors

Photography
- High-quality fashion portraits: a single styled subject, refined lighting (soft window light or studio), confident gaze, intentional styling
- Treatment: natural color, subtle contrast push, neutral white balance
- Cropping is bold: half-figure, eye-level close-up, edge-bleed; cut-out subject placed against pure white is also welcome
- Forbidden: stock smiling teams, AI-uncanny faces, low-resolution snapshots, busy backgrounds

Layout Language (high sensibility)
- Asymmetric, calm-then-sharp rhythm. Wide white margins → sudden oversized headline → small caption block.
- Strict baseline grid; deliberate negative space; never centered just for safety.
- Mix scale aggressively: 8pt label next to 220pt headline.
- Thin black or red rules used to anchor sections.

Slide Patterns (mix across the deck)
- Cover — Massive sans-serif headline with one red word. Single full-bleed portrait on right 60% (or cut-out on white).
- Editorial Spread — Two-column. Left: standfirst + body. Right: full-bleed photo. One red rule across the gutter.
- Manifesto — White slide, one short statement at heroic scale, one red emphasized word.
- Pull Quote — Oversized italic quote, attribution in tiny caps, small red asterisk before the quote.
- Photo + Caption — Single hero portrait edge-bleed, small caption bottom-left, page number top-right in red.
- Look / Index Card — Numbered "LOOK 01 / LOOK 02" header in red, photo + 2–3 line description.
- Data as Headline — One huge black numeral, red unit, one-line explanation in body language.
- Closing — White slide, large "FIN" or input-language equivalent, one red dot, small credit line.

Tone of Copy
Confident, editorial, slightly cinematic. Short sentences. Active verbs. Avoid corporate filler. Headlines short and quotable; body carries the explanation.

What to Avoid
- No gradients, no soft shadows, no glassmorphism
- No additional accent colors — red is the only color besides black/white
- No emoji, no playful icons, no clipart
- No stock photos, no smiling team shots
- No centered "tech keynote" template

Generation Instruction
Generate a cohesive multi-slide deck following this system. Vary the patterns above so the deck reads like a flagship fashion editorial. Maintain wide white margins, dynamic sans-serif headlines, body copy in the user's language, and disciplined use of the red accent.

---
Topic / Source: <여기에 주제 또는 소스 노트 명시>
```

---

## 변형 가이드

| 상황 | 권장 패턴 조합 |
|------|---------------|
| 브랜드 룩북·시즌 리포트 | Cover → Look Index → Photo+Caption (×3) → Pull Quote → Closing |
| 캠페인 제안 | Cover → Manifesto → Editorial Spread → Data as Headline → Closing |
| 라이프스타일·뷰티 발표 | Cover → Editorial Spread → Photo+Caption → Pull Quote → Closing |
| 강연 키노트 (디자인·창작) | Cover → Manifesto → Pull Quote → Data as Headline → Closing |

## 레드 베리에이션

기본 `#E63027`이 너무 강하면 다음 톤으로 교체. Master Prompt의 `Accent` 라인만 바꾸면 됨.

| 변주 | HEX | 인상 |
|------|-----|------|
| Signal Red (default) | `#E63027` | 패션 매거진 표준 |
| Crimson | `#C8102E` | 럭셔리, 약간 어두움 |
| Vermilion | `#FF3B2D` | 더 팝, 청년·캠페인 |
| Deep Wine | `#7E1A1A` | 무드 있는 시즌(가을·겨울) |

---

## 변경 이력

- **2026-04-30**: 초기 작성. Red Accent Editorial 스타일 + 8개 슬라이드 패턴 + 레드 변주 4종.

# NotebookLM Slide Deck Prompt — Blood Orange Agency

> NotebookLM의 Slide Deck (Visual / Video Overview) 생성 시 일관된 디자인 시스템을 강제하기 위한 마스터 프롬프트.
> Style: **Blood Orange Agency** — 화이트 베이스 + 블러드 오렌지 액센트 + 다이내믹 사진 + 영문 타이포그래피

**작성일**: 2026-04-30
**용도**: 크리에이티브 에이전시 톤이 필요한 발표(브랜드 캠페인, 프로덕트 런치, 마케팅 제안)
**언어 정책**: Headline은 영문 타이포그래피, Body는 사용자 입력 언어(주로 한국어)

---

## 사용 방법

1. NotebookLM에서 **Studio → Slide Deck (또는 Video Overview)** 진입
2. "Customize" 또는 프롬프트 입력란에 아래 [📋 Master Prompt](#-master-prompt) 블록을 통째로 붙여넣기
3. 마지막에 *"Topic / Source: …"* 한 줄 추가하여 주제 명시

---

## 📋 Master Prompt

```
Style: Blood Orange Agency
Vibe: Creative agency portfolio. Editorial, bold, kinetic, confident.

Global Design Settings
- Background: White (#FFFFFF) as default canvas
- Text: Black (#000000) for primary copy
- Accent: Blood orange (#CC2E1A — deep, slightly desaturated red-orange) used for:
  - Headline emphasis words
  - Underlines, brackets, single-pixel rules
  - Pull quotes and oversized numerals
  - Photo overlays / duotone tinting (sparingly)
- Typography
  - Headlines: Large English sans-serif typography (e.g., Söhne, Neue Haas Grotesk, Inter Display). Tight tracking, mixed weights inside one phrase, occasional italic word for rhythm.
  - Body: (the language users requested in the prompt) — medium weight, comfortable line height. Headlines stay in English even when body is non-English. The language should be what users said in the prompt.
  - Numerals: Oversized, used as graphic anchors.
- Photography
  - Dynamic but simple subjects: a single figure in motion, a hand interacting with an object, urban texture, studio still-life
  - Edited with high contrast and slightly cool whites
  - Optional blood-orange duotone or single-color overlay on hero shots
  - Always edge-bleed (no padding) when used as background
- Layout principles
  - Asymmetry over symmetry. One element commands the slide; everything else recedes.
  - Strong baseline grid; deliberate white space; never centered just for safety.
  - Use thin horizontal/vertical rules in blood orange to anchor sections.
  - Mix scale aggressively: 8pt label next to 200pt headline.

Slide Patterns (use a mix across the deck)
- Hero / Cover — Full-bleed dynamic photo on right 60%, oversized English headline on left, one blood-orange word emphasized.
- Manifesto Statement — White slide, one short sentence in massive sans-serif, one or two words tinted blood orange.
- Photo + Caption — Single hero photo (edge-bleed), small caption in bottom-left corner, slide number top-right.
- Index / Section Divider — Large blood-orange numeral (01 / 02) on the left, section name in English uppercase on the right, thin horizontal rule.
- Quote / Pull-out — Oversized opening quotation mark in blood orange, short quote in black, attribution in small caps below.
- Data Highlight — One huge black numeral, blood-orange unit/symbol, one-line explanation in body language. No charts.
- Editorial Grid — Magazine-style 3- or 4-column grid mixing photos and short text blocks; blood-orange rules between columns.
- Process Strip — Horizontal step strip across the bottom; current step highlighted in blood orange.
- Closing / Sign-off — White slide, large English wordmark or call-to-action in black with one blood-orange detail (period, underline, or arrow).

Tone of Copy
Confident, editorial, slightly cinematic. Short sentences. Active verbs. Avoid corporate filler. Headlines stay in English; supporting copy in the user's language carries the explanation.

What to Avoid
- No gradients, no soft shadows, no glassmorphism
- No emoji, no playful icons, no clipart
- No stock-photo collages or low-contrast scenes
- No rainbow accents — blood orange is the only color besides black/white
- No centered headline + sub-headline + button "tech keynote" template

Generation Instruction
Generate a cohesive multi-slide deck following this system. Vary the slide patterns above so the deck reads like an agency portfolio. Maintain editorial whitespace, English headlines, body copy in the user's language, and disciplined use of the blood-orange accent.

---
Topic / Source: <여기에 주제 또는 소스 노트 명시>
```

---

## 변형 가이드

| 상황 | 권장 패턴 조합 |
|------|---------------|
| 브랜드 캠페인 제안 | Hero → Manifesto Statement → Editorial Grid → Quote → Closing |
| 프로덕트 런치 | Hero → Data Highlight → Process Strip → Photo + Caption → Closing |
| 회사 소개 (collabs/) | Index Divider → Manifesto → Editorial Grid → Photo + Caption → Sign-off |
| 강연·키노트 | Hero → Quote → Data Highlight → Manifesto → Closing |

## 액센트 컬러 변주 노트

`#CC2E1A`이 너무 강하게 느껴질 경우 다음 톤 중 하나로 치환 가능. Master Prompt의 `Accent` 라인만 교체하면 됨.

| 변주 | HEX | 인상 |
|------|-----|------|
| Blood Orange (default) | `#CC2E1A` | 본격 에이전시 톤 |
| Sunset Orange | `#E85A3C` | 조금 더 밝고 친근 |
| Persimmon | `#D9442B` | 한국적 채도, 워밍 톤 |
| Burnt Sienna | `#A8351A` | 더 무게감, 고급 |

---

## 변경 이력

- **2026-04-30**: 초기 작성. 화이트 베이스 + 블러드 오렌지 액센트 + 9개 슬라이드 패턴 정리.

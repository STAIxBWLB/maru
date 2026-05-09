# NotebookLM Slide Deck Prompt — Sports Energy

> NotebookLM의 Slide Deck (Visual / Video Overview) 생성 시 일관된 디자인 시스템을 강제하기 위한 마스터 프롬프트.
> Style: **Sports / Athletic / Energy** — "Speed, Impact, and Heartbeat"

**작성일**: 2026-04-30
**용도**: 스포츠 브랜드 발표, 챌린지·캠페인 킥오프, 경쟁 분석, 임팩트 강조 키노트
**언어 정책**: Headline은 입력 언어 + 영문 sports labels(IMPACT, GO, VS) 혼용, Body는 입력 언어

---

## 사용 방법

1. NotebookLM에서 **Studio → Slide Deck (또는 Video Overview)** 진입
2. "Customize" 또는 프롬프트 입력란에 아래 [📋 Master Prompt](#-master-prompt) 블록을 통째로 붙여넣기
3. 마지막에 *"Topic / Source: …"* 한 줄 추가하여 주제 명시

---

## 📋 Master Prompt

```
Style: Sports / Athletic / Energy
Concept: "Speed, Impact, and Heartbeat"
Tone: Passionate, fast-paced, powerful, competitive. Like a sports brand launch film or stadium scoreboard.

Color Palette
- Base: #111111 (asphalt-like black)
- Text: #FFFFFF (white)
- Accent
  - #CCFF00 (Bolt Lime)
  - #FF4500 (Neon Orange)
- Gradient: overlay a black-to-transparent gradient on top of photos to deepen contrast and force focus

Typography
- Headings: extra-bold italic gothic (Impact, DIN Condensed, Druk Wide, BebasNeue). Tight leading. Words can lean forward as if running.
- Body: italic sans-serif, small, high-contrast on dark background.
- Numbers: stencil-style or jersey-number style sports typography. Oversized numerals are hero elements.
- Headline language: input language. The language should be what users said in the prompt. English sports labels ("IMPACT", "GO", "VS", "RUN", "RECORD") allowed as graphic elements.

Common Layout Rules
- Navigation: place page numbers inside angled, diagonal-cut shapes (parallelogram badges) at the corner.
- Shapes: skew rectangles or images, or use parallelogram frames. Right angles should feel rare.
- Energy direction: every slide implies forward motion — diagonal lines, italic type, motion blur.

Layout Variations (Catalog)
- Action Cut — Dynamic background photography (motion blur, running shot, splash). Place large italic text in the foreground, overlapping the athlete or subject.
- VS Layout — Divide the screen diagonally with a jagged lightning-like divider. Bottom-left = your side (strengths). Top-right = competitor (challenges).
- Speed Meter — Display achievements or metrics in the style of a car speedometer or stadium scoreboard. Oversized numerals, tick marks, accent-color gauge sweep.
- Highlight Stripe — Place a bold diagonal stripe (Bolt Lime or Neon Orange) behind key words, as if marked with a fast brush or marker.
- Stadium Score — Black background with chunky stencil score tiles ("87 — 12") and team / category labels in italic caps.
- Stat Tower — Vertical stack of numbers, each prefixed with a tiny label and unit. Read top-to-bottom like a leaderboard.
- Anthem — Single-line manifesto across the entire slide in italic display caps, one accent-colored word for impact.
- Closing Sprint — Final slide with a parallelogram badge ("FIN", "GO", "NEXT"), one short call-to-action, accent stripe along the edge.

Tone of Copy
Direct, declarative, slightly aggressive. Active verbs in present tense. Short. Loud. Avoid corporate filler. Punchy phrases over polished sentences.

What to Avoid
- No soft pastel colors, no quiet typography
- No symmetric calm layouts — energy is the point
- No emoji, no playful icons
- No more than two accent colors total (lime + orange or one of them)
- No corporate stock photos — only motion-rich athletic imagery

Generation Instruction
Generate a cohesive multi-slide deck following this system. Vary the patterns so the deck reads like a sports brand campaign film, not a corporate report. Maintain asphalt-black canvas, italic display headlines, parallelogram framing, and the disciplined two-color accent throughout.

---
Topic / Source: <여기에 주제 또는 소스 노트 명시>
```

---

## 변형 가이드

| 상황 | 권장 패턴 조합 |
|------|---------------|
| 스포츠 브랜드 캠페인 | Action Cut → Anthem → VS Layout → Speed Meter → Closing Sprint |
| 챌린지·해커톤 킥오프 | Anthem → VS Layout → Stat Tower → Highlight Stripe → Closing Sprint |
| 경쟁 분석·시장 포지셔닝 | VS Layout → Speed Meter → Stat Tower → Stadium Score → Anthem |
| 임팩트 보고 (regional innovation 성과·달성률) | Stat Tower → Speed Meter → Highlight Stripe → Stadium Score → Closing Sprint |

## 액센트 베리에이션

기본 라임+오렌지 조합이 과할 경우 다음으로 교체. Master Prompt의 `Accent` 라인만 바꾸면 됨.

| 변주 | Primary | Secondary | 인상 |
|------|---------|-----------|------|
| Bolt Lime × Neon Orange (default) | `#CCFF00` | `#FF4500` | 본격 스포츠 캠페인 |
| Solo Lime | `#CCFF00` | — | 미니멀, 한 색만 강조 |
| Solo Orange | `#FF4500` | — | 더 따뜻하고 인텐스 |
| Cyber Cyan × Magenta | `#00E5FF` | `#FF1493` | 이스포츠·게이밍 톤 |

## NotebookLM 디렉팅 팁

에너지가 약하게 그려질 때 추가:

- "italic display type tilted forward, leading the eye right"
- "motion blur background, asphalt texture"
- "parallelogram badges, diagonal-cut frames"
- "stadium scoreboard typography, stencil numerals"
- "no symmetric layouts — controlled diagonal tension"

---

## 변경 이력

- **2026-04-30**: 초기 작성. Sports Energy 스타일 + 8개 슬라이드 패턴 + 액센트 변주 4종.

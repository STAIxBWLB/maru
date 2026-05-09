# NotebookLM Slide Deck Prompt — Yellow Fashion Mag

> NotebookLM의 Slide Deck (Visual / Video Overview) 생성 시 일관된 디자인 시스템을 강제하기 위한 마스터 프롬프트.
> Style: **Yellow Fashion Mag** — 옐로 배경 + 다이내믹 모던 세리프 + 패션 매거진 레이아웃 + 핸드라이팅·스티커 팝

**작성일**: 2026-04-30
**용도**: 패션·라이프스타일 톤이 필요한 발표(브랜드 콜라보, 청년 캠페인, 학생 행사, 트렌드 리포트)
**언어 정책**: 헤드라인 세리프는 입력 언어, 핸드라이팅 메모/스티커는 입력 언어 또는 짧은 영문 단어 혼용

---

## 사용 방법

1. NotebookLM에서 **Studio → Slide Deck (또는 Video Overview)** 진입
2. "Customize" 또는 프롬프트 입력란에 아래 [📋 Master Prompt](#-master-prompt) 블록을 통째로 붙여넣기
3. 마지막에 *"Topic / Source: …"* 한 줄 추가하여 주제 명시

---

## 📋 Master Prompt

```
Style: Yellow Fashion Mag
Vibe: Fashion magazine spread. Bold, chic, kinetic, editorial, slightly irreverent. Like a printed indie magazine cover, not a corporate slide.

Global Design Settings
- Background: saturated warm yellow (#F5D02A — slightly mustard, not neon). Use it edge-to-edge on most slides.
- Text: pure black (#000000) for all primary copy.
- Accent moves: occasional black blocks behind a phrase (reverse out to yellow), thin black rules, hand-drawn arrows.
- Typography
  - Display: large, dynamic modern serif (e.g., Canela, Saol, GT Sectra, Söhne Mono Serif). Mix italic and roman within one phrase. Letters can break the grid (oversized, sit half off-canvas, overlap photos).
  - Body: grotesque sans-serif (e.g., Söhne, Inter, Helvetica Now), tight tracking, small.
  - Headline language: the language users requested in the prompt. The language should be what users said in the prompt. Single English fashion-mag words ("ISSUE", "VOL.04", "EDITORIAL", "INDEX") are allowed as graphic labels.
  - Numerals: oversized serif page numbers and dates, used as compositional elements.

Photography
- Unique fashion photography: a single styled subject, strong pose, expressive lighting, controlled background. Studio or location, but always intentional.
- Cropping is bold — half-figures, extreme close-ups, edge-bleed.
- Photo treatment: natural color, slight contrast push. Optional: cut-out subject placed over yellow background for collage feel.
- Avoid stock-y "smiling team" photos and AI-uncanny portraits.

Pop & Chic Layer (this is what makes the style)
- Handwritten scribbles in black marker: short notes, circles around a word, arrows pointing at details, asterisks.
- Magazine stickers: round price-tag style, "NEW", "MUST-READ", "VOL. 01", "★★★★★", small stars, stamps. Place them at angles, not aligned to the grid.
- Tape strips, paper-clip shapes, masking-tape captions — sparingly, never crowded.
- Underlines, highlighter swipes, hand-circled letters.

Layout Language (fashion magazine bold)
- Asymmetric, layered, slightly chaotic but disciplined.
- Allow elements to overlap photos and bleed off-edge.
- Mix scale violently: 200pt serif word next to 8pt caption.
- Margin discipline still required — controlled chaos, not actual chaos.

Slide Patterns (mix across the deck)
- Cover — Massive serif title that breaks the canvas, one fashion photo on the right, a couple of stickers, "ISSUE / VOL." label in the corner.
- Editorial Spread — Two-column magazine spread. Left: headline + standfirst + body. Right: full-bleed photo. Add one handwritten note across the gutter.
- Index / Contents — Numbered list (01–05) in oversized serif numerals, short article-style titles, page numbers on the right.
- Quote / Pull-out — Massive italic serif quote filling 70% of slide. Attribution in tiny caps. One sticker.
- Photo + Annotation — Single styled photo edge-to-edge. Multiple handwritten arrows/notes pointing at details (texture, color, attitude). Like a stylist's mood board.
- Data as Headline — One huge black serif numeral, short sentence next to it, hand-circled keyword.
- Sticker Wall — Collage of 5–8 stickers/labels arranged at angles, one short manifesto sentence in the middle.
- Closing — Sign-off page. Big serif "FIN" or "THE END" or input-language equivalent, one last sticker, small credit line.

Tone of Copy
Confident, editorial, slightly playful. Mix declarative one-liners with chic short phrases. Avoid corporate filler. It should read like a magazine, not a pitch deck.

What to Avoid
- No gradients, no soft shadows, no glassmorphism, no glossy 3D
- No neon yellow — keep it warm/mustard
- No overcrowded sticker dump (3–6 stickers max per busy slide, 0–1 on calm slides)
- No emoji as decoration — use proper magazine stickers and hand-drawn marks
- No photos of generic smiling teams or stock office shots

Generation Instruction
Generate a cohesive multi-slide fashion-magazine deck. Maintain the warm yellow background, dynamic serif display, fashion photography, and the pop layer of handwriting + stickers across every slide. Vary slide patterns so the deck reads like a real magazine flip-through, not a template repeated.

---
Topic / Source: <여기에 주제 또는 소스 노트 명시>
```

---

## 변형 가이드

| 상황 | 권장 패턴 조합 |
|------|---------------|
| 브랜드 콜라보 / 캠페인 제안 | Cover → Editorial Spread → Photo + Annotation → Quote → Closing |
| 학생 행사·동아리·축제 | Cover → Sticker Wall → Index → Photo + Annotation → Closing |
| 트렌드 리포트 (regional innovation 청년·라이프스타일) | Cover → Index → Editorial Spread (×2) → Data as Headline → Quote |
| 청년·MZ 대상 강의·워크숍 | Cover → Sticker Wall → Editorial Spread → Quote → Closing |

## 옐로 베리에이션 (액센트 전환)

기본 `#F5D02A`이 너무 강하면 다음 톤으로 교체. Master Prompt의 `Background` 라인만 바꾸면 됨.

| 변주 | HEX | 인상 |
|------|-----|------|
| Magazine Yellow (default) | `#F5D02A` | 매거진 커버, 가장 본격 |
| Soft Butter | `#F5E27A` | 부드러운 라이프스타일 톤 |
| Highlighter | `#FFE600` | 더 팝, 청년·캠페인 톤 |
| Mustard | `#D9A91A` | 차분하고 시즌리스, 가을 |

## 스티커·핸드라이팅 디렉팅 팁

NotebookLM이 매거진 팝 레이어를 약하게 그릴 때 추가하면 효과적:

- "marker pen scribble, black ink, slightly uneven"
- "round price-tag sticker, retro 1970s magazine"
- "rubber stamp 'NEW' tilted 12 degrees"
- "torn-paper edge with masking-tape caption"
- "five-pointed star scattered like magazine cover"

스티커는 정렬하지 말 것 — 일부러 기울이고 겹쳐야 패션 매거진 톤이 산다.

---

## 변경 이력

- **2026-04-30**: 초기 작성. Yellow Fashion Mag 스타일 + 8개 슬라이드 패턴 + 옐로 변주 4종 + 스티커 디렉팅 팁.

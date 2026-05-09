# NotebookLM Slide Deck Prompt — Sculpture Pop

> NotebookLM의 Slide Deck (Visual / Video Overview) 생성 시 일관된 디자인 시스템을 강제하기 위한 마스터 프롬프트.
> Style: **Sculpture Pop Art / Vaporwave / Neon Surrealism** — "A Free Remix of Classical Art and Modern Pop Objects"

**작성일**: 2026-04-30
**용도**: 트렌드 발표, 청년·문화 캠페인, 강연 키노트, 마케팅 어필이 필요한 발표
**언어 정책**: Headline + body 모두 입력 언어 우선

---

## 사용 방법

1. NotebookLM에서 **Studio → Slide Deck (또는 Video Overview)** 진입
2. "Customize" 또는 프롬프트 입력란에 아래 [📋 Master Prompt](#-master-prompt) 블록을 통째로 붙여넣기
3. 마지막에 *"Topic / Source: …"* 한 줄 추가하여 주제 명시

---

## 📋 Master Prompt

```
Style: Sculpture Pop Art / Vaporwave / Neon Surrealism
Concept: A free remix of classical art and modern pop objects.
Theme: Classical marble sculpture × modern neon pop (flexible style).
Tone: Bold, humorous, high-saturation, fashionable, surreal.

Visual Identity
- Background: high-saturation solid color, changing each slide. Cycle through cyan, magenta, yellow, lime, purple, hot pink, electric orange, mint.
- Collage materials
  - Sculptures: classical white marble statues — busts, full figures, gods, philosophers, athletes, children, animals. Vary the statue per slide.
  - Gadgets / pop items: sunglasses, headphones, smartphones, VR goggles, energy drinks, sneakers, donuts, boomboxes, controllers, cameras.
- Item color treatment: tune each object so its color is either complementary or analogous to the background; never disappear into the background.
- Cut-outs are clean, edges sharp, drop shadow optional and very subtle.

Typography
- Headings: ultra-bold sans-serif (e.g., Helvetica Now Display Black, Druk Wide).
- Text color: whichever color reaches highest contrast with the background — usually white, black, or a tuned accent.
- Body: clean sans-serif at small size with generous line height. Headline + body language: input language. The language should be what users said in the prompt. Single English pop-culture words ("VIBES", "DROP", "HYPE") are allowed as graphic accents.

Layout Variations (Catalog)

# --- High Impact Visuals ---
- Drink Vibes (Cover) — Vivid background. A classical bust wearing colorful sunglasses, sipping juice/soda with a straw in extreme close-up.
- Bubblegum Shock — A statue (goddess, child, etc.) blowing a large bubblegum bubble in a contrasting color. Scatter geometric shapes around the scene.
- Music Head — Dark background (black or navy). A statue wearing bright wireless headphones, immersed in music (or holding a smartphone).
- Scream Color — Bright background (yellow or lime). A statue with an expressive open-mouth pose wearing flashy-lens sunglasses.

# --- Concept Messaging ---
- Split Duality — Screen divided into two contrasting colors. A statue stands on the border, holding different modern objects in each hand (book vs tablet, pen vs smartphone).
- Selfie King — A statue lifting a smartphone for a selfie. Inside the phone screen, display SNS-style UI (likes, comments).
- VR Dive — A statue wearing VR goggles, looking upward into space. Floating 3D objects surround the scene.

# --- Information-Focused Layouts ---
- Donut Chart — Use real photos of donuts or pizza slices to build a donut chart. The statue is eating or holding the chart.
- Item List — A statue holding pop items (sneakers, skateboard, boombox). Each item has a speech bubble explaining its feature.
- Comparison (A vs B) — Two statues facing each other. One styled "Old" with classical ornamentation, the other "New" with modern accessories.
- Team Pedestal — Multiple busts placed on pedestals as team members, each personalized with different sunglasses or hats.
- QR Contact — A surreal closing slide: the statue has a QR code sticker on its forehead or holds a QR code panel.

Design Rules
- Variation: do not reuse the same statue across slides; alternate between male, female, animal, full-figure, and bust to keep visual novelty.
- Color Contrast: ensure strong contrast between background and item colors (e.g., purple background × yellow accessories).
- Isolation: cleanly cut out statues and objects from their backgrounds — keep edges sharp and precise.

What to Avoid
- No muted/pastel washes — saturation is the point
- No gradients or glassmorphism — flat color blocks only (one solid background per slide)
- No realistic environmental backgrounds (museum halls, gardens) — keep statues isolated on solid color
- No emoji as decoration — use clean cut-out objects
- No more than ~5 cut-out objects per slide — collage, not chaos

Generation Instruction
Generate a cohesive multi-slide deck following this system. Vary the background color, statue choice, and pop-object combinations every slide. Maintain ultra-bold typography, clean cut-outs, and high-saturation contrast throughout. The deck should feel like a contemporary art zine — irreverent, bold, surreal — not a corporate brand book.

---
Topic / Source: <여기에 주제 또는 소스 노트 명시>
```

---

## 변형 가이드

| 상황 | 권장 패턴 조합 |
|------|---------------|
| 트렌드 리포트 (청년·문화·MZ) | Drink Vibes → Bubblegum Shock → Selfie King → Item List → QR Contact |
| 캠페인·브랜드 키노트 | Drink Vibes → Music Head → Split Duality → Comparison → QR Contact |
| 팀·조직 소개 | Drink Vibes → Team Pedestal → Item List → VR Dive → QR Contact |
| AI 시대 강연 (전통 vs 현재) | Comparison → Split Duality → Selfie King → VR Dive → QR Contact |

## 배경 컬러 사이클 추천

같은 색을 두 번 쓰지 않도록 다음 순서를 추천. NotebookLM에 *"cycle through these backgrounds in order"* 라고 명시하면 일관성 있음.

1. `#FF3DA0` Hot Pink
2. `#3DD9FF` Cyan
3. `#FFE93D` Bright Yellow
4. `#9D4DFF` Electric Purple
5. `#00E68A` Lime Mint
6. `#FF6B1A` Electric Orange
7. `#1A1A1A` Black (Music Head 전용)

## NotebookLM 디렉팅 팁

콜라주 느낌이 약하게 그려질 때 추가:

- "classical white marble bust, photographic cut-out, sharp edges"
- "modern pop object isolated on solid color background"
- "saturated complementary palette, flat fill, no gradient"
- "contemporary art zine collage, irreverent surreal"
- "no museum environment — statue floats on color"

---

## 변경 이력

- **2026-04-30**: 초기 작성. Sculpture Pop Art 스타일 + 12개 레이아웃 + 배경 컬러 사이클 7색.

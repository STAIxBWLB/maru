# Canva AI Tools — Prompt Format Reference

Canva의 AI 프레젠테이션 도구별 입력 형식과 길이 제한, 권장 프롬프트 패턴.

## Canva의 AI 프레젠테이션 도구 4종

| 도구 | 진입 경로 | 입력 한도 | 강점 |
|------|----------|----------|------|
| **Magic Design for Presentations** | Home → Create → Presentation → "Magic Design" tab | 짧음 (~150-300자 권장) | 한 번에 다양한 템플릿 옵션 시안 생성 |
| **AI 프레젠테이션 (Magic Studio)** | Home → "Create with AI" → Presentation | 중간 (~500자) | 프롬프트 → 완성 슬라이드 전체 한번에 |
| **Docs to Decks** | Canva Docs → 긴 텍스트 작성 → "Convert to Deck" | 무제한 (긴 마크다운 입력) | 정리된 마크다운/원고를 슬라이드로 변환 |
| **Magic Write (per-slide)** | 슬라이드 위 텍스트 박스 우클릭 → Magic Write | 짧음 (단문 프롬프트) | 개별 슬라이드 본문 보강·재작성 |

## 도구별 권장 프롬프트 형식

### 1. Magic Design for Presentations

가장 많이 쓰는 진입점. 짧은 프롬프트가 핵심.

**구조 (English keyword first)**:
```
[Topic] presentation for [Audience], [N] slides.
Style: [3-5 adjectives], [palette], [typography].
Tone: [한 줄 톤].
Language: [언어].
```

**예시 (Refined Minimal Portfolio · regional innovation Y2 보고)**:
```
regional innovation Year 2 results report for academic stakeholders, 10 slides. Minimal, architectural, archival. Light gray + jet black. Helvetica Now headings, Korean gothic body. Top-left section nav, strict grid, oversized numerals. Korean primary, English labels.
```

길이: 약 240자. 한 번에 여러 템플릿 시안이 나오므로 가장 마음에 드는 것을 선택해 fine-tune.

### 2. AI 프레젠테이션 (Magic Studio)

한 번에 완성 슬라이드 세트를 생성. 프롬프트가 더 길어도 OK.

**구조**:
```
Topic: [주제]
Audience: [청중]
Slides: [N]
Style: [톤·컬러·폰트 한 문단]
Outline:
1. [슬라이드 1 제목]
2. [슬라이드 2 제목]
...
Language: [언어]
```

**예시 (Comic Story · 신입생 OT)**:
```
Topic: 인공지능학과 신입생 오리엔테이션
Audience: 1학년 신입생 (AI 처음 접하는 학생)
Slides: 8
Style: warm, hand-drawn comic, friendly. Off-white #FAF7F2 background, soft coral and dusty teal accents. Recoleta Rounded headings, friendly humanist body. One protagonist character throughout the deck.
Outline:
1. 환영 — 캐릭터 인사
2. AI는 어렵지 않다 — 일상 비유
3. 학과 커리큘럼 1년차
4. 커리큘럼 2-4년차
5. 동아리·프로젝트 기회
6. 자주 묻는 질문
7. 선배와의 대화
8. 첫 주 체크리스트
Language: 한국어
```

### 3. Docs to Decks

긴 마크다운 원고가 이미 있을 때 가장 강력. 사용자가 미리 정리한 본문을 슬라이드로 변환.

**입력 패턴**:
- H1 → 커버 슬라이드
- H2 → 섹션 슬라이드
- H3 → 서브섹션 또는 단일 슬라이드
- 짧은 단락 → 본문 텍스트
- 리스트 → 불릿
- 코드블록·표 → 그대로 보존

**팁**: 변환 전에 *"Convert to Deck"* 버튼을 누르고 나타나는 사이드바에서 **스타일 톤**을 선택. 14종 스타일 중 가까운 것의 키워드(예: "minimal architectural", "comic illustrated")로 검색해 적용.

### 4. Magic Write (per-slide)

이미 만들어진 덱에서 한 슬라이드의 본문만 보강.

**프롬프트 예시**:
- "이 슬라이드를 개조식 톤으로 다시 써줘. 항목별 한 줄."
- "Rewrite this slide as a single bold statement, English headline + Korean caption."
- "Add 3 supporting bullets in friendly tone."

## 프롬프트 길이별 전략

| 길이 | 전략 |
|------|------|
| ~150자 | 톤 + 컬러 1개 + 폰트 1개 + 슬라이드 수 (Magic Design 1차 시안용) |
| ~250자 | 위 + 레이아웃 키워드 2-3개 + 청중 (Magic Design 정밀 시안용) |
| ~500자 | 위 + outline 5-7줄 (AI 프레젠테이션 풀 생성) |
| 무제한 | 마크다운 본문 통째 (Docs to Decks) |

## 14종 스타일 → Canva 압축 프롬프트 템플릿

각 스타일별로 미리 압축된 프롬프트 시작점. 사용자 입력으로 [TOPIC]·[AUDIENCE]·[N]만 채우면 됨.

```
Anti-Gravity:
[TOPIC] for [AUDIENCE], [N] slides. Calm, airy, tech-forward. White bg with soft blue→cyan→violet gradient corners. Inter Display headings + clean grotesque body. Wide white margins, one idea per slide, calm blue accent. Apple-DeepMind product launch tone. Korean body + English headlines.

Refined Minimal Portfolio:
[TOPIC] for [AUDIENCE], [N] slides. Minimal, architectural, archival. Light gray #E9E9E9 + jet black + abundant whitespace. Helvetica Now Display Bold headings + Korean gothic body. Top-left section nav like "01. INTRO", strict grid, oversized numerals.

Blood Orange Agency:
[TOPIC] for [AUDIENCE], [N] slides. Editorial agency portfolio, kinetic, confident. White bg + black text + blood orange #CC2E1A accent. Söhne or Neue Haas Grotesk Display headings, dynamic fashion-style photos, magazine asymmetry.

Comic Story:
[TOPIC] for [AUDIENCE], [N] slides. Warm, hand-drawn instructional comic. One protagonist throughout. Off-white #FAF7F2 bg, soft coral + dusty teal accents. Recoleta Rounded headings + humanist body. Speech bubbles, panel layouts, one-protagonist storytelling arc.

Neo-Retro Dev Deck:
[TOPIC] for [AUDIENCE], [N] slides. Retro-futuristic developer aesthetic. Cream grid-paper bg, hot pink + bright yellow + cyan blocks with thick black outlines. Bold geometric sans headlines, pixel-art icons, controlled imperfection collage. 90s computer manual × AI dev tool.

Yellow Fashion Mag:
[TOPIC] for [AUDIENCE], [N] slides. Bold magazine spread. Mustard yellow #F5D02A bg + black text. Dynamic modern serif (Canela / Saol) headlines. Fashion editorial photography, scattered handwriting and round price-tag stickers, asymmetric layered layout.

Red Accent Editorial:
[TOPIC] for [AUDIENCE], [N] slides. High-end fashion editorial. Pure white bg, black text, signal red #E63027 accent only. Söhne Breit display headlines mixing italic + roman, refined fashion portraits, generous white margins.

Royal Watercolor:
[TOPIC] for [AUDIENCE], [N] slides. Painterly literary essay. Warm off-white #F4EFE6 paper bg with royal blue #1F3A93 × cinnabar red #C8262C wet-on-wet watercolor washes. GT Sectra serif headings, Tiempos body, hand-painted illustrations only (no photos).

Premium Mockup:
[TOPIC] for [AUDIENCE], [N] slides. Apple device showcase, clean tech. White or jet black bg. Apple Studio Display / iPhone / MacBook 3D mockups occupying 70-80% of slide. Electric purple #8D59E9 + acid yellow #EBE021 accents. Helvetica Now Display Bold headings English-large, Korean-small.

Sports Energy:
[TOPIC] for [AUDIENCE], [N] slides. Asphalt black #111 bg + white text + bolt lime #CCFF00 + neon orange #FF4500. Italic condensed display (Impact / Druk Wide / Bebas Neue) leaning forward. Parallelogram badges, motion-blur photography, stadium scoreboard typography.

Sculpture Pop:
[TOPIC] for [AUDIENCE], [N] slides. High-saturation pop collage. Solid bg color cycling per slide (cyan / magenta / yellow / lime / purple). Classical white marble busts wearing modern pop objects (sunglasses, headphones, smartphones). Helvetica Now Display Black headlines, surreal art zine vibe.

Constructivism Tech:
[TOPIC] for [AUDIENCE], [N] slides. Avant-garde academic dossier. Beige #E0E0D0 paper bg, charcoal #333 text, neon yellow #DFFF00 geometric shapes only. Mix of Didot/Bodoni serif + Helvetica sans, Courier monospace numerals. Triple collage covers, technical drawing diagrams, blueprint annotations.

Vitamin Pop:
[TOPIC] for [AUDIENCE], [N] slides. Friendly digital pop. White bg + neon trio (hot pink #FF3DA0 / cyan #3DD9FF / purple #9D4DFF). Bold gothic outline-text headlines, organic amoeba/cloud shapes, abstract avatar icons (two-dot eyes), SNS-style chat layouts.

Flat Illustration:
[TOPIC] for [AUDIENCE], [N] slides. Calm picture-book aesthetic. Solid pastel bg, max 3 colors total, thick uniform black outlines. Slightly deformed character (large head, small hands, two-dot eyes) recurring throughout. Recoleta Rounded headings + humanist body. Palette: cream / peach / sage.
```

## 일반 디자인 팁 (Canva 한정)

- **Brand Hub 등록**: 14종 중 자주 쓰는 스타일은 색·폰트·로고를 Brand Kit에 등록해 모든 신규 덱에 자동 적용
- **Magic Media**: 일러스트·사진이 필요하면 별도 Magic Media 프롬프트로 생성. 텍스트 프롬프트에 이미지 묘사 통합 X
- **템플릿 Lock**: Magic Design 결과 중 마음에 드는 시안을 골라 "Edit this template"로 시작하면 톤 일관성 유지하기 좋음
- **Animations**: 14종 스타일에 추가 모션 적용 시 → Page → Animate → "Subtle"·"Pan"·"Rise" 권장. "Block" / "Dramatic"은 격식 발표에 부적합
- **Export**: PDF (격식) / PPTX (회사 발표) / MP4 (소셜) — regional innovation·international cooperation 보고는 PDF 권장

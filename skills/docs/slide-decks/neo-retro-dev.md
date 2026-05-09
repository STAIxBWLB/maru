# NotebookLM Slide Deck Prompt — Neo-Retro Dev Deck

> NotebookLM의 Slide Deck (Visual / Video Overview) 생성 시 일관된 디자인 시스템을 강제하기 위한 마스터 프롬프트.
> Style: **Neo-Retro Dev Deck / Pixel-Infographic Editorial** — 90년대 컴퓨터 매뉴얼 × 모던 AI 개발툴 마케팅

**작성일**: 2026-04-30
**용도**: 빌더·개발자·AI 도구 발표. 의견 있는 기술 설명, 시스템 아키텍처, 진화 타임라인
**언어 정책**: 헤드라인은 사용자 입력 언어 + 영문 혼용, 본문은 사용자 입력 언어

---

## 사용 방법

1. NotebookLM에서 **Studio → Slide Deck (또는 Video Overview)** 진입
2. "Customize" 또는 프롬프트 입력란에 아래 [📋 Master Prompt](#-master-prompt) 블록을 통째로 붙여넣기
3. 마지막에 *"Topic / Source: …"* 한 줄 추가하여 주제 명시

---

## 📋 Master Prompt

```
Style Name: Neo-Retro Dev Deck / Pixel-Infographic Editorial

1. Core Visual Identity
Aesthetic: Retro-futuristic, developer-centric, editorial infographic style.
Feels like: 90s computer manuals · modern AI dev tools marketing · pixel-art meets startup slide deck.
Mood: Confident, playful, opinionated, slightly rebellious. "Builders explaining the future, not selling fluff."

2. Canvas & Background
- Light cream / off-white grid paper background
- Subtle square grid (engineering notebook feel)
- Grid lines very light, never distracting
- Slides should feel like annotated engineering notes, not corporate PPTs

3. Typography System
Primary headline font: bold, heavy sans-serif with strong geometry. Black text. Slightly condensed. High contrast against background.
Language mixing:
- Headlines can mix the language users requested in the prompt with English (the language should be what users said in the prompt)
- English sub-labels under primary-language titles (small, clean)
Hierarchy: huge bold headline blocks → medium sub-titles → small explanatory captions below icons or boxes.

4. Color Palette (Strict)
High-contrast blocks with thick black outlines:
- Hot Pink — agent / brain / intelligence concepts
- Bright Yellow — editor / code / tools
- Cyan / Light Blue — browser / web / execution
- Black — text, borders
- White / cream — background
Each section = one dominant color block.

5. Layout Language
- Stacked modular blocks
- Rectangles with thick black borders
- Slight overlaps allowed (intentional, collage-like)
- Horizontal bars for section headers
- Card-based structure for steps, evolution, layers
- Slides should feel assembled, not perfectly aligned (controlled imperfection)

6. Iconography & Graphics
Pixel-art style icons: rocket, robot/agent, gear, code brackets, browser window, chat bubbles.
Icons should look: low-resolution, 8-bit or 16-bit inspired, flat colors, black outline.
Decorative elements: small gears, arrows, chevrons <>, pixel sparks / motion lines.

7. Content Patterns (Very Important)
A. System Architecture Slides — Stacked layers with labels. Each layer: one color, one icon, one bold title, one short explanatory line. Example: Agent Manager / AI Editor / Agent-Controlled Browser.
B. Evolution / Timeline Slides — Left → right progression. Each step in its own box: Auto-complete → Chat → Agent → New Model (highlighted). Final step is visually larger and more colorful.
C. Manifesto / Thesis Slides — One huge headline in a boxed frame. Minimal text. Surrounded by playful icons. Feels like a statement, not documentation.

8. Tone of Text
Short. Declarative. Slightly opinionated. No marketing fluff.
Good: "Agents execute tasks autonomously" · "Coding enters the agent era"
Bad: "Empowering users with cutting-edge solutions"

9. What to Avoid
No gradients · no realistic photos · no soft shadows · no corporate templates · no minimalism for its own sake.
This is expressive, not quiet.

10. Generation Instruction
Generate multiple slides following this exact visual system. Maintain consistency in grid background, color usage, icon style, typography hierarchy. Slides should look like they belong to one cohesive deck, not individual posters.

---
Topic / Source: <여기에 주제 또는 소스 노트 명시>
```

---

## 변형 가이드

| 상황 | 권장 패턴 조합 |
|------|---------------|
| AI 도구·SDK 소개 | Manifesto → System Architecture → Evolution Timeline → Manifesto closer |
| 개발자 컨퍼런스 톡 | Manifesto → Evolution Timeline → System Architecture → Demo Card Grid |
| regional innovation·연구 사업 결과 보고 (개발자 톤) | System Architecture(연구 스택) → Evolution Timeline(연도별) → Result Cards |
| 학생 대상 AI 강의 | Manifesto → Evolution Timeline → System Architecture → Manifesto (call-to-action) |

## 컬러 → 의미 매핑 (확장 시 참고)

| HEX (제안) | 색 | 의미 슬롯 |
|-----------|-----|-----------|
| `#FF3DA0` | Hot Pink | agent · brain · 지능 개념 |
| `#FFE93D` | Bright Yellow | editor · code · 도구 |
| `#3DD9FF` | Cyan | browser · web · 실행 |
| `#000000` | Black | 텍스트, 모든 박스 외곽선 |
| `#FAF6E8` | Cream | 배경 (그리드 페이퍼) |

확장이 필요한 경우(예: data, security, infra) 새 색을 추가하지 말고 기존 5색 안에서 의미를 재사용하거나 명확한 슬롯 정의 후 Master Prompt를 업데이트할 것. 색이 5개를 넘어가면 Neo-Retro 톤이 무너진다.

## 픽셀 아이콘 톤 가이드

NotebookLM이 픽셀 느낌을 약하게 그릴 때 다음 표현을 추가하면 효과적:

- "8-bit / 16-bit game sprite"
- "chunky black outline, no anti-aliasing"
- "looks like a 1990s software box illustration"
- "flat fills only, no gradients, no inner shadows"

---

## 변경 이력

- **2026-04-30**: 초기 작성. Neo-Retro Dev Deck 스타일 + 3개 콘텐츠 패턴 + 5색 컬러 슬롯 매핑 + 픽셀 아이콘 톤 가이드.

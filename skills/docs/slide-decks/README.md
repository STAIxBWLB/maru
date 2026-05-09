# Slide Deck Style Prompts

플랫폼 무관 슬라이드 덱 디자인 시스템 카탈로그. NotebookLM, Canva, ChatGPT Images 2.0 등 AI 슬라이드 도구에서 일관된 시각 스타일을 강제하기 위한 마스터 프롬프트 모음.

## 사용법

본 폴더는 **카탈로그(원본 자료)**이며, 직접 사용하지 말고 다음 스킬을 통해 호출한다:

| 스킬 | 대상 플랫폼 | 출력 형식 |
|------|------------|----------|
| `notebooklm-deck` | NotebookLM Slide Deck / Visual Overview | Master Prompt 통째 + Topic/Source 한 줄 |
| `canva-deck` | Canva Magic Design / AI 프레젠테이션 / Docs to Decks | 압축 1-2문단 + 템플릿 검색어 + Brand Kit |
| `gpt-images-deck` | ChatGPT Images 2.0 / Codex native image generation | `DESIGN.md` + `slide_plan.json` + `slide_prompts.json` + `page_N.png` |

스킬을 거치지 않고 직접 사용 시:
1. 아래 카탈로그에서 스타일 1종 선택
2. 해당 파일의 `📋 Master Prompt` 블록 추출
3. 플랫폼에 맞춰 그대로(NotebookLM) 또는 압축(Canva) 후 붙여넣기

## 카탈로그

| 스타일 | 파일 | 톤 | 추천 용도 |
|--------|------|-----|----------|
| Anti-Gravity / Living Artifact | [`anti-gravity.md`](anti-gravity.md) | Calm · airy · tech-forward · gradient accents | AI/agent 제품 소개, 연구 비전, 인프라 발표 |
| Refined Minimal Portfolio | [`refined-minimal-portfolio.md`](refined-minimal-portfolio.md) | Architectural · archival · grid + whitespace | 회사·연구실 소개, regional innovation 결과 보고, 포트폴리오 |
| Blood Orange Agency | [`blood-orange-agency.md`](blood-orange-agency.md) | Editorial · kinetic · agency portfolio · blood-orange accent | 브랜드 캠페인, 프로덕트 런치, 강연 키노트 |
| Comic Story | [`comic-story.md`](comic-story.md) | Warm · narrative · hand-drawn · protagonist-driven | 강의, 튜토리얼, 온보딩, AI 리터러시, 학과 OT |
| Neo-Retro Dev Deck | [`neo-retro-dev.md`](neo-retro-dev.md) | Retro-futuristic · pixel-art · grid paper · opinionated | AI 도구 소개, 개발자 컨퍼런스, 시스템 아키텍처, 진화 타임라인 |
| Yellow Fashion Mag | [`yellow-fashion-mag.md`](yellow-fashion-mag.md) | Magazine bold · serif display · stickers · handwriting pop | 브랜드 콜라보, 청년 캠페인, 학생 행사, 트렌드 리포트 |
| Red Accent Editorial | [`red-accent-editorial.md`](red-accent-editorial.md) | White base · red accent · fashion portrait · refined sans-serif | 룩북, 시즌 리포트, 캠페인 제안, 디자인 키노트 |
| Royal Watercolor | [`royal-watercolor.md`](royal-watercolor.md) | Painterly · serif · royal blue × red wet wash · literary | 인문·문학 강연, 전시 소개, 역사 발표, 가치 메시지 |
| Premium Mockup | [`premium-mockup.md`](premium-mockup.md) | Apple device mockups · clean tech · purple+yellow accent · studio lighting | 앱·SaaS 런치, UI/UX 케이스, 프로덕트 키노트, 디지털 도구 소개 |
| Sports Energy | [`sports-energy.md`](sports-energy.md) | Asphalt black · italic display · parallelogram · lime+orange | 스포츠 캠페인, 챌린지 킥오프, 경쟁 분석, 임팩트 보고 |
| Sculpture Pop | [`sculpture-pop.md`](sculpture-pop.md) | Marble statue × pop objects · saturated solid bg · surreal collage | 트렌드 리포트, 청년·문화 캠페인, 팀 소개, 전통 vs 현재 |
| Constructivism Tech | [`constructivism-tech.md`](constructivism-tech.md) | Beige paper · charcoal serif+sans · neon-yellow geometry · drafting lines | AI 사상서, 연구 분석, 박물관·전시, 정책·인문 학술 |
| Vitamin Pop | [`vitamin-pop.md`](vitamin-pop.md) | Organic blobs · neon trio · abstract avatars · SNS-friendly | 커뮤니티, 청년 강의, 캠페인, 학생 행사 |
| Flat Illustration | [`flat-illustration.md`](flat-illustration.md) | Pastel 3-color cap · thick outlines · deformed character · picture-book | 안내 매뉴얼, 가이드, AI 리터러시, 가치 캠페인 |

## 추가 규칙

- 신규 스타일 추가 시 파일명은 `kebab-case.md`
- 각 파일은 다음 구조를 따른다: 사용 방법 → 📋 Master Prompt(코드 블록) → 변형 가이드 → 변경 이력
- 각 스타일 파일의 "사용 방법" 섹션은 NotebookLM 기준으로 작성됨. Canva·기타 플랫폼은 해당 스킬이 압축·재포맷
- Master Prompt 안의 *"the language should be what users said in the prompt"* 문구는 입력 언어 자동 감지를 위한 핵심이므로 모든 스타일 파일에서 유지
- 본 폴더는 *single-source* 위치. `notebooklm-deck`·`canva-deck`·`gpt-images-deck`과 향후 추가 스킬이 모두 여기서 읽음. 다른 곳(meeting-notes, regional innovation 등)에 동일 프롬프트 복제 금지

## 변경 이력

- **2026-04-30 (gpt-images-deck)**: ChatGPT Images 2.0 / Codex native image generation을 대상으로 하는 `gpt-images-deck` 스킬 추가. 카탈로그를 `DESIGN.md`·`slide_plan.json`·`slide_prompts.json`·페이지 이미지 생성 흐름으로 재사용
- **2026-04-30 (rename)**: `_sys/docs/notebooklm/` → `_sys/docs/slide-decks/` 폴더명 변경. 플랫폼 무관 카탈로그 성격 명료화. `canva-deck` 스킬 추가에 따라 단일 소스를 두 스킬이 공유
- **2026-04-30 (init)**: 14종 스타일 카탈로그 초기 작성 (Anti-Gravity, Refined Minimal Portfolio, Blood Orange Agency, Comic Story, Neo-Retro Dev, Yellow Fashion Mag, Red Accent Editorial, Royal Watercolor, Premium Mockup, Sports Energy, Sculpture Pop, Constructivism Tech, Vitamin Pop, Flat Illustration)

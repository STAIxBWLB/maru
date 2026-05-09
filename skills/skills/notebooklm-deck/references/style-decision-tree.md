# NotebookLM Slide Deck — Style Decision Tree

14종 카탈로그에서 발표 맥락에 맞는 스타일을 빠르게 매칭하기 위한 결정 트리.
필요 시 1순위 + 2순위를 묶어서 제시한다.

## Step 1 — 1차 분기: 발표의 본질

```
Q1. 무엇이 가장 중요한가?
├─ 정보 전달 (학습·이해) → Step 2A
├─ 인상·임팩트 (캠페인·런치)  → Step 2B
├─ 신뢰·격식 (보고·아카이브)  → Step 2C
└─ 제품 시연 (UI·디바이스)    → Premium Mockup ★
```

## Step 2A — 정보 전달

```
Q2A. 청중과 정보 밀도?
├─ 청년·일반인 / 정보 밀도 높음
│   └─ 1순위: Vitamin Pop · 2순위: Comic Story
├─ 학생·초심자 / 친근함 우선
│   └─ 1순위: Comic Story · 2순위: Flat Illustration
├─ 행정·매뉴얼·가이드 / 명료함 우선
│   └─ 1순위: Flat Illustration · 2순위: Refined Minimal Portfolio
└─ 개발자·엔지니어 / 의견 있는 톤
    └─ 1순위: Neo-Retro Dev · 2순위: Anti-Gravity
```

## Step 2B — 인상·임팩트

```
Q2B. 어떤 분위기?
├─ 스포츠·챌린지·경쟁 → Sports Energy ★
├─ 트렌드·문화·MZ
│   └─ 1순위: Yellow Fashion Mag · 2순위: Sculpture Pop
├─ 패션·라이프스타일 / 세련됨
│   └─ 1순위: Red Accent Editorial · 2순위: Blood Orange Agency
├─ 에이전시 캠페인·강연 키노트
│   └─ 1순위: Blood Orange Agency · 2순위: Anti-Gravity
└─ 예술·전시·문학 강연
    └─ 1순위: Royal Watercolor · 2순위: Constructivism Tech
```

## Step 2C — 신뢰·격식

```
Q2C. 어떤 격식?
├─ 회사·연구실·포트폴리오
│   └─ 1순위: Refined Minimal Portfolio · 2순위: Anti-Gravity
├─ AI·연구 사상서·정책 학술
│   └─ 1순위: Constructivism Tech · 2순위: Refined Minimal Portfolio
├─ regional innovation·international cooperation 사업 결과 보고
│   └─ 1순위: Refined Minimal Portfolio · 2순위: Constructivism Tech
└─ 제품·기술 비전 (calm tech)
    └─ 1순위: Anti-Gravity · 2순위: Premium Mockup
```

## Step 3 — 색·이미지 제약 체크

선택된 스타일이 **소스에 맞는지 마지막 확인**:

| 제약 | 적합 스타일 | 부적합 (피하기) |
|------|------------|----------------|
| 화려한 색 금지 (격식) | Refined Minimal · Constructivism Tech · Anti-Gravity · Royal Watercolor | Vitamin Pop · Yellow Fashion · Sculpture Pop |
| 사진 사용 가능 | Blood Orange · Red Accent · Yellow Fashion · Sports Energy · Sculpture Pop · Premium Mockup | Comic Story · Flat Illustration · Royal Watercolor (사진 대신 회화) |
| 일러스트 우선 (사진 X) | Comic Story · Flat Illustration · Royal Watercolor · Sculpture Pop | Premium Mockup · Sports Energy |
| 한국 공공기관 톤 | Refined Minimal · Constructivism Tech · Royal Watercolor · Flat Illustration | Sports Energy · Sculpture Pop · Yellow Fashion |
| 청년·창업·MZ | Vitamin Pop · Yellow Fashion · Sculpture Pop · Comic Story | Royal Watercolor · Constructivism Tech |
| 디바이스 목업 필수 | Premium Mockup ★ | (대체 불가) |

## Step 4 — 시그니처 매핑 표

특정 키워드가 등장하면 거의 자동으로 매핑되는 케이스. 사용자가 별다른 조건을 안 줘도 빠르게 추천 가능.

| 키워드 | 1순위 |
|--------|------|
| Apple, iPhone, mockup, app launch | Premium Mockup |
| 챌린지, 챔피언십, 스포츠, 우승 | Sports Energy |
| 동아리, 페스티벌, MZ, 트렌드 리포트 | Yellow Fashion Mag |
| 룩북, 시즌, 패션 캠페인 | Red Accent Editorial |
| 박물관, 전시, 시집, 에세이 | Royal Watercolor |
| 매뉴얼, 사용법, 안내, 리터러시 | Flat Illustration |
| 학과 OT, 신입생, AI 처음 | Comic Story |
| AI 도구, 개발자 컨퍼런스, dev tools | Neo-Retro Dev |
| Agent, AI 인프라, calm tech | Anti-Gravity |
| 사상서, 학술, 분석 보고 | Constructivism Tech |
| 커뮤니티, 청년, SNS | Vitamin Pop |
| 캠페인, 에이전시, 키노트 | Blood Orange Agency |
| 회사 소개, 포트폴리오, regional innovation 결과 | Refined Minimal Portfolio |
| 트렌드 리포트, 청년 문화 비틂 | Sculpture Pop |

## 자주 묶이는 페어

같은 주제로 두 가지 톤을 비교해보고 싶을 때 추천 페어:

- **격식 vs 캐주얼** — Refined Minimal Portfolio ↔ Blood Orange Agency
- **친근함 vs 학구적** — Comic Story ↔ Constructivism Tech
- **사진 톤 vs 일러스트 톤** — Red Accent Editorial ↔ Flat Illustration
- **차분 vs 임팩트** — Anti-Gravity ↔ Sports Energy
- **글로벌 vs 한국적** — Premium Mockup ↔ Constructivism Tech
- **트렌드 vs 클래식** — Yellow Fashion Mag ↔ Royal Watercolor
- **개발자 vs 일반인** — Neo-Retro Dev ↔ Vitamin Pop

## 청중×목적 빠른 매칭 매트릭스

|  | 학생 | 청년·일반 | 전문가 | 행정·격식 |
|---|---|---|---|---|
| **소개·OT** | Comic Story | Yellow Fashion | Refined Minimal | Refined Minimal |
| **강의·교육** | Comic Story | Vitamin Pop | Constructivism Tech | Flat Illustration |
| **결과 보고** | Flat Illustration | Refined Minimal | Constructivism Tech | Refined Minimal |
| **캠페인·런치** | Yellow Fashion | Blood Orange | Premium Mockup | Anti-Gravity |
| **연구 발표** | Anti-Gravity | Anti-Gravity | Constructivism Tech | Refined Minimal |
| **이벤트·행사** | Yellow Fashion | Sculpture Pop | Blood Orange | Royal Watercolor |

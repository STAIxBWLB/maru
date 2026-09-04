# hwp-cli 렌더/변환 능력·한계 매트릭스

스킬이 위임하는 hwp-cli의 렌더링·변환 능력 요약. 사용자에게 결과 기대치를 정확히 전달하기 위한 참조표.

**SSOT**: `dev/hwp-cli/docs/design/12-feature-gaps.md`(갭 카탈로그 GA~GM, §7.2 works). 이 표는 그 요약본이며 상세·근거는 SSOT를 본다.

범례: **지원** 렌더/추출됨 · **근사 지원** 일부 표현이 기준 구현과 다름 · **미지원** 드롭/블랭크 또는 명시적 거부

## 렌더링 (render / to-pdf / render-pdf)

| 요소 | 상태 | 비고 |
|------|------|------|
| 텍스트·문단·표·이미지(기본 배치) | 지원 | |
| **수식(mini-TeX)** | 근사 지원 | HWPX·HWP5 자동 조판. 행렬·큰연산자 극한·복잡 구분자는 근사 (`equation-syntax.md`) |
| 리스트 마커(불릿·번호), 글자 음영, 장평(x_scale) | 지원 | |
| 위/아래첨자, 밑줄색, 셀 세로정렬·여백, 자동 행높이 | 지원 | |
| 양각/음각/외곽선/그림자 on-off, 도형 그러데이션 fill | 지원 | on-off만 |
| 본문 다단(multi-column) 흐름 | 지원 | 본문 기준 |
| 각주 참조 | 지원 | 미주는 각주처럼 렌더(GG-14) |
| 글상자 다단, 세로쓰기 | 근사 지원 | 단일 단·가로 강제(GC-6/GC-1) |
| 양쪽정렬(justify), 자간, 테두리 선종류, 셀/문단 해칭·그러데이션 | 근사 지원 | 근사/solid만(GG-3~7) |
| 밑줄·취소선 모양, 그림자 오프셋, 이미지 회전/클립/반전 | 근사 지원 | 기존 문서 렌더 기준(GG-9~11,15). DocumentSpec v2 신규 image의 crop/90도 단위 회전은 explicit policy에서 deterministic PNG fallback |
| 홀짝/첫쪽 다른 머리말·꼬리말 | 근사 지원 | 단일만(GG-16) |
| 페이지 번호 | 근사 지원 | 시작·재시작·숨김, pgnp 위치/장식, PAGE 자동번호 렌더 지원. 미지원 번호 서식은 십진수 경고 폴백(GG-13 해소, 2026-07-30) |
| 방점, 개요 번호, 단 구분선 | 미지원 | 렌더 안 됨(GG-8,12,17) |
| 차트, OLE, 동영상, 글맵시, 양식개체, 묶음, 메모, 변경추적, 바탕쪽 | 미지원 | 렌더 블랭크(GB-1~10) |

## 변환 타깃 (convert --to)

| 타깃 | 상태 | 비고 |
|------|------|------|
| `hwpx` `hwp` | 지원 | 변환·semantic regeneration 결과는 byte identity 미보장. replace-only와 TemplateSpec `reference_hwpx` package patch는 미수정 entry의 압축 bytes·ZIP metadata 보존 |
| `pdf` | 지원 | 텍스트 선택가능(권장: `to-pdf`) |
| `md` `html` `json` `odt` | 근사 지원 | 링크 URL·이미지·각주 마커·병합셀·중첩셀·리스트 평탄화 손실 있음(GH-1~7). markdown-HTML은 `to-html` |
| `docx` | 미지원 | 수요 최상위지만 부재(GJ-1) |
| `hml`(HWPML), HWP 3.x, RTF, CSV, txt | 미지원 | (GJ-2~6) |

## 필드·템플릿·편집

| 기능 | 상태 | 비고 |
|------|------|------|
| versioned structured authoring (`compose`) | capability-gated | Maru UX는 `hwpx compose --spec ... --output ... [--dry-run] [--report]`. v1은 섹션·스타일·목록·문단·표·그림·수식·필드·머리말/꼬리말·페이지를 native 합성. v2는 v1 문서에 target-aware `image`/closed SVG/`text_box` visual, 필수 alt, inline-only placement를 추가. SVG와 crop/rotation은 explicit policy에서 deterministic PNG; HWPX text_box만 native. chart/diagram/arbitrary shape/floating/SVG text는 typed failure |
| typed data template (`template`) | source 구현 / capability-gated | TemplateSpec/Data v1 JSON/YAML의 string·number·bool·date·enum·list·rich_blocks, default·constraint, explicit `value`·`if`·`each` AST를 native executor로 처리. 표현식·암묵적 coercion·data 기반 asset path는 거부. `compose`, package-preserving `reference_hwpx`, strict `reference_regenerate` 모드를 report schema와 함께 제공하며 실제 `hwp template --help` surface가 없으면 출력 전 실패 |
| 자동 인증 (`certify`) | source 구현 / capability-gated | Frozen policy/report/oracle v1으로 package, repeat import, 12개 정책 규칙, bounded native render, typed issue/font evidence와 선택적 trusted oracle을 검사. Maru는 native atomic artifact directory의 closed schema·hash·tree를 재검증하고 exit code를 보존. 배포 pin v0.4.1에는 없으며 공개 trusted oracle image도 없음. `native_only`는 Hancom parity 주장이 아님 |
| 구조 문서 corpus (`corpus`) | source 구현 / capability-gated | 자체 작성 7개 대표 category를 HWPX/HWP로 각 2회 생성하고 byte determinism, reopen, bounded target-neutral semantic digest, native certification와 page/render evidence를 자동 대조. manifest/schema/font/policy hash와 artifact tree를 Maru가 다시 검증함. 수작업·ambient font·runtime network 불필요. category 전체 기능, cross-platform pixel identity, 독립 office/Hancom parity는 주장하지 않음 |
| 슬롯(`{{name}}`) 나열·치환(`slots`/`fill`) | 지원 | package patch 기반 고충실도 경로. 최종 `validate` 필요 |
| 필드(누름틀) 나열(`fields`), 값 채우기(`edit --set-field`) | 지원 | 기존 필드 값만(GF-3) |
| 책갈피 나열(`bookmarks`) | 지원 | |
| 12종 필드 파싱 | 지원 | 미지 필드는 %unk, 색인/루비/겹침은 미파싱(GF-1/2) |
| 표 행/열 추가·삭제, 셀 병합·분할 | 지원 | `edit` 지원. 열 편집·병합·분할은 병합 셀 표 지원, 행 편집은 병합 행 거부(GK-1/2/9 해소) |
| 표 신규 저작 / 기존 문서 앵커 삽입·개체 삭제 | compose 지원 / edit 미지원 | DocumentSpec v1은 병합 셀·중첩 block 표를 신규 저작. 기존 문서의 임의 위치 표 삽입과 일반 개체 삭제는 없음(GK-3/8) |
| 머리말·꼬리말, 페이지 설정·번호, 명명 스타일 | compose 신규 저작 지원 / edit 미지원 | DocumentSpec v1은 default·odd·even 머리말/꼬리말과 section별 page override·십진 페이지 번호·명명 스타일을 지원. distinct first-page와 비십진 번호는 typed `unsupported_native`; `styled --header/--footer`와 기존 문서 구조 편집은 미지원 |
| 수식 읽기·semantic HWPX 합성·왕복·렌더 | 근사 지원 | writer가 semantic IR의 수식 script를 `<hp:equation>`으로 합성하고 기존 수식을 왕복함. mini-TeX 고급 조판과 합성 기본 속성은 근사(GD-1~4, GE-14 해소) |
| 수식 신규 저작 / 기존 수식 편집 | compose 지원 / edit 미지원 | DocumentSpec v1의 block·run `equation`으로 versioned native 신규 저작. 기존 문서의 수식 script 수정 전용 명령은 없음(`equation-syntax.md`) |

## 열기 거부

- 암호화 HWP5와 배포용 HWP5는 감지 후 명시적으로 열기를 거부하며 출력 파일을 만들지 않음.
- DRM·전자서명 적용 문서는 지원 대상이 아니며, 일부는 lower-level OLE/record parse 단계에서
  실패할 수 있음. 정상 해석·보존·서명 유효성 유지를 보장하지 않으며 자동 fallback도 제공하지 않음.

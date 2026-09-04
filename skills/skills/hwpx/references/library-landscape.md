# HWPX/HWP 라이브러리 지형

조사 기준일: 2026-07-31.

이 문서는 공개 프로젝트의 공식 README·라이선스와 로컬 `hwp-cli`·`hwpx` 스킬 소스를
구분하여 기록한다. 아래에서 "프로젝트 설명"은 해당 프로젝트가 공개한 자기 설명이며,
Maru 팀이 그 기능 전체를 독립 검증했다는 뜻이 아니다.

## 현재 선택

- **1순위 엔진**: `hwp-cli` Rust 네이티브 코어. 신규 생성·읽기·편집·변환·렌더·검증 담당.
- **참조 문서 보존 편집**: replace-only와 TemplateSpec `reference_hwpx` package patch는
  수정하지 않은 entry의 압축 bytes와 ZIP metadata를 보존한다. ZIP/XML 구조 편집과
  semantic regeneration은 byte identity를 보장하지 않으며, 지원하지 않는 개체의 drop
  가능성을 검증 결과로 드러내야 한다.
- **목표 포맷**: HWPX 우선. 바이너리 HWP는 읽기·제한 편집·변환 범위에서 지원.
- **외부 프로젝트**: 런타임 의존성으로 결합하지 않고, 기능·테스트·포맷 해석의 비교 근거로
  사용. 공식 모델과 라이선스를 확인하지 않은 코드는 복사하지 않음.

현재 source workspace에는 DocumentSpec v1/v2, TemplateSpec/Data v1과 certification v1의
CLI·MCP·Maru handoff, hash-pinned structured corpus v1의 CLI·Maru handoff가
구현되어 있다. v2는 target-aware raster/SVG/text-box visual, 접근성 description,
deterministic PNG fallback과 redacted report까지 포함한다. 다만 배포된 hwp-cli를 실제 help surface로 확인하는 capability gate를
통과해야 사용할 수 있으며, Maru release pin 갱신 전에는 설치본에 따라 출력 전에 실패한다.
이 구현이 모든 HWPX 저작 기능을 제공한다는 뜻은 아니다. 실제 구현 상태는
`capability-matrix.md`를 따르며, 아래 "목표 계약"은 미출시 기능도 포함한다.

## 도구별 비교

| 도구 | 공식 설명 기준 범위 | 플랫폼 | 라이선스 | 이 스킬에서의 판단 |
|------|----------------------|--------|----------|--------------------|
| **raw ZIP/XML + lxml** | HWPX package/XML 탐색, 슬롯 치환, 제한적 구조 편집 | Windows/macOS/Linux | lxml BSD-3-Clause | 로컬 구현 확인. 전체 OWPML 저작기나 조판기는 아니며 `validate`의 기본 엔진도 아님 |
| **hwp-cli** | HWP5/HWPX 읽기·쓰기·추출·변환·렌더·편집·신규 생성·구조 검증 | macOS/Linux/Windows/CI | MIT OR Apache-2.0 | 로컬 소스·테스트 확인. 스킬의 1순위 엔진. DocumentSpec v1/v2, typed TemplateSpec과 frozen certification v1은 source 구현됨. v2 SVG는 closed geometry subset을 PNG로 변환하며 text/font/external reference를 허용하지 않음. 일부 native 개체·정밀 조판은 아직 부족 |
| [**hwpxlib**](https://github.com/neolord0/hwpxlib) | Java HWPX 읽기·쓰기, 객체 탐색, 빈 문서 생성. 암호화 기능은 별도 `hwpxlib_ext` | JVM | Apache-2.0 | 공식 README·라이선스만 확인. Java 객체 모델과 호환 사례 참조용, 런타임 미사용 |
| [**pyhwpx**](https://github.com/martiniifun/pyhwpx) | `pywin32` 기반 한/글 HwpAutomation 래퍼 | Windows + 한/글 설치 | MIT | 공식 README·라이선스만 확인. 실제 한/글 애플리케이션 자동화가 필요한 Windows 환경의 비교 기준이며, 크로스 플랫폼 게이트에는 사용하지 않음 |
| [**pyhwp**](https://github.com/mete0r/pyhwp) | HWP v5 파서·내부 스트림 추출, 실험적 ODT/TXT 변환 | Windows/macOS/Linux | **AGPL-3.0-or-later** | 공식 README·라이선스만 확인. 레거시 HWP 분석 폴백 후보. 기존 문서의 GPLv3 표기는 부정확했음 |
| [**airun-hwp**](https://github.com/chaeya/airun-hwp) | HWPX를 Markdown/PDF로 변환, 이미지·표 추출. HWP는 평문 추출 중심 | Windows/macOS/Linux | MIT | 공식 README·라이선스만 확인. 저작기가 아니라 추출·변환 도구. PDF는 LibreOffice 또는 Markdown→WeasyPrint 경로 |
| [**hwp-extract**](https://github.com/volexity/hwp-extract) | HWP 내장 파일·메타데이터 추출, 암호를 제공한 암호화 문서 지원 | Windows/macOS/Linux | **BSD-3-Clause** | 공식 README·라이선스만 확인. 포렌식 전용이라고 한정할 수 없으며, 일반 문서 저작·렌더 도구도 아님 |
| [**hwpx** (`ilco`, PyPI)](https://pypi.org/project/hwpx/) | PyPI 설명은 "example package" 수준의 경량 패키지 | Python | MIT | `python-hwpx`·`pyhwpx`와 다른 패키지. 이 스킬의 엔진으로 사용하지 않음 |
| [**H2Orestart**](https://github.com/ebandal/H2Orestart) | HWPX를 LibreOffice에서 열어 ODT로 가져오는 확장. headless PDF 변환 가능, HWPX 저장은 지원하지 않음 | LibreOffice | **GPL-3.0** | 공식 README·라이선스만 확인. 네이티브 PDF 기본 엔진이 아니라 독립 import/export smoke용 선택 도구 |
| [**rhwp**](https://github.com/edwardkim/rhwp) | Rust/WASM HWP5·HWPX·일부 HML 파싱·저장·렌더. 표·수식·이미지·차트·머리말/꼬리말·바탕쪽·세로쓰기 등을 지원한다고 설명 | Windows/macOS/Linux/Web | MIT | 공식 README의 프로젝트 주장만 확인. 넓은 렌더·개체 범위와 회귀 테스트 설계의 주요 비교 기준 |
| [**hwp-mcp**](https://github.com/treesoop/hwp-mcp) | `rhwp` 기반 MCP 서버. HWP/HWPX 읽기·렌더, HWPX 신규 생성·치환·표·이미지·서식 편집 도구 제공 | Windows/macOS/Linux | MIT | 공식 README의 공개 도구 범위만 확인. 도구 수는 버전별로 바뀌므로 고정하지 않으며, agent-facing 기능 노출과 CLI/MCP parity의 비교 기준으로 사용 |
| [**python-hwpx**](https://github.com/airmang/python-hwpx) | 순수 Python HWPX 읽기·편집·생성·검증. 수정 영역 중심 저장과 고수준 `HwpxDocument` API를 제공한다고 설명 | Windows/macOS/Linux/CI | Apache-2.0 | 공식 README·라이선스만 확인. 고수준 저작 API, 보존 리포트, 템플릿·검증 워크플로의 주요 비교 기준 |
| [**kordoc**](https://github.com/chrisryugj/kordoc) | HWP3/HWP5/HWPX/HWPML/PDF/Office 파싱, Markdown 변환, 문서 비교, HWPX 양식 채우기, CLI/MCP | Windows/macOS/Linux | MIT | 공식 README의 프로젝트 주장만 확인. 광범위 입력, diff, form-fill agent workflow 비교 기준 |
| [**Hancom OWPML model**](https://github.com/hancom-io/hwpx-owpml-model) | C++ OWPML 요소 생성·추출·저장 모델과 첫 섹션 텍스트 추출 예제 | Windows/Visual Studio 2017 | Apache-2.0 | 한컴 공개 모델. 요소·열거값·패키지 구조 해석의 우선 참고 자료이며 완성형 조판기 아님 |
| [**Hancom DVC**](https://github.com/hancom-io/dvc) | JSON spec으로 글자/문단 모양, 표, 특수문자, 테두리, 글머리표, 번호, 스타일, 하이퍼링크, 매크로 정책 검증 | Windows/Visual Studio 2017 | Apache-2.0 | 한컴 공개 검증 예제. package parse를 넘어서는 정책 검증 모델의 비교 기준 |

외부 도구는 이 조사에서 설치·실행하지 않았다. 버전별 기능과 호환성은 바뀔 수 있으므로 도입
결정 전에는 고정 버전과 동일 corpus로 재검증한다.

## 비교에서 드러난 부족한 부분

| 영역 | 현재 확인된 부족 | 비교 근거 |
|------|------------------|----------|
| 고수준 저작 API | DocumentSpec v1의 구조 문서와 v2의 target-aware image/SVG/HWPX text-box 합성은 해소. 차트·다이어그램·임의 native 도형·floating·SVG text, 세로쓰기와 기존 문서 구조 편집은 남음 | python-hwpx |
| 조판·개체 범위 | v2 신규 image crop/90도 회전과 closed SVG는 deterministic PNG fallback 지원. 홀짝/첫쪽 정밀 차이, 세로쓰기, 바탕쪽, native 차트·도형, HWP text-box, 고급 수식은 미지원 또는 근사 | rhwp |
| agent surface | `hwp template`·`hwp_template`·Maru `hwpx template`은 같은 executor와 report schema로 구현됨. 나머지 CLI 편집 기능의 MCP·skill parity와 배포 pin은 계속 보강 필요 | hwp-mcp, kordoc |
| 참조 양식 | TemplateSpec/Data v1 source 구현으로 타입·기본값·제약·조건·반복·rich block과 scalar placeholder/field binding은 해소. package-preserving mode의 구조 반복과 rich-content field 교체는 의도적으로 금지하고 explicit regeneration 필요 | python-hwpx, kordoc |
| 보존 보증 | `reference_hwpx`는 선택 section만 바꾸고 나머지 entry의 압축 bytes와 central metadata를 보존하며 report를 반환. semantic regeneration에서 지원하지 않는 모든 개체를 탐지하는 coverage와 독립 importer 증명은 남음 | python-hwpx |
| 검증 | certification v1 source 구현으로 package/repeat import, 12개 정책 규칙, 폰트·접근성·미해결 필드와 selected-page overflow/collision/blank/pagination 검사를 typed evidence로 제공. structured corpus v1은 7개 대표 category의 HWPX/HWP 각 2회 생성, reopen, 공통 semantic projection, page/render evidence를 source-built CI에서 자동 대조. fixture가 다루지 않는 native object의 정밀 렌더와 Hancom parity는 주장하지 않음 | Hancom DVC, rhwp |
| 독립 호환성 | optional/required trusted oracle 계약과 attestation·bounded log·PDF artifact gate는 구현됨. 공개 trusted oracle image는 없으므로 운영 환경이 고정 runtime/extension/image를 제공하지 않으면 unavailable이며 자동 통과로 간주하지 않음 | H2Orestart, rhwp |

## 목표 계약

다음은 전체 제품의 **구현 목표이며 현재 릴리스 기능 선언이 아니다**. certification v1은 source에
구현됐지만 배포 pin v0.4.1에는 포함되지 않는다.

- HWPX-first structured document authoring. 공문, 기안문, 보고서, 사업계획서, 회의록,
  학술·교육 문서, 인쇄 양식을 사람의 후편집 없이 생성.
- native Rust core. 문서 schema, builder/editor, package writer, renderer, validator를
  `hwp-cli`가 소유하고 Maru 스킬은 얇은 orchestration·template 계층으로 유지.
- native-first safe fallback. HWPX native 개체를 우선 생성하고, 안전하게 표현할 수 없는 시각
  효과만 SVG/PNG로 대체. 의미 원본·대체 이유·접근성 텍스트를 report에 기록.
- fail closed. 표현·보존·검증을 보장할 수 없는 요청은 불완전한 파일을 성공으로 반환하지 않음.
- open-source-only automated gate. CI와 배포 성공 판정은 한컴오피스 설치 없이 재현 가능해야 함.
- Hancom-certified pixel parity는 주장하지 않음. 한컴 제품·버전·PDF 출력 경로에 따라 결과가
  달라질 수 있으며, 독립적인 한컴 인증 corpus가 없는 상태에서 "한컴과 동일"로 표시하지 않음.

OLE 애플리케이션, 실행 매크로, 동영상, 협업 변경 추적처럼 정적 HWPX 문서 생성 계약을 벗어나는
기능은 신규 생성 대상에서 제외한다. 참조 문서에 이미 존재하면 수정하지 않은 개체는 보존하거나,
보존을 입증할 수 없을 때 명시적으로 실패한다.

## 자동 검증 계약

수동 "한컴에서 열어 보기"를 성공 조건으로 사용하지 않는다. source-built `hwp certify`와
`hwp corpus`는 아래 자동 검증을 frozen report로 구현하며, 검증되지 않은 단계를 통과로
표시하지 않는다. corpus는 hash-pinned OFL 폰트·policy·spec/data만 사용하고 ambient font와 runtime
network에 의존하지 않는다.

1. **package**: ZIP/OPC 구조, `mimetype`, manifest, 필수 part, XML parse, relationship와 resource
   참조 무결성 검사.
2. **semantic**: 생성 파일 재열기, 텍스트·필드·슬롯·표 구조·메타데이터 대조, patch 경로의
   미수정 part byte identity와 unsupported-object 보존 검사.
3. **policy**: DVC 방식의 JSON 규칙으로 허용 폰트·스타일·번호·표·링크·메타데이터·매크로
   정책 검사.
4. **reopen**: `hwp-cli`가 출력물을 다시 parse하고 같은 semantic model과 페이지 수를
   재현하는지 검사.
5. **render**: policy가 선택한 페이지(또는 `all`)를 렌더하여 overflow, clipping, collision,
   누락 폰트, 미해결 필드, 예기치 않은 빈 페이지와 pagination drift 검사.
6. **independent import**: runner image는 변경 불가능한 image digest로 고정하고,
   LibreOffice와 H2Orestart 설치 artifact는 package lock과 checksum으로 고정한다.
   실행 report에는 추정한 배포판 버전이 아니라 실제 `soffice --version`, runner image ID,
   확장 package ID·version·checksum을 기록한다. 파일마다 120초 안에 PDF를 생성하고 인증
   artifact에는 `oracle/import.pdf`와 hashed bounded stdout/stderr evidence를 보존.

각 단계 결과와 fallback·경고·폰트 대체·보존 결과·출력 hash를 기계 판독 가능한 report로
남겨야 한다. independent import 상태는 `passed`, `failed`, `oracle_unavailable` 중 하나로
기록한다. 확장 설치 실패, 실행 파일 부재, 시작 timeout은 `oracle_unavailable`이며 성공이나
호환 인증으로 간주하지 않는다. required oracle의 `oracle_unavailable`이면 전체 `partial`,
required oracle `failed` 또는 local 검사 실패이면 `failed`, 모든 필수 단계가 통과한 경우에만
`passed`로 판정한다. optional oracle failure는 `partial`, optional unavailable은
`passed/native_only`다. 이 smoke는
독립 구현의 import 가능성만 확인하며 Hancom 호환 인증이나 pixel parity를 뜻하지 않는다.

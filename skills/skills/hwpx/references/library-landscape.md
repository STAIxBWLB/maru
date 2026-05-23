# HWPX/HWP 라이브러리 지형

이 스킬의 기본 경로는 raw ZIP/XML 처리와 bundled OpenJDK + hwpxlib writer다. 그 외 도구들은 언제 필요한지 정리.

## 비교 표

| 라이브러리 | pip / 경로 | 범위 | 플랫폼 | 라이선스 | 언제 쓰는가 |
|-----------|-----------|------|--------|----------|------------|
| **raw ZIP/XML + lxml** | 스킬 내장 | HWPX 읽기·검증·slot 추출·단순 치환 | Windows/macOS/Linux | lxml BSD 계열 | 기본 read/fill/edit/slots/validate |
| **hwpxlib** (neolord0) | bundled Java + jar | HWPX 쓰기 | 플랫폼 독립 (JVM) | Apache-2.0 | `write-java`, `styled`, `export-html` 기본 writer |
| **pyhwpx** (martiniifun) | `pip install pyhwpx` | 한/글 COM 자동화 | **Windows 전용** (Hancom Office 설치 필수) | MIT | Windows에서 Hancom Office로 직접 렌더·인쇄·검증 |
| **pyhwp** (mete0r) | `pip install pyhwp` | HWP v5 바이너리 → 텍스트/HTML | Windows/macOS/Linux | GPLv3 | 레거시 `.hwp` 파일 읽기 (`hwp5txt`, `hwp5html`) |
| **airun-hwp** | `pip install airun-hwp` | HWP/HWPX → Markdown/PDF | Windows/macOS/Linux | MIT | LLM-friendly 추출 (변환 전용) |
| **hwp-extract** (volexity) | `pip install hwp-extract` | HWP 내장 객체 추출 | 플랫폼 독립 | 보안연구용 | 포렌식·악성코드 분석 |
| **hwpx** (ilco, PyPI) | `pip install hwpx` | **스텁** (2.5KB) | - | - | **사용하지 말 것** - 이름이 비슷해서 헷갈림 |
| **H2Orestart** (ebandal) | LibreOffice 확장 | HWPX 읽기 (ODT/PDF 변환) | LibreOffice | LGPL | `./hwpx to-pdf`의 PDF 변환 엔진 |
| **hwp-toolkit** (워크스페이스) | `dev/hwp-toolkit/` | HWP/HWPX 통합 CLI | macOS/Linux | - | 레거시 `.hwp` 읽기·변환 - 이 스킬이 위임 |
| **hwpx-owpml-model** (Hancom) | C++ | OWPML 공식 레퍼런스 | - | 오픈소스 | element 이름 ground truth 조회용 |

## 선택 가이드

```
HWPX 파일을 다뤄야 한다
├─ 텍스트 추출/slot 치환/구조 검증 → raw ZIP/XML 경로 (본 스킬 기본)
├─ 신규 HWPX 생성 → bundled hwpxlib writer (`write-java`, `styled`)
├─ Windows에서, 한컴오피스 있음 → pyhwpx (COM, 직접 렌더 가능)
├─ PDF로 변환만 필요 → LibreOffice + H2Orestart (`./hwpx to-pdf`)
└─ LLM 파이프라인의 텍스트 추출 → airun-hwp 또는 `./hwpx to-md`

HWP (바이너리) 파일을 다뤄야 한다
├─ 텍스트 추출 → pyhwp (`hwp5txt`, `hwp5html`) 또는 hwp-toolkit
├─ HWPX로 변환 → hwp2hwpx (neolord0) 또는 Hancom Office
└─ 포렌식 → hwp-extract
```

## 검증 중첩

가장 엄격한 검증은:

1. `./hwpx validate` - 구조 검증 (mimetype, 필수 파일, XML 파싱)
2. `./hwpx read` / `./hwpx slots` - 실제 텍스트와 field 추출 확인
3. hwpxlib Java validator - 공식 스키마 검증 (선택)
4. Hancom Office에서 수동 열기 - 렌더링 검증 (최종)

자동화는 1~3, 4는 사용자 수동.

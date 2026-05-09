# HWPX/HWP 라이브러리 지형

이 스킬은 `python-hwpx`를 기본 사용한다. 그 외 도구들은 언제 필요한지 정리.

## 비교 표

| 라이브러리 | pip / 경로 | 범위 | 플랫폼 | 라이선스 | 최종 업데이트 | 언제 쓰는가 |
|-----------|-----------|------|--------|----------|---------------|------------|
| **python-hwpx** (airmang) | `pip install python-hwpx` / import `hwpx` | HWPX 읽기·편집·생성 + 표·이미지·헤더/푸터·스타일 | Windows/macOS/Linux | Non-Commercial | 2026-04 (v2.9.x), 워크스페이스는 v2.5 | **기본** — 이 스킬의 엔진 |
| **hwpxlib** (neolord0) | Java 필요 | HWPX 읽기·쓰기 | 플랫폼 독립 (JVM) | Apache-2.0 | 2025-11 (v1.0.8) | 검증 validator로 사용 (`java -jar`) 또는 상업 사용 시 대안 |
| **pyhwpx** (martiniifun) | `pip install pyhwpx` | 한/글 COM 자동화 | **Windows 전용** (Hancom Office 설치 필수) | MIT | 2026-03 | Windows에서 Hancom Office로 직접 렌더·인쇄·검증 |
| **pyhwp** (mete0r) | `pip install pyhwp` | HWP v5 바이너리 → 텍스트/HTML | Windows/macOS/Linux | GPLv3 | 2023 (오래됨) | 레거시 `.hwp` 파일 읽기 (`hwp5txt`, `hwp5html`) |
| **airun-hwp** | `pip install airun-hwp` | HWP/HWPX → Markdown/PDF | Windows/macOS/Linux | MIT | 2025 | LLM-friendly 추출 (변환 전용) |
| **hwp-extract** (volexity) | `pip install hwp-extract` | HWP 내장 객체 추출 | 플랫폼 독립 | 보안연구용 | — | 포렌식·악성코드 분석 |
| **hwpx** (ilco, PyPI) | `pip install hwpx` | **스텁** (2.5KB) | — | — | 2025-08 | **사용하지 말 것** — 이름이 비슷해서 헷갈림 |
| **H2Orestart** (ebandal) | LibreOffice 확장 | HWPX 읽기 (ODT/PDF 변환) | LibreOffice | LGPL | 2025-10 | `./hwpx to-pdf`의 PDF 변환 엔진 |
| **hwp-toolkit** (워크스페이스) | `dev/hwp-toolkit/` | HWP/HWPX 통합 CLI | macOS/Linux | — | 워크스페이스 로컬 | 레거시 `.hwp` 읽기·변환 — 이 스킬이 위임 |
| **hwpx-owpml-model** (Hancom) | C++ | OWPML 공식 레퍼런스 | — | 오픈소스 | — | element 이름 ground truth 조회용 |

## 선택 가이드

```
HWPX 파일을 다뤄야 한다
├─ macOS/Linux에서, 한컴오피스 없이 → python-hwpx (본 스킬)
├─ Windows에서, 한컴오피스 있음 → pyhwpx (COM, 직접 렌더 가능)
├─ Java 생태계 / 상업 재배포 → hwpxlib
├─ PDF로 변환만 필요 → LibreOffice + H2Orestart (`./hwpx to-pdf`)
└─ LLM 파이프라인의 텍스트 추출 → airun-hwp 또는 `./hwpx to-md`

HWP (바이너리) 파일을 다뤄야 한다
├─ 텍스트 추출 → pyhwp (`hwp5txt`, `hwp5html`) 또는 hwp-toolkit
├─ HWPX로 변환 → hwp2hwpx (neolord0) 또는 Hancom Office
└─ 포렌식 → hwp-extract
```

## python-hwpx 라이선스 이슈

python-hwpx는 **Non-Commercial** 커스텀 라이선스. 다음 상황은 문제 없음:
- 개인·학술·내부 업무 사용
- 오픈소스 프로젝트의 내부 의존성
- 본교(제주예시대학) 행정 문서 생성

다음 상황은 **메인테이너와 협의 필요**:
- 유료 제품에 번들 포함
- SaaS로 상업 제공

대안이 필요하면:
- 간단한 변환은 **airun-hwp** (MIT)
- 전체 기능은 **hwpxlib** Java 호출 (Apache-2.0)
- 직접 구현: `raw-zip-fallback.md` 참조 (zipfile + lxml, 표준 라이브러리만)

## 검증 중첩

가장 엄격한 검증은:

1. `./hwpx validate` — 구조 검증 (mimetype, 필수 파일, XML 파싱)
2. python-hwpx로 open + save 왕복 — 의미적 검증
3. hwpxlib Java validator — 공식 스키마 검증 (선택)
4. Hancom Office에서 수동 열기 — 렌더링 검증 (최종)

자동화는 1~3, 4는 사용자 수동.

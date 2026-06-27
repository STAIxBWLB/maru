# 문서 처리 프로젝트 (skills/env)

HWP·PDF 파일 처리를 위한 skills repo-local runtime scaffold. Claude Code에서 자동으로 로드됨.

## 환경 설정

- 첫 실행: `./setup.sh` 또는 `make setup`
- 의존성 확인: `make verify`
- **패키지 관리자: `uv`** (pip 직접 사용 금지)
- **반드시 `.venv/bin/python3` 사용** (시스템 Python 사용 금지)
- 가상환경 없으면 `make setup` 먼저 실행
- 패키지 추가: `pyproject.toml`의 `dependencies`에 추가 후 `uv sync` 또는 `make sync`
- **Node.js 패키지 관리자: `pnpm`** (npm 직접 사용 금지)
- Node 패키지 추가: `package.json`의 `dependencies`에 추가 후 `pnpm install` 또는 `make sync`
- SessionStart hook이 `NODE_PATH`를 자동 설정 → `require('docx')` 등 글로벌 설치 불필요

## 핵심 명령어

```bash
make process-hwp   # input/hwp/ HWP 파일 일괄 텍스트 추출
make process-pdf   # input/pdf/ PDF 파일 일괄 처리
make process-all   # input/ 전체 HWP·PDF 처리
make ocr           # 스캔 PDF OCR 처리
make verify        # 시스템 의존성 확인
```

## 디렉토리 규칙

- `input/hwp/` — 원본 HWP 파일 (읽기 전용, 절대 수정 금지)
- `input/pdf/` — 원본 PDF 파일 (읽기 전용, 절대 수정 금지)
- `output/text/` — 추출된 텍스트 (.txt)
- `output/tables/` — 추출된 표 (.csv)
- `output/images/` — 추출된 이미지
- `temp/` — 중간 파일 (처리 완료 시 자동 삭제)
- `logs/` — 처리 로그

## 코드 규칙

- 파일 경로: `pathlib.Path` 사용 (os.path 금지)
- 파일 타입 감지: 확장자가 아닌 `python-magic` 사용
- 파일 I/O: context manager(`with`) 필수
- 인코딩: `chardet`으로 선행 감지
- pip install 금지: `uv pip install` 또는 `make sync` 사용

## HWP 처리 전략

- 1순위 엔진: **hwp-cli** (Rust 단일 바이너리 `hwp`, 외부 의존성 0). `.hwp`/`.hwpx` 모두 `hwp cat --format plain`으로 추출. stdout만 사용(경고는 stderr). 탐색: `$HWP_CLI` → `~/.cargo/bin/hwp` → `dev/hwp-cli/target/release/hwp` → 검증된 PATH `hwp`.
- HWP v5 (.hwp) 폴백: `libhwp` → `pyhwp hwp5txt` → `olefile` 직접 파싱
- HWPX (.hwpx) 폴백: `zipfile` + `BeautifulSoup` (외부 의존성 최소화)
- 표 추출: libhwp의 `find_all('table')` 또는 HWPX XML 직접 파싱 (hwp-cli는 `--format markdown`이 표를 GFM 표로 변환)

## PDF 처리 전략

- 텍스트 추출: `pymupdf` (속도 우선) → `pdfminer.six` (정확도 필요 시)
- 표 추출: `pdfplumber` (일반) 또는 `camelot` (복잡한 표)
- 이미지 추출: `pymupdf`의 `page.get_images()`
- 스캔 PDF: `pdf2image` → `pytesseract` (lang='kor+eng')

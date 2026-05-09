# 문서 처리 환경 (_sys/skills/env/)

HWP/HWPX/PDF 파일 처리를 위한 공유 Python 가상환경.
Claude Code SessionStart hook이 모든 서브모듈에서 이 venv를 자동 활성화한다.

## 구조

```
env/
├── .claude/
│   ├── hooks/init-env.sh       # SessionStart hook (venv 활성화)
│   ├── templates/settings.json # hook 전파용 템플릿
│   └── settings.json           # env 자체 Claude 설정
├── .venv/                      # 공유 Python 가상환경 (uv, gitignored)
├── input/{hwp,pdf}/            # 입력 파일
├── output/{text,tables,images}/ # 변환 결과물
├── scripts/
│   ├── extract_all.py          # HWP/PDF 통합 텍스트 추출
│   ├── extract_pdf.py          # PDF 전용 추출
│   ├── ocr_pipeline.py         # 스캔 PDF OCR
│   ├── infuse-hooks.sh         # 서브모듈에 hook 전파
│   └── utils/                  # 유틸리티
├── logs/                       # 처리 로그 (gitignored)
├── temp/                       # 임시 파일 (gitignored)
├── Makefile                    # 빌드 명령
├── pyproject.toml              # Python 의존성 (uv)
├── setup.sh                    # 환경 초기 설정
├── CLAUDE.md                   # AI 에이전트 지시서
└── REFERENCE.md                # HWP 포맷 참조
```

## 설치된 패키지

이 repo에는 재현 가능한 source scaffold만 추적한다. `.venv/`, `jre/`,
`node_modules/`, `input/`, `output/`, `temp/`, `logs/`는 로컬 runtime 산출물이다.

| 카테고리 | 패키지 | 용도 |
|---------|--------|------|
| HWP | libhwp, pyhwp(hwp5), python-hwpx, olefile | HWP v5/HWPX 텍스트 추출 |
| PDF | pymupdf, pymupdf4llm, pdfplumber, pdfminer-six | PDF 텍스트/표 추출 |
| OCR | pytesseract, pdf2image, ocrmypdf, pillow | 스캔 PDF OCR |
| 유틸 | click, tqdm, python-magic, chardet, beautifulsoup4, lxml, six | 파일 처리 보조 |

## 사용법

```bash
# 초기 설정 (최초 1회)
cd ~/workspace/work/_sys/skills/env && make setup

# 의존성 확인
make verify

# HWP/PDF 일괄 처리
make process-hwp    # input/hwp/ → output/text/
make process-pdf    # input/pdf/ → output/text/
make process-all    # input/ 전체
make ocr            # 스캔 PDF OCR

# 패키지 동기화 (pyproject.toml 변경 후)
make sync
```

## SessionStart Hook

`init-env.sh`가 Claude Code 세션 시작 시 자동 실행:
1. 현재 디렉토리에서 상위로 탐색하여 `_sys/skills/env/.venv` 위치 탐지
2. `CLAUDE_ENV_FILE`에 `VIRTUAL_ENV`와 `PATH` 주입
3. 이후 `python3`, `hwp5txt` 등이 공유 venv 패키지 사용

## Hook 전파 (서브모듈)

서브모듈에서도 동일 hook이 동작하도록 `infuse-hooks.sh`로 전파:

```bash
# 전체 서브모듈
./scripts/infuse-hooks.sh --all

# 특정 서브모듈
./scripts/infuse-hooks.sh meetings tasks

# 미리보기
./scripts/infuse-hooks.sh --dry-run --all
```

전파 내용: `init-env.sh` (hook 스크립트) + `settings.json` (SessionStart 등록)

## 연관 도구

- **hwp-toolkit**: `~/.claude/skills/hwp-toolkit/hwp` CLI (이 venv의 python3 사용)
- **skills**: `_sys/skills/` submodule (inbox-processor 등이 이 환경에 의존)

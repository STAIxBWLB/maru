#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${PROJECT_DIR}"
DRY_RUN=false

usage() {
    cat <<EOF
Usage: $0 [options]

Options:
  --target PATH   Create runtime environment at PATH (default: this env directory)
  --dry-run       Show actions without changing the environment
  -h, --help      Show help
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --target)
            [[ $# -ge 2 ]] || { echo "error: --target requires PATH" >&2; exit 1; }
            TARGET_DIR="$2"
            shift 2
            ;;
        --dry-run|-n)
            DRY_RUN=true
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "error: unknown option: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

if [[ "$TARGET_DIR" == "~" ]]; then
    TARGET_DIR="$HOME"
elif [[ "$TARGET_DIR" == ~/* ]]; then
    TARGET_DIR="$HOME/${TARGET_DIR#~/}"
fi
TARGET_PARENT="$(dirname "$TARGET_DIR")"
TARGET_BASE="$(basename "$TARGET_DIR")"
if [[ -d "$TARGET_PARENT" ]]; then
    TARGET_PARENT="$(cd "$TARGET_PARENT" && pwd)"
fi
TARGET_DIR="${TARGET_PARENT}/${TARGET_BASE}"
VENV_DIR="${TARGET_DIR}/.venv"

echo "🔧 파일 처리 환경 구성 중..."
echo "   project: ${PROJECT_DIR}"
echo "   target:  ${TARGET_DIR}"
if $DRY_RUN; then
    echo "   mode:    dry-run"
    echo ""
    echo "Would install uv/python packages into ${VENV_DIR}"
    echo "Would install node packages into ${TARGET_DIR}/node_modules"
    echo "Would create runtime directories under ${TARGET_DIR}"
    exit 0
fi

# 0. uv 설치 확인
if ! command -v uv &>/dev/null; then
    echo "uv 설치 중..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
    export PATH="$HOME/.cargo/bin:$PATH"
fi

# 1. 시스템 패키지 설치
if command -v apt-get &>/dev/null; then
    sudo apt-get update -qq
    sudo apt-get install -y -qq \
        poppler-utils tesseract-ocr tesseract-ocr-kor \
        ghostscript libxml2-dev libxslt1-dev
elif command -v brew &>/dev/null; then
    brew install poppler tesseract ghostscript
fi

# 2. uv로 가상환경 생성 및 패키지 설치
cd "${PROJECT_DIR}"
mkdir -p "${TARGET_DIR}"
UV_PROJECT_ENVIRONMENT="${VENV_DIR}" uv sync

# 3. Node.js 패키지 설치 (pnpm)
if command -v pnpm &>/dev/null; then
    echo "📦 Node.js 패키지 설치 중 (pnpm)..."
    pnpm install --dir "${PROJECT_DIR}" --modules-dir "${TARGET_DIR}/node_modules"
else
    echo "⚠️  pnpm 미설치 — Node.js docx 패키지 사용 불가 (brew install pnpm)" >&2
fi

# 4. 디렉토리 구조 확인/생성
mkdir -p "${TARGET_DIR}"/{input/{hwp,pdf},output/{text,tables,images},temp,logs}

# 5. 설치 확인
echo ""
echo "✅ 환경 구성 완료!"
echo "   uv: $(uv --version)"
echo "   Python: $("${VENV_DIR}/bin/python3" --version)"
if command -v tesseract &>/dev/null; then
    echo "   Tesseract: $(tesseract --version 2>&1 | head -1)"
else
    echo "   Tesseract: 미설치"
fi
if command -v pdftotext &>/dev/null; then
    echo "   pdftotext: $(pdftotext -v 2>&1 | head -1)"
else
    echo "   pdftotext: 미설치 (brew install poppler 필요)"
fi
echo ""
echo "다음 명령어로 시작하세요:"
echo "   make process-hwp   # HWP 파일 처리"
echo "   make process-pdf   # PDF 파일 처리"
echo "   make ocr           # 스캔 PDF OCR 처리"

#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET_DIR="${PROJECT_DIR}"
DRY_RUN=false
VERIFY=false

usage() {
    cat <<EOF
Usage: $0 [options]

Options:
  --target PATH   Create runtime environment at PATH (default: this env directory)
  --dry-run       Show actions without changing the environment
  --verify        Check venv/node/jre health at PATH and exit (no changes)
  -h, --help      Show help
EOF
}

# Health check: venv importable + node docx + bundled jre (jdk.compiler).
# The canonical setup target carries all three runtime surfaces:
# .venv, node_modules, and jre.
verify_runtimes() {
    local target="$1" ok=0 py jre c
    echo "🔍 Anchor 런타임 헬스체크: $target"

    py="$target/.venv/bin/python3"
    if [[ -x "$py" ]] && "$py" - <<'PYEOF' 2>/dev/null
import importlib.util, sys
mods = ["openpyxl", "pptx", "docx", "lxml", "networkx", "telethon"]
missing = [m for m in mods if importlib.util.find_spec(m) is None]
sys.exit(1 if missing else 0)
PYEOF
    then
        echo "  ✅ venv: $("$py" --version) + openpyxl/pptx/docx/lxml/networkx/telethon"
    else
        echo "  ❌ venv: $target/.venv 누락 또는 패키지 미설치 (uv sync)"
        ok=1
    fi

    if [[ -d "$target/node_modules/docx" ]]; then
        echo "  ✅ node: docx 패키지 존재 ($target/node_modules)"
    else
        echo "  ❌ node: $target/node_modules/docx 누락 (pnpm install)"
        ok=1
    fi

    # Bundled Node runtime (md2docx docx-js 실행용). End-to-end check: the bundled
    # node can require the env-installed docx via NODE_PATH.
    if [[ -x "$target/node/bin/node" ]] && \
       NODE_PATH="$target/node_modules" "$target/node/bin/node" -e "require('docx')" 2>/dev/null; then
        echo "  ✅ node-runtime: $("$target/node/bin/node" --version) + docx require OK"
    else
        echo "  ❌ node-runtime: $target/node/bin/node 누락 또는 docx 로드 실패 (setup-node.sh)"
        ok=1
    fi

    if [[ $ok -eq 0 ]]; then
        echo "✅ 모든 런타임 정상"
    else
        echo "⚠️  일부 런타임 누락 (위 참조)"
    fi
    return $ok
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
        --verify|--check)
            VERIFY=true
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

if $VERIFY; then
    if verify_runtimes "$TARGET_DIR"; then exit 0; else exit 1; fi
fi

echo "🔧 파일 처리 환경 구성 중..."
echo "   project: ${PROJECT_DIR}"
echo "   target:  ${TARGET_DIR}"
if $DRY_RUN; then
    echo "   mode:    dry-run"
    echo ""
    echo "Would install uv/python packages into ${VENV_DIR}"
    echo "Would install node packages into ${TARGET_DIR}/node_modules"
    echo "Would install bundled Node LTS into ${TARGET_DIR}/node"
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

# (3b. Java 런타임 설치 — 제거됨. hwpx는 hwp-cli로 전환되어 JRE 불필요.)

# 3c. Node 런타임 설치 (md2docx docx-js 변환 실행용)
# ~/.anchor/env/node 에 번들 — 실행 시 시스템 node(fnm/nvm) 의존 제거.
# pnpm 설치(3)는 node_modules 만 생성; 이 런타임이 docx-js 변환기를 실행한다.
NODE_TARGET="${TARGET_DIR}/node"
if [[ -x "$NODE_TARGET/bin/node" ]] && "$NODE_TARGET/bin/node" --version 2>/dev/null | grep -q '^v22\.'; then
    echo "⬢ Node 이미 설치됨: $NODE_TARGET ($("$NODE_TARGET/bin/node" --version))"
else
    echo "⬢ Node LTS 다운로드 → $NODE_TARGET"
    bash "${PROJECT_DIR}/scripts/setup-node.sh" "$NODE_TARGET" || \
        echo "⚠️  Node 설치 실패 — md2docx docx-js 변환 비활성 (bash ${PROJECT_DIR}/scripts/setup-node.sh $NODE_TARGET)" >&2
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
verify_runtimes "$TARGET_DIR" || true
echo ""
echo "다음 명령어로 시작하세요:"
echo "   make process-hwp   # HWP 파일 처리"
echo "   make process-pdf   # PDF 파일 처리"
echo "   make ocr           # 스캔 PDF OCR 처리"

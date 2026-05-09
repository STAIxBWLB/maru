#!/usr/bin/env bash
# _sys/skills/env 공유 가상환경 활성화
# Claude Code SessionStart 훅에서 CLAUDE_ENV_FILE로 환경변수를 주입

set -euo pipefail

# 어느 서브모듈/스킬 repo에서 시작하든 env/.venv 위치 탐지
find_env_root() {
    local dir="${CLAUDE_PROJECT_DIR:-$(pwd)}"
    while [[ "$dir" != "/" ]]; do
        for candidate in \
            "$dir/_sys/skills/env" \
            "$dir/env" \
            "$dir/skills/env"; do
            if [[ -d "$candidate/.venv" ]]; then
                echo "$candidate"
                return 0
            fi
        done
        dir="$(dirname "$dir")"
    done
    return 1
}

ENV_ROOT=$(find_env_root) || {
    echo "[init-env] skills env/.venv를 찾을 수 없음. 스킵." >&2
    exit 0
}

VENV_BIN="$ENV_ROOT/.venv/bin"

if [[ ! -f "$VENV_BIN/python3" ]]; then
    echo "[init-env] venv 미설치: $ENV_ROOT 에서 'make setup' 실행 필요" >&2
    exit 0
fi

# CLAUDE_ENV_FILE에 환경변수 주입
if [[ -n "${CLAUDE_ENV_FILE:-}" ]]; then
    # Python venv
    echo "export VIRTUAL_ENV=\"$ENV_ROOT/.venv\""  >> "$CLAUDE_ENV_FILE"
    echo "export PATH=\"$VENV_BIN:\$PATH\""        >> "$CLAUDE_ENV_FILE"
    echo "[init-env] 공유 venv 활성화됨: $ENV_ROOT/.venv" >&2

    # Node.js: node_modules에서 require() 가능하도록 NODE_PATH 주입
    NODE_MODULES="$ENV_ROOT/node_modules"
    if [[ -d "$NODE_MODULES" ]]; then
        echo "export NODE_PATH=\"$NODE_MODULES:\${NODE_PATH:-}\""  >> "$CLAUDE_ENV_FILE"
        echo "[init-env] NODE_PATH 설정됨: $NODE_MODULES" >&2
    fi
fi

exit 0

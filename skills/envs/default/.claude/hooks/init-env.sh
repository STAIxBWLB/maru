#!/usr/bin/env bash
# init-env.sh — Anchor 공유 런타임(~/.anchor/env) 활성화
# Claude Code SessionStart 훅에서 CLAUDE_ENV_FILE 로 환경변수를 주입한다.
# Rust 호스트(env_vars_for_runs)와 동일한 변수 세트를 내보낸다:
#   ANCHOR_SKILLS_ENV, VIRTUAL_ENV, PATH(+.venv/bin), NODE_PATH(+node_modules)

set -euo pipefail

resolve_env_root() {
    # 1. 명시적 호스트 주입 변수
    if [[ -n "${ANCHOR_SKILLS_ENV:-}" && -d "$ANCHOR_SKILLS_ENV/.venv" ]]; then
        printf '%s\n' "$ANCHOR_SKILLS_ENV"; return 0
    fi
    # 2. 정규 고정 위치. Ambient VIRTUAL_ENV is intentionally ignored so an
    # unrelated shell venv cannot shadow the Anchor runtime.
    if [[ -d "$HOME/.anchor/env/.venv" ]]; then
        printf '%s\n' "$HOME/.anchor/env"; return 0
    fi
    # 3. 프로젝트 디렉토리에서 상위로 탐색 (dev-in-tree)
    local dir="${CLAUDE_PROJECT_DIR:-$(pwd)}"
    while [[ "$dir" != "/" ]]; do
        for candidate in \
            "$dir/env" \
            "$dir/envs/default" \
            "$dir/skills/envs/default"; do
            [[ -d "$candidate/.venv" ]] && printf '%s\n' "$candidate" && return 0
        done
        dir="$(dirname "$dir")"
    done
    return 1
}

ENV_ROOT="$(resolve_env_root)" || {
    echo "[init-env] ~/.anchor/env/.venv 미발견. 스킵 (bash ~/.anchor/skills/_builtin/envs/default/setup.sh --target ~/.anchor/env)" >&2
    exit 0
}

VENV_BIN="$ENV_ROOT/.venv/bin"
if [[ ! -x "$VENV_BIN/python3" ]]; then
    echo "[init-env] venv 미설치: $ENV_ROOT" >&2
    exit 0
fi

if [[ -n "${CLAUDE_ENV_FILE:-}" ]]; then
    {
        echo "export ANCHOR_SKILLS_ENV=\"$ENV_ROOT\""
        echo "export VIRTUAL_ENV=\"$ENV_ROOT/.venv\""
        echo "export PATH=\"$VENV_BIN:\$PATH\""
        if [[ -d "$ENV_ROOT/node_modules" ]]; then
            echo "export NODE_PATH=\"$ENV_ROOT/node_modules\${NODE_PATH:+:\$NODE_PATH}\""
        fi
    } >> "$CLAUDE_ENV_FILE"
    echo "[init-env] 활성화: $ENV_ROOT (venv+node)" >&2
fi

exit 0

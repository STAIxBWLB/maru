#!/usr/bin/env bash
# run.sh — Anchor skills python interpreter wrapper (io-telegram)
#
# telethon 은 ~/.anchor/env/.venv 에만 설치되므로 auth.py/telegram_monitor.py
# 는 반드시 이 wrapper 를 통해 실행한다.
#
# 우선순위:
#   1. $SKILL_PYTHON (caller override)
#   2. $ANCHOR_SKILLS_ENV/$VIRTUAL_ENV (host 주입) → ~/.anchor/env/.venv (정규)
#   3. repo-local env/.venv (dev-in-tree)
#   4. python3 on PATH (경고 출력)
#
# venv 미설치 시: bash ~/.anchor/skills/_builtin/envs/default/setup.sh --target ~/.anchor/env

set -euo pipefail
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Resolve the Anchor skills python interpreter, most-specific first.
# Honors $SKILL_PYTHON, then host-injected $ANCHOR_SKILLS_ENV/$VIRTUAL_ENV,
# then the canonical ~/.anchor/env, then a repo-local walk-up (dev-in-tree).
# Canonical snippet — keep in sync with skills/envs/default/REFERENCE.md.
find_env_python() {
  local c dir
  if [[ -n "${SKILL_PYTHON:-}" && -x "${SKILL_PYTHON}" ]]; then
    printf '%s\n' "$SKILL_PYTHON"; return 0
  fi
  for c in \
    "${ANCHOR_SKILLS_ENV:+$ANCHOR_SKILLS_ENV/.venv/bin/python3}" \
    "${VIRTUAL_ENV:+$VIRTUAL_ENV/bin/python3}" \
    "$HOME/.anchor/env/.venv/bin/python3"; do
    [[ -n "$c" && -x "$c" ]] && printf '%s\n' "$c" && return 0
  done
  dir="$SKILL_DIR"
  while [[ "$dir" != "/" ]]; do
    for c in \
      "$dir/env/.venv/bin/python3" \
      "$dir/envs/default/.venv/bin/python3" \
      "$dir/skills/envs/default/.venv/bin/python3"; do
      [[ -x "$c" ]] && printf '%s\n' "$c" && return 0
    done
    dir="$(dirname "$dir")"
  done
  return 1
}

PYTHON="$(find_env_python || true)"
if [[ -z "$PYTHON" || ! -x "$PYTHON" ]]; then
  if command -v python3 >/dev/null 2>&1; then
    PYTHON="$(command -v python3)"
    echo "WARN: ~/.anchor/env/.venv 미발견, system python3 fallback: $PYTHON (telethon 미설치 가능)" >&2
  else
    echo "ERROR: no python. 'bash ~/.anchor/skills/_builtin/envs/default/setup.sh --target ~/.anchor/env' 실행" >&2
    exit 1
  fi
fi

# Export the resolved runtime so venv/node-based steps work in a bare session too.
case "$PYTHON" in
  */.venv/bin/python3)
    _ENV_ROOT="$(cd "$(dirname "$PYTHON")/../.." && pwd -P)"
    export VIRTUAL_ENV="${VIRTUAL_ENV:-$_ENV_ROOT/.venv}"
    case ":$PATH:" in *":$_ENV_ROOT/.venv/bin:"*) ;; *) PATH="$_ENV_ROOT/.venv/bin:$PATH";; esac
    export PATH
    if [[ -d "$_ENV_ROOT/node_modules" ]]; then
      case ":${NODE_PATH:-}:" in *":$_ENV_ROOT/node_modules:"*) ;; *) NODE_PATH="$_ENV_ROOT/node_modules${NODE_PATH:+:$NODE_PATH}"; export NODE_PATH;; esac
    fi
    ;;
esac
exec "$PYTHON" "$@"

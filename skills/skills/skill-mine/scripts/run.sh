#!/usr/bin/env bash
# run.sh — skills repo env/.venv interpreter wrapper
#
# 우선순위:
#   1. $SKILL_PYTHON (caller override)
#   2. repo-local env/.venv or workspace _sys/skills/env/.venv
#   3. python3 on PATH (경고 출력)
#
# env/.venv 가 없으면 _sys/skills/env 에서 make setup 실행.

set -euo pipefail
SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

find_env_python() {
  local dir="$SKILL_DIR"
  local candidate
  while [[ "$dir" != "/" ]]; do
    for candidate in \
      "$dir/env/.venv/bin/python" \
      "$dir/_sys/skills/env/.venv/bin/python" \
      "$dir/skills/env/.venv/bin/python"; do
      [[ -x "$candidate" ]] && printf '%s\n' "$candidate" && return 0
    done
    dir="$(dirname "$dir")"
  done
  return 1
}

PYTHON="${SKILL_PYTHON:-}"
if [[ -z "$PYTHON" || ! -x "$PYTHON" ]]; then
  if PYTHON="$(find_env_python)"; then
    :
  elif command -v python3 >/dev/null 2>&1; then
    PYTHON="$(command -v python3)"
    echo "WARN: skills env/.venv not found, falling back to $PYTHON" >&2
  else
    echo "ERROR: no python. Run make setup in _sys/skills/env to provision env/.venv" >&2
    exit 1
  fi
fi
exec "$PYTHON" "$@"

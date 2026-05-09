#!/usr/bin/env bash
# infuse-hooks.sh — _sys/skills/env 의 .claude 설정을 work/ 서브모듈에 전파
#
# 원본 파일 위치 (_sys/skills/env):
#   1. .claude/hooks/init-env.sh          — 공유 venv 활성화 스크립트
#   2. .claude/templates/settings.json   — SessionStart 훅 템플릿 (배포용)
#
# 사용법:
#   ./scripts/infuse-hooks.sh --all              # 전체 서브모듈
#   ./scripts/infuse-hooks.sh meetings           # 특정 서브모듈
#   ./scripts/infuse-hooks.sh meetings tasks     # 여러 서브모듈
#   ./scripts/infuse-hooks.sh --dry-run --all    # 변경 내용 미리보기

set -euo pipefail

ENV_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORKSPACE_ROOT="$(cd "$ENV_DIR/../../.." && pwd)"
SRC_HOOK="$ENV_DIR/.claude/hooks/init-env.sh"
SRC_SETTINGS="$ENV_DIR/.claude/templates/settings.json"
DRY_RUN=false
TARGETS=()

# ── 인수 파싱 ─────────────────────────────────────────────────────────────────
for arg in "$@"; do
    case "$arg" in
        --dry-run) DRY_RUN=true ;;
        --all)
            while IFS= read -r line; do
                path=$(echo "$line" | awk '{print $2}')
                TARGETS+=("$path")
            done < <(git -C "$WORKSPACE_ROOT" submodule status)
            ;;
        *) TARGETS+=("$arg") ;;
    esac
done

if [[ ${#TARGETS[@]} -eq 0 ]]; then
    echo "사용법: $0 [--dry-run] --all | <submodule-path> [<submodule-path>...]"
    exit 1
fi

# ── 소스 파일 확인 ────────────────────────────────────────────────────────────
if [[ ! -f "$SRC_HOOK" ]]; then
    echo "❌ 소스 파일 없음: $SRC_HOOK"
    echo "   _sys/skills/env/.claude/hooks/init-env.sh 가 필요합니다."
    exit 1
fi
if [[ ! -f "$SRC_SETTINGS" ]]; then
    echo "❌ 소스 파일 없음: $SRC_SETTINGS"
    echo "   _sys/skills/env/.claude/templates/settings.json 가 필요합니다."
    exit 1
fi

# ── 적용 함수 ─────────────────────────────────────────────────────────────────
infuse_target() {
    local target_path="$1"
    local abs_path

    if [[ "$target_path" = /* ]]; then
        abs_path="$target_path"
    else
        abs_path="$WORKSPACE_ROOT/$target_path"
    fi

    if [[ ! -d "$abs_path" ]]; then
        echo "  ⚠️  디렉토리 없음: $target_path — 스킵"
        return
    fi

    local hooks_dir="$abs_path/.claude/hooks"
    local dst_hook="$hooks_dir/init-env.sh"
    local dst_settings="$abs_path/.claude/settings.json"

    echo "▶ $target_path"

    if [[ "$DRY_RUN" == true ]]; then
        echo "  [dry-run] 복사: init-env.sh → $dst_hook"
        echo "  [dry-run] 적용: settings.json → $dst_settings"
        return
    fi

    mkdir -p "$hooks_dir"

    # init-env.sh 복사
    cp "$SRC_HOOK" "$dst_hook"
    chmod +x "$dst_hook"
    echo "  📄 init-env.sh 복사 완료"

    # settings.json: hooks는 SRC_SETTINGS로 교체, 나머지 키(permissions 등)는 보존
    if [[ -f "$dst_settings" ]]; then
        local merged
        merged=$(jq -s '
            .[0] as $existing |
            .[1] as $new |
            $existing | .hooks = $new.hooks
        ' "$dst_settings" "$SRC_SETTINGS")
        echo "$merged" | jq '.' > "$dst_settings"
        echo "  📝 settings.json 갱신 완료 (hooks 교체, 기타 설정 보존)"
    else
        cp "$SRC_SETTINGS" "$dst_settings"
        echo "  ✨ settings.json 생성 완료"
    fi

    echo "  ✅ $target_path"
}

# ── 실행 ──────────────────────────────────────────────────────────────────────
[[ "$DRY_RUN" == true ]] && echo "🔍 Dry-run 모드 — 실제 변경 없음"
echo ""

success=0
skip=0
for target in "${TARGETS[@]}"; do
    if infuse_target "$target"; then
        success=$((success + 1))
    else
        skip=$((skip + 1))
    fi
done

echo ""
echo "완료: ${success}개 처리, ${skip}개 스킵"

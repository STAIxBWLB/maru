#!/usr/bin/env bash
# CI-only extraction rehearsal. No host source or Node runtime enters crate tests.
set -euo pipefail
if [ "$(git rev-parse --is-shallow-repository)" = true ]; then
  git fetch --unshallow --no-tags origin
fi
split=$(git subtree split --prefix=src-tauri/crates HEAD)
fixture=$(mktemp -d "${RUNNER_TEMP:-/tmp}/maru-engine-subtree.XXXXXX")
trap 'rm -rf "$fixture"' EXIT
git archive "$split" | tar -x -C "$fixture"
(
  cd "$fixture"
  CARGO_BUILD_JOBS=2 cargo test --locked -p maru-diagram-engine --features geometry,typegen,geometry-corpus -- --test-threads=2
  CARGO_BUILD_JOBS=2 cargo test --locked -p tauri-plugin-maru-diagram -- --test-threads=2
  CARGO_TERM_COLOR=never CARGO_BUILD_JOBS=2 cargo test --locked -p tauri-plugin-maru-diagram \
    --features png,render-store,outline --test command_isolation \
    -- --exact production_feature_commands_are_invokable_through_mock_runtime --test-threads=2 --color never \
    | tee "$fixture/plugin-production.log"
  if ! grep -Eq '^test result: ok[.] 1 passed; 0 failed; 0 ignored;' "$fixture/plugin-production.log"; then
    echo "Subtree production IPC fixture did not execute exactly one passing test; inspect required features and the test selector" >&2
    exit 1
  fi
)
echo "E0 subtree split $split: default standalone suites and the production plugin IPC fixture passed"

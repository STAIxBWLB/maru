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
  CARGO_BUILD_JOBS=2 cargo test --locked -p maru-diagram-engine --features geometry,typegen -- --test-threads=2
  CARGO_BUILD_JOBS=2 cargo test --locked -p tauri-plugin-maru-diagram -- --test-threads=2
)
echo "E0 subtree split $split: both standalone crate test suites passed"

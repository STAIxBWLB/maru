# maru — local-first AI workspace desktop app
#
# Tauri 2 + Rust + React 19 + TypeScript. This Makefile bundles the
# common dev / build / test / verify workflows so you don't have to
# remember which lives in pnpm scripts vs cargo.
#
# Quick start:
#   make install   # one-time setup (pnpm install + generated platform icons)
#   make dev       # browser dev (mocked Tauri)
#   make tauri-dev # native dev shell
#   make verify    # what CI runs: typecheck + i18n lint + ts test + rust test + build

SHELL := /bin/bash
.DEFAULT_GOAL := help

PNPM       ?= pnpm
CARGO      ?= cargo
NODE       ?= node
TAURI_DIR  := src-tauri
ICON_PATH  := $(TAURI_DIR)/icons/icon.png
BRAND_ICON_SOURCES := $(wildcard src/assets/brand/*.svg) src/assets/brand/icon-manifest.json scripts/generate-icons.mjs
BENCH_WORKSPACE ?= $(HOME)/workspace/work
CLI_INSTALL_DIR ?= $(HOME)/.local/bin
CLI_BIN_NAME ?= maru
CLI_RELEASE_BIN := $(TAURI_DIR)/target/release/maru-cli
CLI_DEBUG_BIN := $(TAURI_DIR)/target/debug/maru-cli
CLI_INSTALL_BIN := $(CLI_INSTALL_DIR)/$(CLI_BIN_NAME)
CLI_SMOKE_HOME ?= .context/cli-smoke-home
HOMEBREW_TAP_DIR ?= ../homebrew-cask
VERSION ?= $(shell $(NODE) -p "JSON.parse(require('fs').readFileSync('package.json', 'utf8')).version")
RELEASE_TAG ?= v$(VERSION)
MACOS_RELEASE_REPO ?= STAIxBWLB/maru
TAURI_SIGNING_PRIVATE_KEY_FILE ?= $(HOME)/.tauri/maru-updater.key
TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE ?= $(HOME)/.tauri/maru-updater.key.password

# ---------------------------------------------------------------------------
# Help (default target)
# ---------------------------------------------------------------------------

.PHONY: help
help: ## Show this help
	@printf "maru — make targets\n\n"
	@awk 'BEGIN {FS = ":.*##"; printf "  \033[36m%-24s\033[0m %s\n", "target", "description"; \
	             printf "  %-24s %s\n", "------", "-----------"} \
	     /^[a-zA-Z0-9_-]+:.*##/ { printf "  \033[36m%-24s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

.PHONY: install
install: node_modules $(ICON_PATH) ## Install pnpm deps + ensure generated platform icons

node_modules: package.json pnpm-lock.yaml
	$(PNPM) install
	@touch node_modules

$(ICON_PATH): $(BRAND_ICON_SOURCES) ## Generate the canonical Maru icon set when sources change
	$(PNPM) icons:generate

.PHONY: icons
icons: node_modules ## Regenerate web, desktop, iOS, and Android icon assets
	$(PNPM) icons:generate

.PHONY: icons-check
icons-check: node_modules ## Fail when generated icon assets are missing or stale
	$(PNPM) icons:check

# ---------------------------------------------------------------------------
# Dev
# ---------------------------------------------------------------------------

.PHONY: dev
dev: node_modules ## Start vite dev server (mocked Tauri, browser only)
	$(PNPM) dev

.PHONY: tauri-dev
tauri-dev: install ## Start native Tauri dev shell (Rust + React)
	$(PNPM) tauri:dev

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------

.PHONY: build
build: node_modules ## Frontend production build (vite)
	$(PNPM) build

.PHONY: build-frontend
build-frontend: node_modules ## Frontend bundle after a separate typecheck
	$(PNPM) build:frontend

.PHONY: tauri-build
tauri-build: install ## Native Tauri production build (cargo + bundle)
	@set -euo pipefail; \
	if [ -z "$${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then \
		if [ ! -f "$(TAURI_SIGNING_PRIVATE_KEY_FILE)" ]; then \
			printf "error: TAURI_SIGNING_PRIVATE_KEY is unset and %s is missing\n" "$(TAURI_SIGNING_PRIVATE_KEY_FILE)" >&2; \
			printf "restore the updater private key or export TAURI_SIGNING_PRIVATE_KEY before running make tauri-build\n" >&2; \
			exit 1; \
		fi; \
		export TAURI_SIGNING_PRIVATE_KEY="$$(cat "$(TAURI_SIGNING_PRIVATE_KEY_FILE)")"; \
	fi; \
	if [ -z "$${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ] && [ -f "$(TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE)" ]; then \
		export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$$(cat "$(TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE)")"; \
	fi; \
	$(PNPM) tauri:build

.PHONY: cli-build
cli-build: $(ICON_PATH) ## Build standalone Maru CLI
	cd $(TAURI_DIR) && $(CARGO) build --release -p maru-cli --bin maru-cli

.PHONY: cli-install
cli-install: cli-build ## Install standalone Maru CLI to CLI_INSTALL_DIR (default: ~/.local/bin)
	mkdir -p "$(CLI_INSTALL_DIR)"
	install -m 0755 "$(CLI_RELEASE_BIN)" "$(CLI_INSTALL_BIN)"
	"$(CLI_INSTALL_BIN)" --version

.PHONY: cli-uninstall
cli-uninstall: ## Remove standalone Maru CLI from CLI_INSTALL_DIR
	rm -f "$(CLI_INSTALL_BIN)"

.PHONY: cli-version
cli-version: ## Show installed Maru CLI path and version
	@set -euo pipefail; \
	bin="$$(command -v "$(CLI_BIN_NAME)" || true)"; \
	if [ -z "$$bin" ]; then \
		printf "error: %s not found in PATH\n" "$(CLI_BIN_NAME)" >&2; \
		exit 1; \
	fi; \
	printf "%s\n" "$$bin"; \
	"$$bin" --version

.PHONY: cli-smoke
cli-smoke: cli-build ## Smoke test standalone Maru CLI with an isolated HOME under .context/
	@set -euo pipefail; \
	rm -rf "$(CLI_SMOKE_HOME)"; \
	mkdir -p "$(CLI_SMOKE_HOME)"; \
	smoke_home="$$(cd "$(CLI_SMOKE_HOME)" && pwd)"; \
	HOME="$$smoke_home" "$(CLI_RELEASE_BIN)" --version; \
	HOME="$$smoke_home" "$(CLI_RELEASE_BIN)" doctor --quiet; \
	HOME="$$smoke_home" "$(CLI_RELEASE_BIN)" skills dirty --json

.PHONY: cli-smoke-debug
cli-smoke-debug: $(ICON_PATH) ## Smoke a debug CLI after test compilation, avoiding a second release build in CI
	cd $(TAURI_DIR) && $(CARGO) build -p maru-cli --bin maru-cli
	@set -euo pipefail; \
	rm -rf "$(CLI_SMOKE_HOME)"; \
	mkdir -p "$(CLI_SMOKE_HOME)"; \
	smoke_home="$$(cd "$(CLI_SMOKE_HOME)" && pwd)"; \
	HOME="$$smoke_home" "$(CLI_DEBUG_BIN)" --version; \
	HOME="$$smoke_home" "$(CLI_DEBUG_BIN)" doctor --quiet; \
	HOME="$$smoke_home" "$(CLI_DEBUG_BIN)" skills dirty --json

# ---------------------------------------------------------------------------
# Test / quality
# ---------------------------------------------------------------------------

.PHONY: typecheck
typecheck: node_modules ## tsc --build (no emit)
	$(PNPM) typecheck

.PHONY: lint
lint: node_modules ## ESLint gate: hook-dependency + unused-symbol correctness rules (src/ + e2e/)
	$(PNPM) lint

.PHONY: test
test: test-ts test-rust ## Run all unit tests (TS vitest + Rust cargo test)

.PHONY: lint-i18n
lint-i18n: ## i18n lint: ko/en key parity + hardcoded UI string scan
	$(NODE) scripts/lint-i18n.mjs

.PHONY: check-select-chrome
check-select-chrome: ## Static guard: select rules must not wipe the base chevron via background shorthand
	$(NODE) scripts/check-select-chrome.mjs

# The type scale is the single source of truth (PR #137). A raw px font-size in
# styles.css silently opts that rule out of any future --type-* retune, so the
# pane drifts away from the rest of the app. graph.css/diagram.css still carry
# pre-existing raw values and are not gated yet.
.PHONY: check-type-tokens
check-type-tokens: ## Static guard: styles.css font sizes must use the --type-*/--read-* scale
	@! grep -nE 'font-size: *[0-9.]+px' src/styles.css \
		|| (echo "check-type-tokens: raw px font-size above — use a --type-*/--read-* token (src/foundations.css)"; exit 1)

.PHONY: test-ts
test-ts: node_modules ## TypeScript / React unit tests (vitest)
	$(PNPM) test

.PHONY: test-rust
test-rust: $(ICON_PATH) ## Rust unit + integration tests (cargo test --lib)
	cd $(TAURI_DIR) && $(CARGO) test --lib

.PHONY: fmt-check
fmt-check: ## Rust format check (no changes written)
	cd $(TAURI_DIR) && $(CARGO) fmt --check

.PHONY: clippy
clippy: $(ICON_PATH) ## Rust lint gate (cargo clippy -D warnings, lib scope)
	cd $(TAURI_DIR) && $(CARGO) clippy -- -D warnings

.PHONY: test-cli
test-cli: $(ICON_PATH) ## Compile and test standalone Maru CLI binary
	cd $(TAURI_DIR) && $(CARGO) test -p maru-cli --bin maru-cli

.PHONY: test-e2e
test-e2e: node_modules ## Playwright e2e (requires browsers; run `pnpm playwright install` first)
	$(PNPM) test:e2e

# Deliberately NOT part of `verify`: it builds and launches a real macOS
# .app under WebDriver and cannot be hermetic (TEST-01, D-15). Not wired
# into `release-preflight` yet either - 06-05 does that once all four
# D-13 surfaces exist. This target's frontend build is VITE_NATIVE_E2E=1
# and is deliberately not shippable - re-run `pnpm build:frontend` before
# inspecting a production artifact.
.PHONY: test-e2e-native
test-e2e-native: node_modules ## Native WebDriver e2e against the real app (macOS; builds with the native-e2e feature)
	$(PNPM) build:frontend:native-e2e
	@# The native-e2e feature enables tauri/custom-protocol, so dist/ is
	@# embedded at compile time - but cargo does not track dist/ as a build
	@# input and will happily reuse a stale binary (observed: 0.89s no-op
	@# build against a dist rebuilt seconds earlier, webview then stuck on
	@# about:blank). Touching build.rs forces the maru crate to recompile
	@# and re-embed the fresh frontend.
	touch $(TAURI_DIR)/build.rs
	cd $(TAURI_DIR) && $(CARGO) build --features native-e2e
	$(PNPM) test:e2e:native

.PHONY: bench-scan
bench-scan: $(ICON_PATH) ## Bench workspace scan (default: ~/workspace/work; override BENCH_WORKSPACE=/path)
	cd $(TAURI_DIR) && MARU_BENCH_WORKSPACE=$(BENCH_WORKSPACE) \
		$(CARGO) test --release bench_scan_real_workspace -- --ignored --nocapture --test-threads=1

# Deliberately NOT part of `verify`: this depends on which AI CLIs are installed
# and whether their tokens are live, and a merge gate that fails on an expired
# token is a gate people learn to bypass. Run it when touching provider.rs,
# skill_host/dispatch.rs, agent_host/status.rs or terminal/mod.rs.
.PHONY: verify-integration
verify-integration: $(ICON_PATH) ## Smoke the real installed AI CLIs (availability, auth, usage, permission parsing). Uninstalled CLIs are skipped. MARU_CLI_SMOKE_ROUNDTRIP=1 adds one live prompt per authenticated backend.
	cd $(TAURI_DIR) && MARU_CLI_SMOKE=1 \
		$(CARGO) test --lib cli_backends_real_smoke -- --ignored --nocapture --test-threads=1

# ---------------------------------------------------------------------------
# Skills / release management
# ---------------------------------------------------------------------------

.PHONY: skills-doctor
skills-doctor: ## Run Maru skills doctor in quiet mode
	$(CARGO) run --manifest-path $(TAURI_DIR)/Cargo.toml -p maru-cli --bin maru-cli -- doctor --quiet

.PHONY: skills-doctor-json
skills-doctor-json: ## Run Maru skills doctor and print JSON
	$(CARGO) run --manifest-path $(TAURI_DIR)/Cargo.toml -p maru-cli --bin maru-cli -- doctor --json

.PHONY: skills-dirty
skills-dirty: ## List dirty Maru skills as JSON
	$(CARGO) run --manifest-path $(TAURI_DIR)/Cargo.toml -p maru-cli --bin maru-cli -- skills dirty --json

.PHONY: skills-bootstrap-verify
skills-bootstrap-verify: ## Validate the embedded bootstrap snapshot against the OTA bundle schema
	$(NODE) scripts/skills-bootstrap-refresh.mjs verify

.PHONY: skills-bootstrap-refresh
skills-bootstrap-refresh: ## Replace src-tauri/skills-bootstrap with the newest OTA bundle
	$(NODE) scripts/skills-bootstrap-refresh.mjs refresh

.PHONY: diff-check
diff-check: ## Check working tree diff for whitespace errors
	git diff --check

.PHONY: release-version-check
release-version-check: ## Check every release version surface and optional RELEASE_TAG
	$(NODE) scripts/check-release-version.mjs $(if $(RELEASE_TAG),--tag "$(RELEASE_TAG)")

.PHONY: release-checks
release-checks: verify test-cli cli-smoke-debug ## Full verify plus release-only CLI and debug Tauri checks
	$(PNPM) tauri build --debug --no-bundle --config '{"build":{"beforeBuildCommand":null}}'
	$(PNPM) clean:tauri-debug -- --force

.PHONY: release-preflight-core
release-preflight-core: ## Release preflight core: diff, verify, and debug no-bundle Tauri build
	$(MAKE) diff-check
	$(MAKE) release-checks

.PHONY: release-preflight
release-preflight: ## Complete local release preflight: core checks, release CLI smoke, and e2e
	$(MAKE) release-preflight-core
	$(MAKE) cli-smoke
	$(MAKE) test-e2e

.PHONY: macos-distribution-check
macos-distribution-check: ## Check repo config and GitHub secrets for notarized macOS direct distribution
	MARU_RELEASE_REPO="$(MACOS_RELEASE_REPO)" $(NODE) scripts/check-macos-direct-distribution.mjs --github-secrets

.PHONY: macos-distribution-local-check
macos-distribution-local-check: ## Check repo config and local Apple notarization secret files
	$(NODE) scripts/check-macos-direct-distribution.mjs
	$(NODE) scripts/notarize-local-smoke.mjs --check

.PHONY: macos-passkey-readiness-check
macos-passkey-readiness-check: ## Validate opt-in macOS browser-passkey packaging prerequisites
	$(NODE) scripts/check-macos-direct-distribution.mjs --passkeys --require-local-identity

.PHONY: macos-passkey-build
macos-passkey-build: ## Build a locally provisioned macOS browser-passkey bundle (not notarized)
	$(NODE) scripts/build-macos-passkeys.mjs

.PHONY: macos-passkey-notarized-build
macos-passkey-notarized-build: ## Build, notarize, and staple the browser-passkey bundle for distribution
	$(NODE) scripts/build-macos-passkeys.mjs --notarize

.PHONY: macos-notarize-local
macos-notarize-local: ## Build, sign, and notarize locally with secrets from ~/workspace/work/.maru/secrets/apple
	$(NODE) scripts/notarize-local-smoke.mjs "$(or $(TARGET),aarch64-apple-darwin)"

.PHONY: homebrew-update
homebrew-update: ## Render Homebrew cask/formula for RELEASE_TAG into HOMEBREW_TAP_DIR
	$(NODE) scripts/update-homebrew-tap.mjs "$(RELEASE_TAG)" "$(HOMEBREW_TAP_DIR)"

.PHONY: homebrew-update-commit
homebrew-update-commit: ## Render and commit Homebrew cask/formula update
	$(NODE) scripts/update-homebrew-tap.mjs "$(RELEASE_TAG)" "$(HOMEBREW_TAP_DIR)" --commit

.PHONY: homebrew-update-push
homebrew-update-push: ## Render, commit, and push Homebrew cask/formula update
	$(NODE) scripts/update-homebrew-tap.mjs "$(RELEASE_TAG)" "$(HOMEBREW_TAP_DIR)" --commit --push

.PHONY: homebrew-audit
homebrew-audit: ## Audit Maru Homebrew cask and CLI formula in HOMEBREW_TAP_DIR
	cd "$(HOMEBREW_TAP_DIR)" && brew audit --cask maru-workspace
	cd "$(HOMEBREW_TAP_DIR)" && brew audit --formula maru-cli

.PHONY: homebrew-fetch
homebrew-fetch: ## Fetch Maru Homebrew cask and CLI formula in HOMEBREW_TAP_DIR
	cd "$(HOMEBREW_TAP_DIR)" && brew fetch --cask maru-workspace
	cd "$(HOMEBREW_TAP_DIR)" && brew fetch maru-cli

# ---------------------------------------------------------------------------
# Verify (the full pre-merge / pre-PR check)
# ---------------------------------------------------------------------------

.PHONY: verify
verify: typecheck lint release-version-check icons-check lint-i18n check-select-chrome check-type-tokens test-ts test-rust fmt-check clippy build-frontend ## Full verification: typecheck + ESLint gate + release versions + generated assets + guards + tests + Rust format check + Rust lint gate + frontend build

# ---------------------------------------------------------------------------
# Clean
# ---------------------------------------------------------------------------

.PHONY: clean
clean: clean-frontend clean-rust ## Remove all build artifacts (keep node_modules + cargo registry cache)

.PHONY: clean-frontend
clean-frontend: ## Remove vite dist + tsbuildinfo
	rm -rf dist
	find . -name '*.tsbuildinfo' -not -path './node_modules/*' -delete

.PHONY: clean-rust
clean-rust: ## Remove cargo target/
	cd $(TAURI_DIR) && $(CARGO) clean

.PHONY: clean-tauri-debug
clean-tauri-debug: ## Prune oversized src-tauri/target/debug artifacts
	$(PNPM) clean:tauri-debug -- --force

.PHONY: distclean
distclean: clean ## Also remove node_modules + tauri stub icon
	rm -rf node_modules
	rm -rf $(TAURI_DIR)/icons

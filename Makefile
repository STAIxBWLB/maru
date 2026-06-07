# anchor — local-first AI workspace desktop app
#
# Tauri 2 + Rust + React 19 + TypeScript. This Makefile bundles the
# common dev / build / test / verify workflows so you don't have to
# remember which lives in pnpm scripts vs cargo.
#
# Quick start:
#   make install   # one-time setup (pnpm install + tauri icon stub)
#   make dev       # browser dev (mocked Tauri)
#   make tauri-dev # native dev shell
#   make verify    # what CI runs: typecheck + ts test + rust test + build

SHELL := /bin/bash
.DEFAULT_GOAL := help

PNPM       ?= pnpm
CARGO      ?= cargo
NODE       ?= node
TAURI_DIR  := src-tauri
ICON_PATH  := $(TAURI_DIR)/icons/icon.png
BENCH_WORKSPACE ?= $(HOME)/workspace/work
CLI_INSTALL_DIR ?= $(HOME)/.local/bin
CLI_BIN_NAME ?= anchor
CLI_RELEASE_BIN := $(TAURI_DIR)/target/release/anchor-cli
CLI_INSTALL_BIN := $(CLI_INSTALL_DIR)/$(CLI_BIN_NAME)
CLI_SMOKE_HOME ?= .context/cli-smoke-home
HOMEBREW_TAP_DIR ?= ../homebrew-cask
VERSION ?= $(shell $(NODE) -p "JSON.parse(require('fs').readFileSync('package.json', 'utf8')).version")
RELEASE_TAG ?= v$(VERSION)
MACOS_RELEASE_REPO ?= STAIxBWLB/anchor
TAURI_SIGNING_PRIVATE_KEY_FILE ?= $(HOME)/.tauri/anchor-updater.key
TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE ?= $(HOME)/.tauri/anchor-updater.key.password

# ---------------------------------------------------------------------------
# Help (default target)
# ---------------------------------------------------------------------------

.PHONY: help
help: ## Show this help
	@printf "anchor — make targets\n\n"
	@awk 'BEGIN {FS = ":.*##"; printf "  \033[36m%-24s\033[0m %s\n", "target", "description"; \
	             printf "  %-24s %s\n", "------", "-----------"} \
	     /^[a-zA-Z0-9_-]+:.*##/ { printf "  \033[36m%-24s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

.PHONY: install
install: node_modules $(ICON_PATH) ## Install pnpm deps + ensure tauri icon stub

node_modules: package.json pnpm-lock.yaml
	$(PNPM) install
	@touch node_modules

$(ICON_PATH): ## Tauri requires icons/icon.png even with bundle.active=false; stub a 1x1 PNG so cargo build works locally
	@mkdir -p $(TAURI_DIR)/icons
	@python3 -c "import struct, zlib, sys; d=b'\x89PNG\r\n\x1a\n'; \
		c=lambda t,b: struct.pack('>I',len(b))+t+b+struct.pack('>I',zlib.crc32(t+b)&0xffffffff); \
		d+=c(b'IHDR', struct.pack('>IIBBBBB',1,1,8,6,0,0,0)); \
		d+=c(b'IDAT', zlib.compress(b'\x00'+b'\x00\x00\x00\x00')); \
		d+=c(b'IEND', b''); sys.stdout.buffer.write(d)" > $(ICON_PATH)
	@echo "wrote stub $(ICON_PATH) (replace with a real 1024x1024 PNG before bundling for release)"

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
cli-build: $(ICON_PATH) ## Build standalone Anchor CLI
	cd $(TAURI_DIR) && $(CARGO) build --release --bin anchor-cli

.PHONY: cli-install
cli-install: cli-build ## Install standalone Anchor CLI to CLI_INSTALL_DIR (default: ~/.local/bin)
	mkdir -p "$(CLI_INSTALL_DIR)"
	install -m 0755 "$(CLI_RELEASE_BIN)" "$(CLI_INSTALL_BIN)"
	"$(CLI_INSTALL_BIN)" --version

.PHONY: cli-uninstall
cli-uninstall: ## Remove standalone Anchor CLI from CLI_INSTALL_DIR
	rm -f "$(CLI_INSTALL_BIN)"

.PHONY: cli-version
cli-version: ## Show installed Anchor CLI path and version
	@set -euo pipefail; \
	bin="$$(command -v "$(CLI_BIN_NAME)" || true)"; \
	if [ -z "$$bin" ]; then \
		printf "error: %s not found in PATH\n" "$(CLI_BIN_NAME)" >&2; \
		exit 1; \
	fi; \
	printf "%s\n" "$$bin"; \
	"$$bin" --version

.PHONY: cli-smoke
cli-smoke: cli-build ## Smoke test standalone Anchor CLI with an isolated HOME under .context/
	@set -euo pipefail; \
	rm -rf "$(CLI_SMOKE_HOME)"; \
	mkdir -p "$(CLI_SMOKE_HOME)"; \
	smoke_home="$$(cd "$(CLI_SMOKE_HOME)" && pwd)"; \
	HOME="$$smoke_home" "$(CLI_RELEASE_BIN)" --version; \
	HOME="$$smoke_home" "$(CLI_RELEASE_BIN)" doctor --quiet; \
	HOME="$$smoke_home" "$(CLI_RELEASE_BIN)" skills dirty --json

# ---------------------------------------------------------------------------
# Test / quality
# ---------------------------------------------------------------------------

.PHONY: typecheck
typecheck: node_modules ## tsc --build (no emit)
	$(PNPM) typecheck

.PHONY: test
test: test-ts test-rust ## Run all unit tests (TS vitest + Rust cargo test)

.PHONY: test-ts
test-ts: node_modules ## TypeScript / React unit tests (vitest)
	$(PNPM) test

.PHONY: test-rust
test-rust: $(ICON_PATH) ## Rust unit + integration tests (cargo test --lib)
	cd $(TAURI_DIR) && $(CARGO) test --lib

.PHONY: test-cli
test-cli: $(ICON_PATH) ## Compile and test standalone Anchor CLI binary
	cd $(TAURI_DIR) && $(CARGO) test --bin anchor-cli

.PHONY: test-e2e
test-e2e: node_modules ## Playwright e2e (requires browsers; run `pnpm playwright install` first)
	$(PNPM) test:e2e

.PHONY: bench-scan
bench-scan: $(ICON_PATH) ## Bench workspace scan (default: ~/workspace/work; override BENCH_WORKSPACE=/path)
	cd $(TAURI_DIR) && ANCHOR_BENCH_WORKSPACE=$(BENCH_WORKSPACE) \
		$(CARGO) test --release bench_scan_real_workspace -- --ignored --nocapture --test-threads=1

# ---------------------------------------------------------------------------
# Skills / release management
# ---------------------------------------------------------------------------

.PHONY: skills-doctor
skills-doctor: ## Run Anchor skills doctor in quiet mode
	$(CARGO) run --manifest-path $(TAURI_DIR)/Cargo.toml --bin anchor-cli -- doctor --quiet

.PHONY: skills-doctor-json
skills-doctor-json: ## Run Anchor skills doctor and print JSON
	$(CARGO) run --manifest-path $(TAURI_DIR)/Cargo.toml --bin anchor-cli -- doctor --json

.PHONY: skills-dirty
skills-dirty: ## List dirty Anchor skills as JSON
	$(CARGO) run --manifest-path $(TAURI_DIR)/Cargo.toml --bin anchor-cli -- skills dirty --json

.PHONY: diff-check
diff-check: ## Check working tree diff for whitespace errors
	git diff --check

.PHONY: release-preflight
release-preflight: ## Release preflight: diff, verify, CLI smoke, e2e, and debug no-bundle Tauri build
	$(MAKE) diff-check
	$(MAKE) verify
	$(MAKE) test-cli
	$(MAKE) cli-smoke
	$(MAKE) test-e2e
	$(PNPM) tauri build --debug --no-bundle
	$(PNPM) clean:tauri-debug -- --force

.PHONY: macos-distribution-check
macos-distribution-check: ## Check repo config and GitHub secrets for notarized macOS direct distribution
	ANCHOR_RELEASE_REPO="$(MACOS_RELEASE_REPO)" $(NODE) scripts/check-macos-direct-distribution.mjs --github-secrets

.PHONY: macos-distribution-local-check
macos-distribution-local-check: ## Check repo config and local Apple notarization secret files
	$(NODE) scripts/check-macos-direct-distribution.mjs
	$(NODE) scripts/notarize-local-smoke.mjs --check

.PHONY: macos-notarize-local
macos-notarize-local: ## Build, sign, and notarize locally with secrets from ~/workspace/work/.anchor/secrets/apple
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
homebrew-audit: ## Audit Anchor Homebrew cask and CLI formula in HOMEBREW_TAP_DIR
	cd "$(HOMEBREW_TAP_DIR)" && brew audit --cask anchor-workspace
	cd "$(HOMEBREW_TAP_DIR)" && brew audit --formula anchor-cli

.PHONY: homebrew-fetch
homebrew-fetch: ## Fetch Anchor Homebrew cask and CLI formula in HOMEBREW_TAP_DIR
	cd "$(HOMEBREW_TAP_DIR)" && brew fetch --cask anchor-workspace
	cd "$(HOMEBREW_TAP_DIR)" && brew fetch anchor-cli

# ---------------------------------------------------------------------------
# Verify (the full pre-merge / pre-PR check)
# ---------------------------------------------------------------------------

.PHONY: verify
verify: typecheck test-ts test-rust build ## Full verification: typecheck + ts tests + rust tests + frontend build

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

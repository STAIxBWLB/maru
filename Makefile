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
TAURI_DIR  := src-tauri
ICON_PATH  := $(TAURI_DIR)/icons/icon.png
BENCH_VAULT ?= $(HOME)/workspace/work
TAURI_SIGNING_PRIVATE_KEY_FILE ?= $(HOME)/.tauri/anchor-updater.key
TAURI_SIGNING_PRIVATE_KEY_PASSWORD_FILE ?= $(HOME)/.tauri/anchor-updater.key.password

# ---------------------------------------------------------------------------
# Help (default target)
# ---------------------------------------------------------------------------

.PHONY: help
help: ## Show this help
	@printf "anchor — make targets\n\n"
	@awk 'BEGIN {FS = ":.*##"; printf "  \033[36m%-18s\033[0m %s\n", "target", "description"; \
	             printf "  %-18s %s\n", "------", "-----------"} \
	     /^[a-zA-Z0-9_-]+:.*##/ { printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

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

.PHONY: test-e2e
test-e2e: node_modules ## Playwright e2e (requires browsers; run `pnpm playwright install` first)
	$(PNPM) test:e2e

.PHONY: bench-scan
bench-scan: $(ICON_PATH) ## Bench workspace scan (default: ~/workspace/work; override BENCH_WORKSPACE=/path)
	cd $(TAURI_DIR) && ANCHOR_BENCH_WORKSPACE=$(BENCH_WORKSPACE) \
		$(CARGO) test --release bench_scan_real_workspace -- --ignored --nocapture --test-threads=1

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

.PHONY: distclean
distclean: clean ## Also remove node_modules + tauri stub icon
	rm -rf node_modules
	rm -rf $(TAURI_DIR)/icons

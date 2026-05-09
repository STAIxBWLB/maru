#!/usr/bin/env bash
# setup-jre.sh — install Temurin JRE 21 into _sys/skills/env/jre/
#
# Used by the hwpx skill (and any other skill that needs a known-good JRE).
# Strategy:
#   1. If _sys/skills/env/jre/bin/java already runs → exit 0 (idempotent).
#   2. Else download Temurin 21 from api.adoptium.net for the current OS/arch.
#
# Output: _sys/skills/env/jre/bin/java
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"          # _sys/skills/env
JRE_DIR="$ENV_ROOT/jre"

# 1. idempotency
if [[ -x "$JRE_DIR/bin/java" ]]; then
  echo "[setup-jre] already installed: $JRE_DIR"
  "$JRE_DIR/bin/java" -version
  exit 0
fi

mkdir -p "$ENV_ROOT"

# 2. Temurin download
case "$(uname -s)" in
  Darwin) ADOPT_OS="mac" ;;
  Linux)  ADOPT_OS="linux" ;;
  *) echo "[setup-jre] unsupported OS: $(uname -s)" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) ADOPT_ARCH="aarch64" ;;
  x86_64|amd64)  ADOPT_ARCH="x64" ;;
  *) echo "[setup-jre] unsupported arch: $(uname -m)" >&2; exit 1 ;;
esac

URL="https://api.adoptium.net/v3/binary/latest/21/ga/${ADOPT_OS}/${ADOPT_ARCH}/jre/hotspot/normal/eclipse"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
TARBALL="$TMP/temurin-jre.tar.gz"

echo "[setup-jre] downloading Temurin 21 JRE: $ADOPT_OS/$ADOPT_ARCH"
curl -fsSL -o "$TARBALL" "$URL"
mkdir -p "$TMP/extract"
tar -xzf "$TARBALL" -C "$TMP/extract"

# Temurin macOS layout: jdk-21.x.y+z-jre/Contents/Home/{bin,lib,...}
# Linux layout:         jdk-21.x.y+z-jre/{bin,lib,...}
EXTRACTED="$(find "$TMP/extract" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
if [[ "$ADOPT_OS" == "mac" && -d "$EXTRACTED/Contents/Home" ]]; then
  EXTRACTED="$EXTRACTED/Contents/Home"
fi

rm -rf "$JRE_DIR"
mkdir -p "$JRE_DIR"
cp -R "$EXTRACTED"/* "$JRE_DIR/"

echo "[setup-jre] installed at $JRE_DIR"
"$JRE_DIR/bin/java" -version

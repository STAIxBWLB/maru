#!/usr/bin/env bash
# setup-jre.sh — install Temurin JDK 21 into skills/envs/default/jre/
#
# Used by the hwpx skill (and any other skill that needs a known-good Java runtime).
# Strategy:
#   1. If skills/envs/default/jre/bin/java has the jdk.compiler module → exit 0.
#   2. Else download Temurin 21 JDK from api.adoptium.net for the current OS/arch.
#
# Output: skills/envs/default/jre/bin/java
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"          # skills/envs/default

# Optional target ($1): install the JDK at <target>/jre (or at <target> when it
# already ends in /jre). Default: skills/envs/default/jre (dev/source location).
# Lets setup.sh provision the JRE into the canonical ~/.anchor/env/jre.
if [[ -n "${1:-}" ]]; then
  case "$1" in
    */jre) JRE_DIR="$1" ;;
    *)     JRE_DIR="$1/jre" ;;
  esac
else
  JRE_DIR="$ENV_ROOT/jre"
fi

# 1. idempotency. The hwpx writer uses Java source-file launch when
# HwpxWriter.class is absent, so the bundled runtime must include jdk.compiler.
if [[ -x "$JRE_DIR/bin/java" ]]; then
  if "$JRE_DIR/bin/java" --list-modules 2>/dev/null | grep -q '^jdk.compiler@'; then
    echo "[setup-jre] already installed: $JRE_DIR"
    "$JRE_DIR/bin/java" -version
    exit 0
  fi
  echo "[setup-jre] existing runtime lacks jdk.compiler; reinstalling JDK"
fi

mkdir -p "$(dirname "$JRE_DIR")"

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

URL="https://api.adoptium.net/v3/binary/latest/21/ga/${ADOPT_OS}/${ADOPT_ARCH}/jdk/hotspot/normal/eclipse"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
TARBALL="$TMP/temurin-jdk.tar.gz"

echo "[setup-jre] downloading Temurin 21 JDK: $ADOPT_OS/$ADOPT_ARCH"
curl -fsSL -o "$TARBALL" "$URL"
mkdir -p "$TMP/extract"
tar -xzf "$TARBALL" -C "$TMP/extract"

# Temurin macOS layout: jdk-21.x.y+z/Contents/Home/{bin,lib,...}
# Linux layout:         jdk-21.x.y+z/{bin,lib,...}
EXTRACTED="$(find "$TMP/extract" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
if [[ "$ADOPT_OS" == "mac" && -d "$EXTRACTED/Contents/Home" ]]; then
  EXTRACTED="$EXTRACTED/Contents/Home"
fi

rm -rf "$JRE_DIR"
mkdir -p "$JRE_DIR"
cp -R "$EXTRACTED"/* "$JRE_DIR/"

echo "[setup-jre] installed at $JRE_DIR"
"$JRE_DIR/bin/java" -version

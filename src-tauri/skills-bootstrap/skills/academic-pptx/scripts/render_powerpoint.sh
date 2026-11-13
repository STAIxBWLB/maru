#!/bin/bash
# Render a .pptx through Microsoft PowerPoint for Mac: <deck>.pdf and <deck>-slide-N.png beside the deck.
# Usage: bash render_powerpoint.sh deck.pptx [dpi]   (dpi default 110)
# Exit 2: no deck argument. Exit 3: not macOS or PowerPoint missing. Exit 4: pdftoppm missing.
# Exit 3 and 4 both mean visual QA on this host is unverified.
# Works inside PowerPoint's sandbox container, so no file-access prompt appears.
set -euo pipefail
[ $# -ge 1 ] || { echo "usage: bash render_powerpoint.sh deck.pptx [dpi]" >&2; exit 2; }
deck=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
dpi=${2:-110}
[ "$(uname)" = Darwin ] && [ -d "/Applications/Microsoft PowerPoint.app" ] || { echo "render_powerpoint: needs macOS + Microsoft PowerPoint" >&2; exit 3; }
command -v pdftoppm >/dev/null || { echo "render_powerpoint: needs pdftoppm (poppler); install poppler" >&2; exit 4; }

box="$HOME/Library/Containers/com.microsoft.Powerpoint/Data/render-tmp"
name="render-$$.pptx"   # fixed name: the deck name never enters the AppleScript
mkdir -p "$box"
lock="${TMPDIR:-/tmp}/render_powerpoint.lock"
waited=0   # PowerPoint exports one deck at a time
until mkdir "$lock" 2>/dev/null; do
  sleep 1; waited=$((waited + 1))
  [ "$waited" -lt 600 ] || { echo "render_powerpoint: $lock held for 10 min; remove it if no render is running" >&2; exit 1; }
done
trap 'rm -f "$box/$name" "$box/${name%.pptx}.pdf"; rmdir "$lock"' EXIT
cp "$deck" "$box/$name"

osascript <<EOF
with timeout of 180 seconds
  tell application "Microsoft PowerPoint"
    open POSIX file "$box/$name"
    delay 2
    save presentation "$name" in (POSIX file "$box/${name%.pptx}.pdf") as save as PDF
    close presentation "$name" saving no
  end tell
end timeout
EOF

pdf="${deck%.pptx}.pdf"
cp "$box/${name%.pptx}.pdf" "$pdf"
rm -f "${deck%.pptx}"-slide-*.png
pdftoppm -png -r "$dpi" "$pdf" "${deck%.pptx}-slide"
ls -1 "${deck%.pptx}"-slide-*.png

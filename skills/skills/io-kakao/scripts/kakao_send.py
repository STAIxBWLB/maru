#!/usr/bin/env python3
"""kakao_send.py — enqueue a KakaoTalk send request onto the relay bus.

Writes a kakao-send/v1 request file into <relay_root>/outbox/pending/ so the
dedicated-Mac relay (maru-kakao-relay) sends it via kmsg. This script never
touches kmsg or KakaoTalk; it only writes one file (plus an optional
attachment copy) into the synced folder.

Usage:
  kakao_send.py --work <workRoot> --chat "<room name>" --text "message" \
      [--attachment /path/to/file] [--relay-root <override>]

Exit codes: 0 queued, 1 usage/config error, 2 write failure.
"""

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import uuid
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = "kakao-send/v1"


def _section_chain_value(text: str, chain: list[str], key: str) -> str | None:
    """Indentation-aware scan for a nested YAML value (e.g. io.providers.kakao.relay_root).

    Tracks the section path by indent depth; ignores comments and quoted
    values are unwrapped. No regex backtracking, no cross-section leaks.
    """

    def indent_of(line: str) -> int:
        return len(line) - len(line.lstrip(" "))

    path: list[tuple[int, str]] = []  # (indent, section) stack
    for raw in text.splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        m = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", stripped)
        if not m:
            continue
        name, value = m.group(1), m.group(2)
        depth = indent_of(raw)
        while path and path[-1][0] >= depth:
            path.pop()
        current = [section for _, section in path]
        if not value:
            # Section header — push and continue.
            path.append((depth, name))
            continue
        # Leaf value. Strip inline comments outside quotes.
        value = value.split(" #", 1)[0].strip().strip("\"'").strip()
        if current == chain and name == key and value:
            return value
        # A leaf at this level still counts as a node on the stack path only
        # when it is itself one of the chain parents handled above; leaves
        # are never pushed.
    return None


def resolve_relay_root(work: Path, override: str | None) -> Path:
    if override:
        return Path(os.path.expanduser(override))
    config = work / "workspace.config.yaml"
    if not config.is_file():
        raise SystemExit(f"relay_root_not_configured: {config} not found")
    text = config.read_text(encoding="utf-8")
    value = _section_chain_value(text, ["io", "providers", "kakao"], "relay_root")
    if not value:
        raise SystemExit("relay_root_not_configured: io.providers.kakao.relay_root missing")
    return Path(os.path.expanduser(value))


def sanitize(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "-", name)


def main() -> int:
    parser = argparse.ArgumentParser(description="Enqueue a kakao-send/v1 request.")
    parser.add_argument("--work", required=True, help="workspace root containing workspace.config.yaml")
    parser.add_argument("--chat", required=True, help="exact KakaoTalk room display name")
    parser.add_argument("--text", default="", help="plain text message")
    parser.add_argument("--attachment", default=None, help="optional file to send with the message")
    parser.add_argument("--relay-root", default=None, help="override relay bus root")
    parser.add_argument("--requested-by", default="io-kakao-skill")
    args = parser.parse_args()

    if not args.text and not args.attachment:
        parser.error("text or attachment is required")

    relay_root = resolve_relay_root(Path(args.work), args.relay_root)
    request_id = str(uuid.uuid4())

    attachment_field = None
    if args.attachment:
        source = Path(args.attachment)
        if not source.is_file():
            raise SystemExit(f"attachment_not_found: {source}")
        target_dir = relay_root / "outbox" / "attachments"
        target_dir.mkdir(parents=True, exist_ok=True)
        target_name = f"{request_id}-{sanitize(source.name)}"
        shutil.copy2(source, target_dir / target_name)
        attachment_field = f"outbox/attachments/{target_name}"

    payload = {
        "schema": SCHEMA,
        "id": request_id,
        "chat": args.chat,
        "text": args.text,
        "attachment": attachment_field,
        "requested_by": args.requested_by,
        "requested_at": datetime.now(timezone.utc).isoformat(),
    }

    pending = relay_root / "outbox" / "pending"
    pending.mkdir(parents=True, exist_ok=True)
    # Atomic write: temp file in the same directory, then rename. The tmp
    # name must NOT end in .json — the relay's pending filter matches *.json.
    fd, tmp_name = tempfile.mkstemp(dir=pending, prefix=".tmp-", suffix=".part")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
        os.replace(tmp_name, pending / f"{request_id}.json")
    except OSError as exc:
        try:
            os.unlink(tmp_name)
        except OSError:
            pass
        raise SystemExit(f"enqueue_failed: {exc}")

    print(json.dumps({"id": request_id, "path": str(pending / f"{request_id}.json")}))
    return 0


if __name__ == "__main__":
    sys.exit(main())

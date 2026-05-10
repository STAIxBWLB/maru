#!/usr/bin/env python3
"""Interactive Telegram login for Anchor's io-telegram skill."""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Authorize a Telegram session")
    parser.add_argument("--session-file", required=True, help="Absolute Telethon session file path")
    parser.add_argument("--api-id", default=os.environ.get("TELEGRAM_API_ID"))
    parser.add_argument("--api-hash", default=os.environ.get("TELEGRAM_API_HASH"))
    return parser.parse_args()


async def login(args: argparse.Namespace) -> None:
    try:
        from telethon import TelegramClient
    except ImportError as exc:
        raise SystemExit("telethon is not installed in ~/.anchor/env") from exc
    session_file = Path(args.session_file).expanduser()
    if not session_file.is_absolute():
        raise SystemExit("session-file must be absolute")
    if not args.api_id or not args.api_hash:
        raise SystemExit("api_id/api_hash missing. Set TELEGRAM_API_ID and TELEGRAM_API_HASH.")
    session_file.parent.mkdir(parents=True, exist_ok=True)
    client = TelegramClient(str(session_file), int(args.api_id), args.api_hash)
    await client.start()
    me = await client.get_me()
    name = getattr(me, "username", None) or getattr(me, "first_name", None) or "authorized"
    print(f"Telegram session ready: {name}")
    await client.disconnect()


def main() -> int:
    args = parse_args()
    try:
        asyncio.run(login(args))
    except SystemExit as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001 - CLI boundary
        print(f"telegram_auth_failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

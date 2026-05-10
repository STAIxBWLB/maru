#!/usr/bin/env python3
"""Interactive Telegram login for Anchor's io-telegram skill."""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Authorize a Telegram session")
    parser.add_argument("--session-file", required=True, help="Absolute Telethon session file path")
    parser.add_argument("--config-file", help="YAML config containing telegram.api_id/api_hash")
    parser.add_argument("--api-id", default=os.environ.get("TELEGRAM_API_ID"))
    parser.add_argument("--api-hash", default=os.environ.get("TELEGRAM_API_HASH"))
    return parser.parse_args()


def apply_config_file(args: argparse.Namespace) -> None:
    if not args.config_file:
        return
    api_id, api_hash = read_config_credentials(Path(args.config_file).expanduser())
    args.api_id = args.api_id or api_id
    args.api_hash = args.api_hash or api_hash


def read_config_credentials(path: Path) -> tuple[str | None, str | None]:
    if not path.is_file():
        raise SystemExit(f"config file not found: {path}")
    text = path.read_text(encoding="utf-8")
    try:
        import yaml  # type: ignore[import-untyped]

        data = yaml.safe_load(text) or {}
        telegram = data.get("telegram", data) if isinstance(data, dict) else {}
        return _string_value(telegram.get("api_id")), _string_value(telegram.get("api_hash"))
    except ImportError:
        return read_simple_yaml_credentials(text)


def read_simple_yaml_credentials(text: str) -> tuple[str | None, str | None]:
    values: dict[str, str] = {}
    in_telegram = False
    for line in text.splitlines():
        raw = line.split("#", 1)[0].rstrip()
        stripped = raw.strip()
        if not stripped:
            continue
        if stripped == "telegram:":
            in_telegram = True
            continue
        if in_telegram and not raw.startswith((" ", "\t")):
            in_telegram = False
        if in_telegram and ":" in stripped:
            key, value = stripped.split(":", 1)
            values[key.strip()] = value.strip().strip("'\"")
    return _string_value(values.get("api_id")), _string_value(values.get("api_hash"))


def _string_value(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


async def login(args: argparse.Namespace) -> None:
    try:
        from telethon import TelegramClient
    except ImportError as exc:
        raise SystemExit("telethon is not installed in ~/.anchor/env") from exc
    session_file = Path(args.session_file).expanduser()
    if not session_file.is_absolute():
        raise SystemExit("session-file must be absolute")
    apply_config_file(args)
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

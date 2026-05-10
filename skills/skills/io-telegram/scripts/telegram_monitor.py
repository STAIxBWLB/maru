#!/usr/bin/env python3
"""Telegram reader for Anchor's io-telegram skill.

Default mode is JSON-only: no inbox/drop writes happen unless another wrapper
chooses to persist the returned messages.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Any


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Read recent Telegram messages for Anchor")
    parser.add_argument("--once", action="store_true", help="Run one scan and exit")
    parser.add_argument("--output-json", action="store_true", help="Write normalized JSON to stdout")
    parser.add_argument("--session-file", required=True, help="Absolute Telethon session file path")
    parser.add_argument("--api-id", default=os.environ.get("TELEGRAM_API_ID"))
    parser.add_argument("--api-hash", default=os.environ.get("TELEGRAM_API_HASH"))
    parser.add_argument("--chat", action="append", default=[], help="Chat username/id/title to scan")
    parser.add_argument("--limit", type=int, default=50)
    return parser.parse_args()


def require_runtime(args: argparse.Namespace) -> Path:
    session_file = Path(args.session_file).expanduser()
    if not session_file.is_absolute():
        raise SystemExit("session-file must be absolute")
    if not args.api_id or not args.api_hash:
        raise SystemExit("api_id/api_hash missing. Set TELEGRAM_API_ID and TELEGRAM_API_HASH.")
    return session_file


def message_to_dict(message: Any, chat: Any, sender: Any) -> dict[str, Any]:
    sender_name = ""
    if sender is not None:
        first = getattr(sender, "first_name", "") or ""
        last = getattr(sender, "last_name", "") or ""
        username = getattr(sender, "username", "") or ""
        sender_name = " ".join(part for part in [first, last] if part).strip() or username
    chat_id = str(getattr(chat, "id", "") or "")
    chat_title = (
        getattr(chat, "title", None)
        or getattr(chat, "username", None)
        or getattr(chat, "first_name", None)
        or chat_id
    )
    return {
        "id": f"{chat_id}:{message.id}",
        "chatId": chat_id,
        "chatTitle": str(chat_title or ""),
        "sender": sender_name,
        "text": message.message or "",
        "date": message.date.isoformat() if message.date else "",
        "permalink": None,
    }


async def scan(args: argparse.Namespace) -> list[dict[str, Any]]:
    try:
        from telethon import TelegramClient
    except ImportError as exc:
        raise SystemExit("telethon is not installed in ~/.anchor/env") from exc

    session_file = require_runtime(args)
    session_file.parent.mkdir(parents=True, exist_ok=True)
    client = TelegramClient(str(session_file), int(args.api_id), args.api_hash)
    await client.connect()
    try:
        if not await client.is_user_authorized():
            raise SystemExit("auth_required: Telegram session is not authorized")
        messages: list[dict[str, Any]] = []
        if args.chat:
            chats = [await client.get_entity(chat) for chat in args.chat]
        else:
            dialogs = await client.get_dialogs(limit=min(args.limit, 20))
            chats = [dialog.entity for dialog in dialogs]
        per_chat = max(1, min(args.limit, 20))
        for chat in chats:
            async for message in client.iter_messages(chat, limit=per_chat):
                if not getattr(message, "message", None):
                    continue
                sender = await message.get_sender()
                messages.append(message_to_dict(message, chat, sender))
                if len(messages) >= args.limit:
                    return messages
        return messages
    finally:
        await client.disconnect()


def main() -> int:
    args = parse_args()
    try:
        messages = asyncio.run(scan(args))
    except SystemExit as exc:
        print(str(exc), file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001 - CLI boundary
        print(f"telegram_failed: {exc}", file=sys.stderr)
        return 1
    if args.output_json:
        print(json.dumps({"messages": messages}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

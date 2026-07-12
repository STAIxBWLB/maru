#!/usr/bin/env python3
"""Prepare a share-ready file copy using workspace share_outbox config."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import re
import shutil
import sys
import unicodedata
import urllib.request
import uuid
from zoneinfo import ZoneInfo

try:
    import yaml
except ImportError as exc:  # pragma: no cover - environment guard
    raise SystemExit("PyYAML is required. Use the workspace skills runtime.") from exc


HANGUL_RE = re.compile(r"[\uac00-\ud7a3]")
UNSAFE_RE = re.compile(r"[\x00-\x1f/\\:]")


def fail(message: str) -> None:
    print(json.dumps({"ok": False, "error": message}, ensure_ascii=False), file=sys.stderr)
    raise SystemExit(1)


def find_workspace_config(start: Path) -> Path:
    current = start.resolve()
    if current.is_file():
        current = current.parent
    for candidate in [current, *current.parents]:
        config = candidate / "workspace.config.yaml"
        if config.is_file():
            return config
    fail(f"Cannot find workspace.config.yaml from {start}")


def load_yaml(path: Path) -> dict:
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def expand_path(value: str, base: Path | None = None) -> Path:
    path = Path(os.path.expanduser(value))
    if not path.is_absolute() and base is not None:
        path = base / path
    return path


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def normalize_text(value: str) -> str:
    value = unicodedata.normalize("NFC", value)
    value = UNSAFE_RE.sub(" ", value)
    value = re.sub(r"\s+", " ", value).strip(" ._-")
    return value


def strip_extension(name: str) -> str:
    return Path(name).stem


def strip_suffixes(stem: str, patterns: list[str]) -> str:
    title = stem
    changed = True
    while changed:
        changed = False
        for pattern in patterns:
            next_title = re.sub(pattern, "", title, flags=re.IGNORECASE).strip(" ._-")
            if next_title != title:
                title = next_title
                changed = True
    return title


def title_has_hangul(title: str) -> bool:
    return bool(HANGUL_RE.search(title))


def load_manifest_from_item(item_path: Path) -> dict:
    manifest = item_path / "manifest.yaml"
    if not manifest.is_file():
        fail(f"Inbox item manifest not found: {manifest}")
    return load_yaml(manifest)


def infer_inbox_item_from_source(source: Path) -> Path | None:
    parts = source.resolve().parts
    if "items" not in parts:
        return None
    for idx, part in enumerate(parts):
        if part == "items" and idx + 2 < len(parts):
            item = Path(*parts[: idx + 3])
            if (item / "manifest.yaml").is_file():
                return item
    return None


def primary_manifest_name(manifest: dict) -> str | None:
    source = manifest.get("source") or {}
    original_name = source.get("original_name")
    if original_name:
        return str(original_name)
    for item in manifest.get("files") or []:
        if item.get("role") == "primary" and item.get("path"):
            return Path(str(item["path"])).name
    files = manifest.get("files") or []
    if files and files[0].get("path"):
        return Path(str(files[0]["path"])).name
    return None


def resolve_title(args: argparse.Namespace, source: Path, config: dict) -> tuple[str, str, str | None]:
    filename_cfg = config.get("filename") or {}
    patterns = list(filename_cfg.get("suffix_patterns") or [])

    if args.title:
        raw_name = args.title
        source_kind = "explicit"
    else:
        raw_name = None
        source_kind = "source"
        item_path = expand_path(args.inbox_item) if args.inbox_item else infer_inbox_item_from_source(source)
        if item_path:
            manifest = load_manifest_from_item(item_path)
            raw_name = primary_manifest_name(manifest)
            source_kind = "inbox-manifest"
        if raw_name is None and args.template:
            raw_name = expand_path(args.template).name
            source_kind = "template"
        if raw_name is None:
            raw_name = source.name

    stem = raw_name if args.title else strip_extension(raw_name)
    title = normalize_text(strip_suffixes(stem, patterns))
    if not title:
        fail("Cannot derive an outgoing title")
    if not title_has_hangul(title) and not args.allow_english:
        fail(
            "Outgoing title has no Hangul. Inspect the content and pass --title with a Korean title, "
            "or pass --allow-english for international recipients."
        )
    return title, source_kind, raw_name


def resolve_timestamp(value: str | None, timezone: str, fmt: str) -> tuple[str, str]:
    zone = ZoneInfo(timezone)
    if not value:
        now = dt.datetime.now(zone)
        return now.strftime(fmt), now.isoformat(timespec="seconds")
    if re.fullmatch(r"\d{6}-\d{4}", value):
        parsed = dt.datetime.strptime(value, "%y%m%d-%H%M").replace(tzinfo=zone)
        return value, parsed.isoformat(timespec="seconds")
    normalized = value.replace("Z", "+00:00")
    try:
        parsed = dt.datetime.fromisoformat(normalized)
    except ValueError:
        fail(f"Invalid timestamp: {value}")
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=zone)
    parsed = parsed.astimezone(zone)
    return parsed.strftime(fmt), parsed.isoformat(timespec="seconds")


def format_month_path(template: str, timestamp_iso: str, timezone: str) -> str:
    zone = ZoneInfo(timezone)
    try:
        parsed = dt.datetime.fromisoformat(timestamp_iso)
    except ValueError:
        parsed = dt.datetime.now(zone)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=zone)
    parsed = parsed.astimezone(zone)
    values = {
        "yyyy": parsed.strftime("%Y"),
        "yy": parsed.strftime("%y"),
        "mm": parsed.strftime("%m"),
        "dd": parsed.strftime("%d"),
    }
    return template.format(**values)


def require_config(config: dict) -> dict:
    outbox = config.get("share_outbox")
    if not isinstance(outbox, dict):
        fail("Missing share_outbox in workspace.config.yaml")
    for key in ("root", "timezone", "default_author", "authors", "filename", "paths"):
        if key not in outbox:
            fail(f"share_outbox.{key} is required")
    return outbox


def build_paths(outbox: dict, title: str, author: str, timestamp: str, ext: str, timestamp_iso: str) -> tuple[Path, Path]:
    root = expand_path(str(outbox["root"]))
    filename_cfg = outbox.get("filename") or {}
    paths_cfg = outbox.get("paths") or {}
    template = filename_cfg.get("template", "{title}_{author}_{timestamp}{ext}")
    monthly_template = paths_cfg.get("monthly", "{yyyy}-{mm}")
    monthly = format_month_path(str(monthly_template), timestamp_iso, str(outbox["timezone"]))
    filename = template.format(title=title, author=author, timestamp=timestamp, ext=ext)
    filename = normalize_text(filename)
    output = root / monthly / filename
    receipts_cfg = paths_cfg.get("receipts", "_state/index.jsonl")
    receipts = expand_path(str(receipts_cfg), root)
    return output, receipts


def telegram_creds(workspace: dict) -> tuple[str, str] | None:
    providers = (workspace.get("io") or {}).get("providers") or {}
    mon_path = ((providers.get("telegram") or {}).get("secrets") or {}).get("monitor_config")
    if not mon_path:
        return None
    mon_file = expand_path(str(mon_path))
    if not mon_file.is_file():
        return None
    tg = (load_yaml(mon_file).get("notification") or {}).get("telegram") or {}
    token, chat_id = tg.get("bot_token"), tg.get("chat_id")
    if not token or not chat_id:
        return None
    return str(token), str(chat_id)


def telegram_send_document(token: str, chat_id: str, path: Path) -> dict:
    boundary = uuid.uuid4().hex
    ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    body = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="chat_id"\r\n\r\n{chat_id}\r\n'
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="document"; filename="{path.name}"\r\n'
        f"Content-Type: {ctype}\r\n\r\n"
    ).encode("utf-8") + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode("utf-8")
    request = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/sendDocument",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    with urllib.request.urlopen(request, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def send_via_telegram(workspace: dict, path: Path) -> dict:
    creds = telegram_creds(workspace)
    if creds is None:
        return {"ok": False, "error": "telegram credentials not configured"}
    try:
        resp = telegram_send_document(*creds, path)
    except Exception as exc:  # ponytail: non-fatal, the local share already succeeded
        return {"ok": False, "error": str(exc)}
    if not resp.get("ok"):
        return {"ok": False, "error": json.dumps(resp, ensure_ascii=False)}
    return {"ok": True}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Prepare a share-ready file copy.")
    parser.add_argument("source", help="Source file to copy")
    parser.add_argument("--config", help="workspace.config.yaml path")
    parser.add_argument("--title", help="Korean outgoing title without extension")
    parser.add_argument(
        "--allow-english",
        action="store_true",
        help="Allow a non-Korean (e.g., English) outgoing title for international recipients",
    )
    parser.add_argument("--author", help="Author key from share_outbox.authors")
    parser.add_argument("--timestamp", help="ISO timestamp or YYMMDD-HHMM literal")
    parser.add_argument("--inbox-item", help="Inbox item directory containing manifest.yaml")
    parser.add_argument("--template", help="Template/source filename to use for title derivation")
    parser.add_argument("--replace", action="store_true", help="Overwrite existing outgoing copy")
    parser.add_argument("--dry-run", action="store_true", help="Print planned output without writing")
    parser.add_argument("--no-telegram", action="store_true", help="Skip Telegram send even when enabled in config")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    source = expand_path(args.source)
    if not source.is_file():
        fail(f"Source file not found: {source}")

    config_path = expand_path(args.config) if args.config else find_workspace_config(Path.cwd())
    workspace = load_yaml(config_path)
    outbox = require_config(workspace)

    author_key = args.author or str(outbox["default_author"])
    author_cfg = (outbox.get("authors") or {}).get(author_key)
    if not isinstance(author_cfg, dict) or not author_cfg.get("suffix"):
        fail(f"Unknown or incomplete author key: {author_key}")
    author_suffix = normalize_text(str(author_cfg["suffix"]))

    filename_cfg = outbox.get("filename") or {}
    timestamp_fmt = str(filename_cfg.get("timestamp_format", "%y%m%d-%H%M"))
    timestamp, timestamp_iso = resolve_timestamp(args.timestamp, str(outbox["timezone"]), timestamp_fmt)
    title, title_source, original_name = resolve_title(args, source, outbox)
    output, receipts = build_paths(outbox, title, author_suffix, timestamp, source.suffix, timestamp_iso)
    digest = sha256_file(source)

    receipt = {
        "schema": "share-outbox-receipt/v1",
        "created_at": dt.datetime.now(ZoneInfo(str(outbox["timezone"]))).isoformat(timespec="seconds"),
        "mode": "copy",
        "source": str(source),
        "output": str(output),
        "original_name": original_name,
        "title": title,
        "title_source": title_source,
        "author_key": author_key,
        "author_suffix": author_suffix,
        "timestamp": timestamp,
        "timestamp_iso": timestamp_iso,
        "sha256": f"sha256:{digest}",
    }

    if output.exists() and not args.replace:
        fail(f"Output already exists: {output}")

    telegram_enabled = bool((outbox.get("telegram") or {}).get("enabled")) and not args.no_telegram

    if args.dry_run:
        receipt["telegram"] = {"planned": telegram_enabled}
    else:
        output.parent.mkdir(parents=True, exist_ok=True)
        receipts.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, output)
        if telegram_enabled:
            receipt["telegram"] = send_via_telegram(workspace, output)
            if not receipt["telegram"]["ok"]:
                print(f"WARNING: telegram send failed: {receipt['telegram']['error']}", file=sys.stderr)
        with receipts.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(receipt, ensure_ascii=False, sort_keys=True) + "\n")

    print(json.dumps({"ok": True, "dry_run": args.dry_run, "output": str(output), "receipt": str(receipts), "data": receipt}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

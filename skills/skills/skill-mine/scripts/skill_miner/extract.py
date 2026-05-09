"""Extract pure user prompts from Claude Code session JSONL files.

Mechanical stage — no NLP, stdlib only.
"""
from __future__ import annotations
import hashlib
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Iterator

MIN_LEN = 10
MAX_LEN = 2000

WRAPPER_PREFIXES = (
    "<local-command-",
    "<command-name>",
    "<command-message>",
    "<command-args>",
    "<command-stdout>",
    "<task-notification>",
    "<bash-stdout>",
    "<bash-stderr>",
    "<bash-input>",
)


INTERRUPT_MARKERS = (
    "[Request interrupted by user for tool use]",
    "[Request interrupted by user]",
)


def _is_wrapper_only(text: str) -> bool:
    """Return True if text is purely a CLI/tool wrapper, not a user instruction."""
    s = text.strip()
    if not s:
        return True
    if s in INTERRUPT_MARKERS:
        return True
    if s.startswith(WRAPPER_PREFIXES):
        return True
    # Pure system-reminder (no user text outside the tag)
    if s.startswith("<system-reminder>") and s.endswith("</system-reminder>"):
        inner = s[len("<system-reminder>") : -len("</system-reminder>")].strip()
        # If there is no second user-authored content and the reminder is a system notice, drop.
        if "<system-reminder>" not in inner:
            return True
    return False


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _parse_ts(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


def iter_session_files(root: Path) -> Iterator[Path]:
    yield from sorted(root.glob("*.jsonl"))
    # Also include subagent JSONLs
    for sub in root.iterdir():
        if sub.is_dir() and sub.name != "memory":
            yield from sorted(sub.rglob("*.jsonl"))


def extract_prompts(
    root: Path,
    since: datetime,
    min_len: int = MIN_LEN,
    max_len: int = MAX_LEN,
) -> list[dict]:
    """Extract pure user prompts from Claude Code JSONL files under `root`.

    Returns list of dicts: {id, session_id, timestamp, cwd, text, length}.
    """
    seen_hashes: set[str] = set()
    out: list[dict] = []

    for f in iter_session_files(root):
        try:
            for line in f.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    d = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if d.get("type") != "user":
                    continue
                if d.get("isMeta"):
                    continue

                ts = _parse_ts(d.get("timestamp"))
                if ts is None or ts < since:
                    continue

                msg = d.get("message") or {}
                content = msg.get("content")
                if isinstance(content, list):
                    # tool_result blocks — skip
                    if any(
                        isinstance(e, dict) and e.get("type") == "tool_result"
                        for e in content
                    ):
                        continue
                    # Otherwise collect any text blocks
                    parts = [
                        e.get("text", "")
                        for e in content
                        if isinstance(e, dict) and e.get("type") == "text"
                    ]
                    text = "\n".join(p for p in parts if p).strip()
                elif isinstance(content, str):
                    text = content.strip()
                else:
                    continue

                if not text or _is_wrapper_only(text):
                    continue
                if not (min_len <= len(text) <= max_len):
                    continue

                h = _digest(text)
                if h in seen_hashes:
                    continue
                seen_hashes.add(h)

                out.append(
                    {
                        "id": f"p_{h}",
                        "session_id": d.get("sessionId") or f.stem,
                        "timestamp": ts.isoformat(),
                        "cwd": d.get("cwd") or "",
                        "text": text,
                        "length": len(text),
                    }
                )
        except OSError:
            continue

    out.sort(key=lambda r: r["timestamp"])
    return out


def write_cache(records: list[dict], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def load_cache(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Extract pure user prompts from Claude Code JSONL")
    parser.add_argument("--project-dir", default=str(Path.home() / ".claude" / "projects"),
                        help="Claude Code project JSONL root")
    parser.add_argument("--days", type=int, default=30, help="Lookback window in days")
    parser.add_argument("--out", required=True, help="Output JSONL path")
    args = parser.parse_args(argv)

    since = datetime.now(timezone.utc) - timedelta(days=args.days)
    recs = extract_prompts(Path(args.project_dir), since=since)
    write_cache(recs, Path(args.out))
    print(f"extracted {len(recs)} prompts (since {since.isoformat()}) -> {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

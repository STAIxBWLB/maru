#!/usr/bin/env python3
"""Graduate a cycle unit to L3 (Tree C §B7): emit a migrate_tree.py manifest.

This script NEVER moves files. It scans the unit's root stage directories,
maps them to Tree B destinations (DR-025 §5 / DR-026), and writes a manifest
JSON compatible with the workspace tool `_meta/scripts/migrate_tree.py`,
which owns the actual moves, reference rewriting, and path-map updates.

Usage:
  graduate_unit.py projects/oda/koica-tiu-2027 --year 2027 [-o manifest.json]
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from lifecycle_common import (
    GRADUATION_FALLBACK,
    GRADUATION_MAP,
    YEAR_RE,
    find_workspace_root,
)

STAGE_RE = re.compile(r"^\d\d-(.+)$")
SKIP = {"_incoming", "_archive", "_templates", "00-readme"}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("unit", help="workspace-relative unit path, e.g. projects/oda/<slug>")
    parser.add_argument("--year", required=True, help="selection year (4 digits)")
    parser.add_argument("-o", "--out", help="manifest output path (default: stdout)")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not YEAR_RE.match(args.year):
        raise SystemExit(f"ERROR: --year must be 4 digits: {args.year}")
    workspace = find_workspace_root(Path.cwd())
    root = workspace / args.unit
    if not root.is_dir():
        raise SystemExit(f"ERROR: unit not found: {root}")

    moves, mkdirs = [], set()
    for entry in sorted(root.iterdir()):
        if not entry.is_dir() or entry.name in SKIP or entry.name.startswith("."):
            continue
        m = STAGE_RE.match(entry.name)
        if not m:
            continue  # non-stage dirs stay put; report tooling will flag leftovers
        slug = m.group(1)
        dest = GRADUATION_MAP.get(slug, GRADUATION_FALLBACK).format(
            year=args.year, slug=slug)
        mkdirs.add(dest.rsplit("/", 1)[0] if "/" in dest else dest)
        moves.append({"old": entry.name, "new": dest})

    if not moves:
        raise SystemExit(f"ERROR: no NN-<stage> directories found under {root}")

    manifest = {
        "root": args.unit,
        "mkdirs": sorted(mkdirs),
        "moves": moves,
        "files": [],
        "extra_pairs": [[m["old"] + "/", m["new"] + "/"] for m in moves],
        "manual_pre_steps": [
            "review the stage->destination mapping below before running",
            "after migrate_tree.py: update registry (remove 'profile: cycle' pin)",
            "same commit: python3 _meta/scripts/gen_structure.py --project <id>",
        ],
    }
    payload = json.dumps(manifest, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(payload + "\n", encoding="utf-8")
        print(f"manifest written: {args.out}")
    else:
        print(payload)
    print("\nRun (dry-run first):", file=sys.stderr)
    print(f"  python3 _meta/scripts/migrate_tree.py <manifest> --dry-run", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())

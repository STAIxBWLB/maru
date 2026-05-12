#!/usr/bin/env python3
"""Add a standard year-cycle folder to an existing business unit."""

from __future__ import annotations

import argparse
import re
import shutil
import sys
from pathlib import Path


YEAR_RE = re.compile(r"^[0-9]{4}$")
YEAR_FOLDER_RE = re.compile(r"^[0-9]{4}-Y([0-9]+)$")


def find_workspace_root(start: Path) -> Path:
    for candidate in [start, *start.parents]:
        if (candidate / "workspace.config.yaml").is_file():
            return candidate
    raise SystemExit("ERROR: workspace.config.yaml not found in ancestors")


def skill_root() -> Path:
    return Path(__file__).resolve().parents[1]


def find_business_unit(workspace: Path, slug: str, domain: str | None) -> Path:
    if domain:
        target = workspace / "projects" / domain / slug
        if not target.is_dir():
            raise SystemExit(f"ERROR: business unit not found: {target}")
        return target

    matches = [
        path
        for path in (workspace / "projects").glob(f"*/{slug}")
        if path.is_dir()
    ]
    if not matches:
        raise SystemExit(f"ERROR: business unit '{slug}' not found under projects/")
    if len(matches) > 1:
        formatted = "\n".join(f"  {match}" for match in matches)
        raise SystemExit(f"ERROR: multiple matches; pass --domain:\n{formatted}")
    return matches[0]


def infer_year_number(target: Path) -> int:
    highest = 0
    for child in target.iterdir():
        if child.is_dir():
            match = YEAR_FOLDER_RE.match(child.name)
            if match:
                highest = max(highest, int(match.group(1)))
    return highest + 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("slug", help="business-unit slug")
    parser.add_argument("year", help="4-digit calendar year")
    parser.add_argument("--domain", help="projects domain, e.g. govt")
    parser.add_argument("--year-number", type=int, help="business year number")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not YEAR_RE.match(args.year):
        raise SystemExit(f"ERROR: year must be 4 digits: {args.year}")
    if args.year_number is not None and args.year_number < 1:
        raise SystemExit("ERROR: --year-number must be positive")

    workspace = find_workspace_root(Path.cwd())
    target = find_business_unit(workspace, args.slug, args.domain)
    year_number = args.year_number or infer_year_number(target)
    year_folder = target / f"{args.year}-Y{year_number}"
    if year_folder.exists():
        raise SystemExit(f"ERROR: year folder already exists: {year_folder}")

    template = skill_root() / "templates" / "standard-business-unit" / "year-cycle"
    if not template.is_dir():
        raise SystemExit(f"ERROR: year-cycle template not found: {template}")

    shutil.copytree(template, year_folder)
    print(f"created year cycle: {year_folder}")
    print()
    print("Update project-registry.yaml manually when ready:")
    print(f"  lifecycle_schema: business-unit-lifecycle-v1")
    print(f"  lifecycle_stage: implementing")
    print(f"  current_year: {args.year}-Y{year_number}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

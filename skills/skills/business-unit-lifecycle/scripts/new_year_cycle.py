#!/usr/bin/env python3
"""Add a calendar-year partition to an existing business unit (Tree B)."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
DOMAIN_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
YEAR_RE = re.compile(r"^[0-9]{4}$")

# Calendar-year leaves nested inside each category (Tree B).
# Duplicated from new_business_unit.py so each script stays standalone.
YEAR_LEAVES = [
    "01-formal-reports/{year}/monthly",
    "01-formal-reports/{year}/quarterly",
    "01-formal-reports/{year}/annual",
    "01-formal-reports/{year}/interim",
    "02-admin-approvals/{year}/internal-approval",
    "02-admin-approvals/{year}/external-dispatch",
    "02-admin-approvals/{year}/proposal",
    "02-admin-approvals/{year}/expense",
    "03-evidence-cert/{year}/receipts",
    "03-evidence-cert/{year}/contracts",
    "03-evidence-cert/{year}/invoices",
    "03-evidence-cert/{year}/payments",
    "03-evidence-cert/{year}/attendance",
    "03-evidence-cert/{year}/certificates",
    "04-operations/meetings/{year}",
    "04-operations/trips/{year}",
    "04-operations/events/{year}",
]


def find_workspace_root(start: Path) -> Path:
    for candidate in [start, *start.parents]:
        if (candidate / "workspace.config.yaml").is_file():
            return candidate
    raise SystemExit("ERROR: workspace.config.yaml not found in ancestors")


def find_business_unit(workspace: Path, slug: str, domain: str | None) -> Path:
    if domain:
        target = workspace / "projects" / domain / slug
        if not target.is_dir():
            raise SystemExit(f"ERROR: business unit not found: {target}")
        return target

    projects_root = workspace / "projects"
    if not projects_root.is_dir():
        raise SystemExit(f"ERROR: projects root not found: {projects_root}")
    matches = [
        domain_dir / slug
        for domain_dir in projects_root.iterdir()
        if domain_dir.is_dir() and (domain_dir / slug).is_dir()
    ]
    if not matches:
        raise SystemExit(f"ERROR: business unit '{slug}' not found under projects/")
    if len(matches) > 1:
        formatted = "\n".join(f"  {match}" for match in matches)
        raise SystemExit(f"ERROR: multiple matches; pass --domain:\n{formatted}")
    return matches[0]


def create_year_partition(target: Path, year: str) -> None:
    """Create the calendar-year leaves under each category; seed each with .gitkeep."""
    for leaf in YEAR_LEAVES:
        leaf_dir = target / leaf.format(year=year)
        leaf_dir.mkdir(parents=True, exist_ok=True)
        (leaf_dir / ".gitkeep").touch()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("slug", help="business-unit slug")
    parser.add_argument("year", help="4-digit calendar year")
    parser.add_argument("--domain", help="projects domain, e.g. govt")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not SLUG_RE.match(args.slug):
        raise SystemExit(f"ERROR: slug must be lowercase-hyphenated: {args.slug}")
    if args.domain is not None and not DOMAIN_RE.match(args.domain):
        raise SystemExit(f"ERROR: domain must be lowercase-hyphenated: {args.domain}")
    if not YEAR_RE.match(args.year):
        raise SystemExit(f"ERROR: year must be 4 digits: {args.year}")

    workspace = find_workspace_root(Path.cwd())
    target = find_business_unit(workspace, args.slug, args.domain)

    year_marker = target / "01-formal-reports" / args.year
    if year_marker.exists():
        raise SystemExit(f"ERROR: year partition already exists: {year_marker}")

    create_year_partition(target, args.year)
    print(f"created year partition: {target} ({args.year})")
    print()
    print("Update project-registry.yaml manually when ready:")
    print("  lifecycle_schema: business-unit-lifecycle-v2")
    print("  lifecycle_stage: implementing")
    print(f"  current_year: {args.year}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

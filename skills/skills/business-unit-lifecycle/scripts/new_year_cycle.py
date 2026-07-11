#!/usr/bin/env python3
"""Add a calendar-year partition to an existing business unit (Tree C L3).

Seeds year leaves only for categories that already exist on disk
(naming-and-placement §B2: no empty scaffolds). Activating a brand-new
category is `new_business_unit.py --with`'s job at creation time, or a plain
mkdir when the first obligation appears.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from lifecycle_common import (
    DOMAIN_RE,
    SLUG_RE,
    YEAR_LEAVES,
    YEAR_RE,
    create_year_partition,
    find_workspace_root,
)


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
    if not any((target / leaf.split("/", 1)[0]).is_dir() for leaf in YEAR_LEAVES):
        raise SystemExit(
            f"ERROR: no active spine categories under {target}; "
            "activate one first (first obligation, or new_business_unit.py --with)")

    made = create_year_partition(target, args.year, only_existing=True)
    print(f"created year partition: {target} ({args.year})")
    for leaf in made:
        print(f"  {leaf}")
    print()
    print("Update project-registry.yaml manually when ready:")
    print("  lifecycle_stage: implementing")
    print(f"  current_year: {args.year}")
    print("Then regenerate the structure index (same commit):")
    print("  python3 _meta/scripts/gen_structure.py --project <id>")
    return 0


if __name__ == "__main__":
    sys.exit(main())

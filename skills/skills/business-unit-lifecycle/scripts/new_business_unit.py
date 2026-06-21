#!/usr/bin/env python3
"""Create a standard business-unit project tree (Tree B)."""

from __future__ import annotations

import argparse
import re
import shutil
import sys
from datetime import date
from pathlib import Path


SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
DOMAIN_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
YEAR_RE = re.compile(r"^[0-9]{4}$")

# Calendar-year leaves nested inside each category (Tree B).
# Each entry is a path template; `{year}` is filled with the 4-digit year.
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


def skill_root() -> Path:
    return Path(__file__).resolve().parents[1]


def create_year_partition(target: Path, year: str) -> None:
    """Create the calendar-year leaves under each category; seed each with .gitkeep."""
    for leaf in YEAR_LEAVES:
        leaf_dir = target / leaf.format(year=year)
        leaf_dir.mkdir(parents=True, exist_ok=True)
        (leaf_dir / ".gitkeep").touch()


def write_readme(target: Path, domain: str, slug: str, start_year: str | None) -> None:
    current_year = start_year or ""
    readme = f"""---
id: {domain}-{slug}
name: "{slug}"
slug: {slug}
domain: {domain}
status: active
lifecycle_schema: business-unit-lifecycle-v2
lifecycle_stage: initiation
current_year: {current_year}
start_date:
end_date:
funding_source:
total_budget:
headquarters_director:
migrated: true
created: {date.today().isoformat()}
---

# {slug} (business unit)

> One-line description

## Overview

- **Program name**:
- **Funding source**:
- **Period**:
- **Total budget**:
- **Director**:

## Folders

| Path | Purpose |
|------|---------|
| `00-readme/` | README, bu-config (view), contact tree, KPI targets |
| `01-formal-reports/` | 정형보고 ({{YYYY}}/monthly,quarterly,annual,interim) |
| `02-admin-approvals/` | 행정결재, change requests |
| `03-evidence-cert/` | 증빙·계약·인보이스·인증·감사 |
| `04-operations/` | meetings/trips/events ({{YYYY}}), proposals, specs, guides |
| `05-decks/` | 발표 덱 (per-slug deck job) |
| `_inbox/` | Temporary intake before routing |
| `_archive/` | Old versions, discarded drafts, outgoing packages |
"""
    (target / "README.md").write_text(readme, encoding="utf-8")


def registry_stub(domain: str, slug: str, start_year: str | None) -> str:
    current_year = start_year or ""
    return f"""
Add this stub to project-registry.yaml when ready:

  - id: {domain}-{slug}
    name: "{slug}"
    name_en: ""
    path: "projects/{domain}/{slug}/"
    vault_note: ""
    status: active
    lifecycle_schema: business-unit-lifecycle-v2
    lifecycle_stage: initiation
    current_year: {current_year}
    start_date:
    end_date:
    funding_source: ""
    total_budget:
    headquarters_director: ""
    migrated: true
    keywords:
      ko: []
      en: []
    acronyms: []
    tags: []
    people: []
    orgs: []
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("domain", help="projects/<domain>/<slug>")
    parser.add_argument("slug", help="lowercase hyphenated business-unit slug")
    parser.add_argument("--start-year", help="4-digit first operating year")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not DOMAIN_RE.match(args.domain):
        raise SystemExit(f"ERROR: domain must be lowercase-hyphenated: {args.domain}")
    if not SLUG_RE.match(args.slug):
        raise SystemExit(f"ERROR: slug must be lowercase-hyphenated: {args.slug}")
    if args.start_year and not YEAR_RE.match(args.start_year):
        raise SystemExit(f"ERROR: --start-year must be 4 digits: {args.start_year}")

    workspace = find_workspace_root(Path.cwd())
    template = skill_root() / "templates" / "standard-business-unit"
    if not template.is_dir():
        raise SystemExit(f"ERROR: template not found: {template}")

    target = workspace / "projects" / args.domain / args.slug
    if target.exists():
        raise SystemExit(f"ERROR: target already exists: {target}")

    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(template, target)
    write_readme(target, args.domain, args.slug, args.start_year)
    print(f"created business-unit tree: {target}")

    if args.start_year:
        create_year_partition(target, args.start_year)
        print(f"created year partition: {args.start_year}")

    print(registry_stub(args.domain, args.slug, args.start_year))
    return 0


if __name__ == "__main__":
    sys.exit(main())

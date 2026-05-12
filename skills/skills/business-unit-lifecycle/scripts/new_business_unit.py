#!/usr/bin/env python3
"""Create a standard business-unit project tree."""

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


def find_workspace_root(start: Path) -> Path:
    for candidate in [start, *start.parents]:
        if (candidate / "workspace.config.yaml").is_file():
            return candidate
    raise SystemExit("ERROR: workspace.config.yaml not found in ancestors")


def skill_root() -> Path:
    return Path(__file__).resolve().parents[1]


def copytree(src: Path, dst: Path, *, ignore_year_cycle: bool = False) -> None:
    ignore = shutil.ignore_patterns("year-cycle") if ignore_year_cycle else None
    shutil.copytree(src, dst, ignore=ignore)


def write_readme(target: Path, domain: str, slug: str, start_year: str | None) -> None:
    current_year = f"{start_year}-Y1" if start_year else ""
    readme = f"""---
id: {domain}-{slug}
name: "{slug}"
slug: {slug}
domain: {domain}
status: active
lifecycle_schema: business-unit-lifecycle-v1
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
| `_inbox/` | Temporary intake before routing |
| `_templates/` | Project-specific forms and checklists |
| `_archive/` | Old versions, discarded drafts, outgoing packages |
| `00-initiation/` | Discovery, proposal, evaluation, agreement |
| `10-governance/` | Organization, committees, consortium, policy, compliance |
| `20-shared/` | Cross-year references, meetings, communications, contacts, assets |
| `{{YYYY}}-Y{{N}}/` | Yearly operating cycle |
| `99-closure/` | Whole-project closure |
"""
    (target / "README.md").write_text(readme, encoding="utf-8")


def registry_stub(domain: str, slug: str, start_year: str | None) -> str:
    current_year = f"{start_year}-Y1" if start_year else ""
    return f"""
Add this stub to project-registry.yaml when ready:

  - id: {domain}-{slug}
    name: "{slug}"
    name_en: ""
    path: "projects/{domain}/{slug}/"
    vault_note: ""
    status: active
    lifecycle_schema: business-unit-lifecycle-v1
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
    copytree(template, target, ignore_year_cycle=True)
    write_readme(target, args.domain, args.slug, args.start_year)
    print(f"created business-unit tree: {target}")

    if args.start_year:
        year_target = target / f"{args.start_year}-Y1"
        copytree(template / "year-cycle", year_target)
        print(f"created year cycle: {year_target}")

    print(registry_stub(args.domain, args.slug, args.start_year))
    return 0


if __name__ == "__main__":
    sys.exit(main())

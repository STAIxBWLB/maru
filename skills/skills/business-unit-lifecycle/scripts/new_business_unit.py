#!/usr/bin/env python3
"""Create a business-unit project tree (Tree C, proposal-first).

Default scaffold is minimal per naming-and-placement §B: README + 00-readme
charter + 06-proposal + aux (_incoming/_archive). Categories 01~05 are never
pre-created empty; activate them with --with when a real obligation exists.

Modes:
  new_business_unit.py <domain> <slug>                      # L3 seed (proposal-first)
  new_business_unit.py <domain> <slug> --with 01,04 --start-year 2027
  new_business_unit.py <domain> <slug> --profile cycle      # cycle unit (§B6)
"""

from __future__ import annotations

import argparse
import shutil
import sys
from datetime import date
from pathlib import Path

from lifecycle_common import (
    CATEGORIES,
    CYCLE_STAGES,
    DOMAIN_RE,
    SLUG_RE,
    YEAR_RE,
    create_year_partition,
    find_workspace_root,
)


def skill_root() -> Path:
    return Path(__file__).resolve().parents[1]


def write_readme(target: Path, domain: str, slug: str, start_year: str | None,
                 profile: str) -> None:
    current_year = start_year or ""
    if profile == "cycle":
        folders = "\n".join(
            f"| `{s}/` | (create on demand) |" for s in CYCLE_STAGES[:4]
        )
        folders_note = (
            "Cycle unit (§B6): numbered stage dirs, order-only numbering, gaps OK.\n"
            "On selection, graduate to L3 with `graduate_unit.py` (emits a\n"
            "migrate_tree.py manifest)."
        )
    else:
        folders = (
            "| `00-readme/` | README, bu-config (view), contact tree, KPI targets |\n"
            "| `06-proposal/` | pre-selection space (announcement/drafts/final/review/contracting) |\n"
            "| `01-formal-reports/` | activate on first formal report (`--with 01`) |\n"
            "| `02-admin-approvals/` | activate on first approval |\n"
            "| `03-evidence-cert/` | activate on first evidence/contract |\n"
            "| `04-operations/` | activate on first operational content |\n"
            "| `_incoming/` | temporary intake before routing |\n"
            "| `_archive/` | old versions, discarded drafts |"
        )
        folders_note = "Proposal-first (Tree C §B): no empty category scaffolds."
    readme = f"""---
id: {domain}-{slug}
name: "{slug}"
slug: {slug}
domain: {domain}
status: active
lifecycle_schema: business-unit-lifecycle-v2
lifecycle_stage: {"proposal" if profile == "cycle" else "initiation"}
current_year: {current_year}
created: {date.today().isoformat()}
---

# {slug} (business unit)

> One-line description

{folders_note}

## Folders

| Path | Purpose |
|------|---------|
{folders}
"""
    (target / "README.md").write_text(readme, encoding="utf-8")


def registry_stub(domain: str, slug: str, profile: str) -> str:
    profile_line = "    profile: cycle   # §B6, pin required for cycle units\n" \
        if profile == "cycle" else ""
    return f"""
Add this stub to project-registry.yaml when ready:

  - id: {domain}-{slug}
    name: "{slug}"
    name_en: ""
    path: "projects/{domain}/{slug}/"
{profile_line}    vault_note: ""
    status: active
    keywords:
      ko: []
      en: []
    acronyms: []
    tags: []
    people: []
    orgs: []

Then regenerate the structure index:
  python3 _meta/scripts/gen_structure.py --project {domain}-{slug}
"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("domain", help="projects/<domain>/<slug>")
    parser.add_argument("slug", help="lowercase hyphenated business-unit slug")
    parser.add_argument("--start-year", help="4-digit first operating year")
    parser.add_argument("--with", dest="with_categories", default="",
                        help="comma list of categories to activate now, e.g. 01,04")
    parser.add_argument("--profile", choices=["l3", "cycle"], default="l3",
                        help="cycle scaffolds a §B6 application-cycle unit")
    parser.add_argument("--stages", default="01-announcement",
                        help="cycle mode: comma list of stage dirs to create")
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
    target = workspace / "projects" / args.domain / args.slug
    if target.exists():
        raise SystemExit(f"ERROR: target already exists: {target}")

    if args.profile == "cycle":
        target.mkdir(parents=True)
        for aux in ("_incoming", "_archive"):
            (target / aux).mkdir()
        for stage in [s.strip() for s in args.stages.split(",") if s.strip()]:
            (target / stage).mkdir()
        write_readme(target, args.domain, args.slug, args.start_year, "cycle")
        print(f"created cycle unit: {target}")
        print(f"recommended stage vocabulary (§B6): {', '.join(CYCLE_STAGES)}")
    else:
        template = skill_root() / "templates" / "standard-business-unit"
        if not template.is_dir():
            raise SystemExit(f"ERROR: template not found: {template}")
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(template, target)
        write_readme(target, args.domain, args.slug, args.start_year, "l3")
        for token in [t.strip() for t in args.with_categories.split(",") if t.strip()]:
            category = CATEGORIES.get(token)
            if not category:
                raise SystemExit(f"ERROR: unknown category token: {token}")
            (target / category).mkdir(exist_ok=True)
        print(f"created business-unit tree: {target}")
        if args.start_year:
            made = create_year_partition(target, args.start_year, only_existing=True)
            print(f"created year partition ({args.start_year}): "
                  f"{', '.join(made) if made else 'no active categories to seed'}")

    print(registry_stub(args.domain, args.slug, args.profile))
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""Shared constants and helpers for business-unit-lifecycle scripts.

Single source for the year-partition leaves and cycle-stage vocabulary.
Tree C grammar and canonical vocabulary: workspace
`_meta/rules/naming-and-placement.md` (§B, §E) and DR-026.
"""

from __future__ import annotations

import re
from pathlib import Path

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
DOMAIN_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
YEAR_RE = re.compile(r"^[0-9]{4}$")

# Calendar-year leaves per category (Tree C L3 spine).
# Trimmed to rule-canonical paths: `02-admin-approvals` subdirs follow
# naming-and-placement §B/§C (internal-approval, official-documents);
# evidence kind subdirs (receipts/contracts/...) are created on demand because
# the Maru app detects the six kind names anywhere in the path.
YEAR_LEAVES = [
    "01-formal-reports/{year}",
    "02-admin-approvals/{year}/internal-approval",
    "02-admin-approvals/{year}/official-documents",
    "03-evidence-cert/{year}",
    "04-operations/meetings/{year}",
]

# Category selector tokens for `new_business_unit.py --with`.
CATEGORIES = {
    "01": "01-formal-reports",
    "02": "02-admin-approvals",
    "03": "03-evidence-cert",
    "04": "04-operations",
    "05": "05-decks",
    "07": "07-external-eval",
}

# cycle profile: recommended stage vocabulary (§B6). Numbers mean order only;
# gaps are allowed and names are free slugs.
CYCLE_STAGES = [
    "01-announcement",
    "02-eligibility",
    "03-self-evaluation",
    "04-proposal",
    "05-budget",
    "06-interview",
    "07-agreements",
    "08-contracting",
]

# cycle -> L3 graduation mapping (DR-025 §5 / DR-026 §B7), keyed by stage slug.
# `{year}` is filled at manifest-generation time.
GRADUATION_MAP = {
    "announcement": "06-proposal/announcement",
    "refs": "06-proposal/announcement",
    "eligibility": "06-proposal/review",
    "eligibility-eval": "06-proposal/review",
    "interview": "06-proposal/review",
    "review": "06-proposal/review",
    "self-evaluation": "01-formal-reports/{year}",
    "proposal": "06-proposal/final",
    "budget": "06-proposal/budget",
    "agreements": "03-evidence-cert/{year}/contracts",
    "contracting": "06-proposal/contracting",
}
GRADUATION_FALLBACK = "04-operations/{slug}"


def find_workspace_root(start: Path) -> Path:
    for candidate in [start, *start.parents]:
        if (candidate / "workspace.config.yaml").is_file():
            return candidate
    raise SystemExit("ERROR: workspace.config.yaml not found in ancestors")


def create_year_partition(target: Path, year: str, only_existing: bool = True) -> list[str]:
    """Seed calendar-year leaves. With only_existing, seed only categories that
    already exist on disk (no empty scaffolds, naming-and-placement §B2)."""
    made = []
    for leaf in YEAR_LEAVES:
        category = leaf.split("/", 1)[0]
        if only_existing and not (target / category).is_dir():
            continue
        leaf_dir = target / leaf.format(year=year)
        leaf_dir.mkdir(parents=True, exist_ok=True)
        (leaf_dir / ".gitkeep").touch()
        made.append(leaf.format(year=year))
    return made

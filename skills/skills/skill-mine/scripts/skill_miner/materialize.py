"""Materialize prompts into a virtual wiki-vault for graph ingestion.

Each prompt becomes a markdown note with frontmatter + wiki-links to matched
action/object/entity vocabulary nodes. Vocabulary nodes are materialized as
stub notes so the graph has bidirectional references.

No LLM calls. Pure dictionary-based longest-match tokenization.
"""
from __future__ import annotations
import json
import re
import sys
from pathlib import Path
from typing import Iterable

import yaml

THIS_DIR = Path(__file__).resolve().parent
VOCAB_DIR = THIS_DIR / "vocab"


# ── Slug helpers ──────────────────────────────────────────────────────

_SLUG_RE = re.compile(r"[^0-9A-Za-z가-힣._-]+")


def slugify(name: str) -> str:
    s = name.strip().lower()
    s = s.replace(" ", "-")
    s = _SLUG_RE.sub("-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s or "unnamed"


# ── Dictionary loading ────────────────────────────────────────────────

def _load_yaml(path: Path) -> dict:
    if not path.exists():
        return {}
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


def load_actions() -> list[dict]:
    data = _load_yaml(VOCAB_DIR / "actions.yaml")
    return data.get("actions", [])


def load_objects() -> list[dict]:
    data = _load_yaml(VOCAB_DIR / "objects.yaml")
    return data.get("objects", [])


def load_registry(path: Path) -> list[dict]:
    if not path.exists():
        return []
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return data.get("projects", [])


# ── Entity surface aggregation ────────────────────────────────────────

def build_surface_index(
    actions: list[dict],
    objects: list[dict],
    projects: list[dict],
) -> list[tuple[str, str, str]]:
    """Return list of (surface, node_kind, canonical_id) sorted longest-first."""
    entries: list[tuple[str, str, str]] = []

    for a in actions:
        canon = a.get("canon")
        if not canon:
            continue
        for s in a.get("surface", []) or []:
            entries.append((s, "action", canon))

    for o in objects:
        canon = o.get("canon")
        if not canon:
            continue
        for s in o.get("surface", []) or []:
            entries.append((s, "object", canon))

    for p in projects:
        pid = p.get("id")
        if not pid:
            continue
        # keywords (ko + en)
        kw = p.get("keywords") or {}
        for s in (kw.get("ko") or []) + (kw.get("en") or []):
            entries.append((s, "project", pid))
        # acronyms
        for s in p.get("acronyms") or []:
            entries.append((s, "project", pid))
        # people
        for s in p.get("people") or []:
            entries.append((s, "person", slugify(s)))
        # orgs
        for s in p.get("orgs") or []:
            entries.append((s, "org", slugify(s)))
        # sub_projects keywords_extra
        for sp in p.get("sub_projects") or []:
            spid = sp.get("id")
            for s in sp.get("keywords_extra") or []:
                entries.append((s, "project", spid or pid))

    # Coerce all surfaces to str, drop empties, deduplicate
    seen = set()
    uniq: list[tuple[str, str, str]] = []
    for surf, kind, canon in entries:
        surf = str(surf) if surf is not None else ""
        if not surf.strip():
            continue
        key = (surf, kind, canon)
        if key in seen:
            continue
        seen.add(key)
        uniq.append((surf, kind, canon))

    uniq.sort(key=lambda t: (-len(t[0]), t[0]))
    return uniq


# ── Matching ──────────────────────────────────────────────────────────

def find_matches(text: str, index: list[tuple[str, str, str]]) -> set[tuple[str, str]]:
    """Return set of (kind, canon) for every surface term found in text.

    Longest-match order: longer surface tokens are evaluated first so more specific phrases win over shorter acronyms.
    Case-insensitive for ASCII; exact for Korean.
    """
    hits: set[tuple[str, str]] = set()
    lowered = text.lower()
    for surf, kind, canon in index:
        if not surf:
            continue
        needle = surf.lower() if surf.isascii() else surf
        haystack = lowered if surf.isascii() else text
        if needle in haystack:
            hits.add((kind, canon))
    return hits


# ── PII masking ───────────────────────────────────────────────────────

_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_PATH_RE = re.compile(r"(?:(?:/|~/)[\w.\-/]+|[A-Z]:\\[\w.\-\\]+)")


def mask_text(text: str, people: Iterable[str]) -> str:
    masked = text
    masked = _EMAIL_RE.sub("[EMAIL]", masked)
    masked = _PATH_RE.sub("[PATH]", masked)
    for name in people:
        if name and name in masked:
            masked = masked.replace(name, "[PERSON]")
    return masked


def _all_people(projects: list[dict]) -> list[str]:
    names: set[str] = set()
    for p in projects:
        for n in p.get("people") or []:
            if n:
                names.add(n)
    return sorted(names, key=len, reverse=True)


# ── Note rendering ────────────────────────────────────────────────────

def node_id(kind: str, canon: str) -> str:
    """Canonical filename stem for a graph node (wiki-link target)."""
    return f"{kind}--{slugify(canon)}"


def wikilink(kind: str, canon: str) -> str:
    return f"[[{node_id(kind, canon)}]]"


def render_prompt_note(
    prompt: dict,
    hits: set[tuple[str, str]],
    masked: str,
) -> str:
    frontmatter_lines = [
        "---",
        f"id: {prompt['id']}",
        "type: prompt",
        f"session: {prompt.get('session_id', '')}",
        f"timestamp: {prompt.get('timestamp', '')}",
        f"length: {prompt.get('length', len(masked))}",
        "---",
    ]
    body = [masked.strip(), ""]
    if hits:
        links = " ".join(sorted(wikilink(k, c) for k, c in hits))
        body.append(links)
    return "\n".join(frontmatter_lines + [""] + body) + "\n"


def render_stub_note(kind: str, canon: str, label: str) -> str:
    return (
        "---\n"
        f"id: {node_id(kind, canon)}\n"
        f"type: {kind}\n"
        f"label: {label}\n"
        "---\n\n"
        f"{label}\n"
    )


# ── Orchestration ─────────────────────────────────────────────────────

def materialize(
    prompts: list[dict],
    out_dir: Path,
    registry_path: Path,
) -> dict:
    out_dir = Path(out_dir)
    notes_dir = out_dir / "notes"
    notes_dir.mkdir(parents=True, exist_ok=True)

    actions = load_actions()
    objects = load_objects()
    projects = load_registry(registry_path)
    index = build_surface_index(actions, objects, projects)
    people = _all_people(projects)

    all_hits_used: set[tuple[str, str]] = set()
    stats = {"prompts": 0, "matched_prompts": 0, "total_hits": 0}

    for p in prompts:
        text = p.get("text") or ""
        hits = find_matches(text, index)
        masked = mask_text(text, people)
        note = render_prompt_note(p, hits, masked)
        (notes_dir / f"{p['id']}.md").write_text(note, encoding="utf-8")
        stats["prompts"] += 1
        if hits:
            stats["matched_prompts"] += 1
        stats["total_hits"] += len(hits)
        all_hits_used.update(hits)

    # Materialize vocabulary stub notes only for kinds/canon actually referenced.
    labels: dict[tuple[str, str], str] = {}
    for a in actions:
        labels[("action", a["canon"])] = a["canon"]
    for o in objects:
        labels[("object", o["canon"])] = o["canon"]
    for p in projects:
        pid = p.get("id")
        if pid:
            labels[("project", pid)] = p.get("name", pid)
        for sp in p.get("sub_projects") or []:
            spid = sp.get("id")
            if spid:
                labels[("project", spid)] = sp.get("name", spid)
        for n in p.get("people") or []:
            labels[("person", slugify(n))] = "[PERSON]"
        for o_name in p.get("orgs") or []:
            labels[("org", slugify(o_name))] = o_name

    for kind, canon in all_hits_used:
        label = labels.get((kind, canon), canon)
        (notes_dir / f"{node_id(kind, canon)}.md").write_text(
            render_stub_note(kind, canon, label), encoding="utf-8"
        )

    stats["stub_notes"] = len(all_hits_used)
    stats["out_dir"] = str(out_dir)
    return stats


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Materialize prompts as virtual wiki-vault notes.")
    parser.add_argument("--in", dest="inp", required=True, help="prompts JSONL from extract stage")
    parser.add_argument("--out", required=True, help="output virtual-vault dir")
    parser.add_argument("--registry", default="project-registry.yaml")
    args = parser.parse_args(argv)

    prompts = [
        json.loads(line)
        for line in Path(args.inp).read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    stats = materialize(prompts, Path(args.out), Path(args.registry))
    print(f"[materialize] {stats['prompts']} prompts, {stats['matched_prompts']} matched, "
          f"{stats['total_hits']} hits, {stats['stub_notes']} stubs -> {stats['out_dir']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

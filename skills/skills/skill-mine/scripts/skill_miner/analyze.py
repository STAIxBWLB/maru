"""Convert graph communities into skill candidates and render a report.

No LLM calls. Scoring is purely graph-based (degree, community size,
cohesion, Jaccard novelty against existing skill catalog).
"""
from __future__ import annotations
import json
import math
import re
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

import networkx as nx

import graph_build

def _find_workspace_root() -> Path:
    for path in Path(__file__).resolve().parents:
        if (path / "workspace.config.yaml").is_file():
            return path
    return Path.cwd()


WORK_ROOT = _find_workspace_root()
HOME = Path.home()
SKILL_DIRS = [
    HOME / ".claude" / "skills",
    WORK_ROOT / "_sys" / "skills" / "skills",
]

FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)


# ── Existing skill catalog (for novelty comparison) ───────────────────

def _parse_frontmatter(text: str) -> dict:
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}
    out: dict = {}
    key = None
    for line in m.group(1).splitlines():
        if ":" in line and not line.startswith(" "):
            k, _, v = line.partition(":")
            key = k.strip()
            out[key] = v.strip()
        elif key:
            out[key] = (out.get(key, "") + " " + line.strip()).strip()
    return out


_SKILL_TOKEN_RE = re.compile(r"[가-힣A-Za-z0-9_-]{2,}")


def _tokenize(text: str) -> set[str]:
    return {t.lower() for t in _SKILL_TOKEN_RE.findall(text or "")}


def scan_existing_skills() -> list[dict]:
    catalog: list[dict] = []
    seen: set[str] = set()
    for root in SKILL_DIRS:
        if not root.exists():
            continue
        for md in root.rglob("SKILL.md"):
            try:
                fm = _parse_frontmatter(md.read_text(encoding="utf-8"))
            except Exception:
                continue
            name = fm.get("name") or md.parent.name
            if name in seen:
                continue
            seen.add(name)
            bag = _tokenize(fm.get("name", "") + " " + fm.get("description", ""))
            catalog.append({"name": name, "bag": bag, "path": str(md)})
    return catalog


def jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


# ── Candidate extraction ──────────────────────────────────────────────

def _parse_ts(ts: str):
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None


def _kind_of(node_id: str) -> str:
    if "--" in node_id:
        return node_id.split("--", 1)[0]
    return "unknown"


def community_to_candidate(
    cid: int,
    members: list[str],
    G: nx.Graph,
    existing: list[dict],
) -> dict | None:
    prompts = [n for n in members if G.nodes[n].get("type") == "prompt"]
    if len(prompts) < 3:
        return None

    # Timestamps
    timestamps = []
    for pid in prompts:
        ts = _parse_ts(G.nodes[pid].get("timestamp", ""))
        if ts:
            timestamps.append(ts)
    timestamps.sort()
    if len(timestamps) < 2:
        day_span = 1
        unique_days = 1
    else:
        day_span = max(1, (timestamps[-1] - timestamps[0]).days)
        unique_days = len({t.date() for t in timestamps})

    # Trigger candidates: non-prompt members with the highest within-community degree.
    # Dedupe by surface label across kinds so we don't emit "commit" twice.
    trigger_counts: Counter = Counter()
    for p in prompts:
        for neighbor in G.neighbors(p):
            if G.nodes[neighbor].get("type") != "prompt" and neighbor in set(members):
                trigger_counts[neighbor] += 1
    ranked_nodes = [t for t, _ in trigger_counts.most_common(20)]
    triggers: list[str] = []
    trigger_labels_seen: set[str] = set()
    for t in ranked_nodes:
        label = t.split("--", 1)[1] if "--" in t else t
        if label in trigger_labels_seen:
            continue
        trigger_labels_seen.add(label)
        triggers.append(t)
        if len(triggers) >= 8:
            break

    # Label from top action + top object
    actions = [t for t in triggers if _kind_of(t) == "action"]
    objects_ = [t for t in triggers if _kind_of(t) == "object"]
    label_parts = []
    if actions:
        label_parts.append(actions[0].split("--", 1)[1])
    if objects_:
        label_parts.append(objects_[0].split("--", 1)[1])
    if not label_parts:
        # Fallback: most-connected triggers
        label_parts = [t.split("--", 1)[1] for t in triggers[:2] if "--" in t]
    label = "-".join(label_parts) or f"cluster-{cid}"

    gloss = " + ".join([t.split("--", 1)[-1] for t in triggers[:3]])

    # Cohesion: density within community
    sub = G.subgraph(members)
    n = sub.number_of_nodes()
    possible = n * (n - 1) / 2 if n > 1 else 1
    cohesion = sub.number_of_edges() / possible if possible else 0.0

    # Novelty against existing skills
    candidate_bag = {t.split("--", 1)[-1].lower() for t in triggers}
    candidate_bag |= {label.lower()}
    overlaps = [(sk["name"], jaccard(candidate_bag, sk["bag"])) for sk in existing]
    overlaps.sort(key=lambda x: x[1], reverse=True)
    max_sim = overlaps[0][1] if overlaps else 0.0
    novelty = 1.0 - max_sim

    rank = (
        math.log2(max(2, len(prompts)))
        * (unique_days / day_span)
        * max(0.1, cohesion)
        * max(0.1, novelty)
    )

    return {
        "cid": cid,
        "label": label,
        "gloss": gloss,
        "size": len(prompts),
        "day_span": day_span,
        "unique_days": unique_days,
        "cohesion": round(cohesion, 3),
        "novelty": round(novelty, 3),
        "rank": round(rank, 3),
        "triggers": [t.split("--", 1)[-1] for t in triggers],
        "trigger_nodes": triggers,
        "member_prompts": prompts[:10],
        "prompt_count": len(prompts),
        "similar_skills": [{"name": n, "similarity": round(s, 3)} for n, s in overlaps[:3] if s > 0.0],
    }


# ── Report rendering ──────────────────────────────────────────────────

def render_report(
    candidates: list[dict],
    rejected: list[dict],
    result: dict,
    corpus_size: int,
    days: int,
) -> str:
    G: nx.Graph = result["graph"]
    now = datetime.now()
    lines = [
        f"# Skill Candidates — {now.strftime('%Y-%m-%d')}  (graph-based)",
        "",
        f"- generated: {now.strftime('%Y-%m-%d %H:%M')}",
        f"- corpus: {corpus_size} prompts / {days} days",
        f"- graph: {G.number_of_nodes()} nodes, {G.number_of_edges()} edges, {len(result['communities'])} communities",
        "",
    ]

    # God nodes: only vocabulary (drop individual prompt nodes)
    god_raw = result.get("god_nodes", [])
    god = [g for g in god_raw if not g["id"].startswith("p_")][:10]
    if god:
        lines.append("## God nodes (workspace vocabulary)")
        lines.append("")
        for g in god:
            lines.append(f"- `{g['id']}` (degree {g['degree']})")
        lines.append("")

    lines.append("## Candidates")
    lines.append("")
    if not candidates:
        lines.append("_No community met the threshold (size ≥ 3 prompts, novelty ≥ 0.3)._")
        lines.append("")
    for i, c in enumerate(candidates, 1):
        lines.append(f"### {i}. `{c['label']}`  (rank {c['rank']})")
        lines.append("")
        lines.append(f"- size: {c['size']} prompts / {c['unique_days']} unique days / span {c['day_span']}d")
        lines.append(f"- cohesion: {c['cohesion']}  novelty: {c['novelty']}")
        lines.append(f"- gloss: {c['gloss']}")
        lines.append(f"- triggers: {', '.join(c['triggers'])}")
        if c["similar_skills"]:
            sim = ", ".join(f"`{s['name']}`({s['similarity']})" for s in c["similar_skills"])
            lines.append(f"- overlap with existing skills: {sim}")
        lines.append(f"- sample prompts: {', '.join(c['member_prompts'])}")
        lines.append("")

    # Surprising: restrict to vocab↔vocab edges (prompt nodes are by-design endpoints)
    surprising_all = result.get("surprising", [])
    surprising = [
        s for s in surprising_all
        if not s.get("source", "").startswith("p_") and not s.get("target", "").startswith("p_")
    ][:10]
    if surprising:
        lines.append("## Surprising connections (cross-community vocab)")
        lines.append("")
        for s in surprising:
            lines.append(
                f"- `{s['source']}` ↔ `{s['target']}` "
                f"(comm {s['source_community']}→{s['target_community']}, score {s['score']})"
            )
        lines.append("")

    if rejected:
        lines.append("## Rejected")
        lines.append("")
        for r in rejected:
            lines.append(f"- {r['label']} (size={r['size']}, novelty={r['novelty']}, reason={r['reason']})")
        lines.append("")

    lines.append("## Next steps")
    lines.append("")
    lines.append("- 후보를 검토하여 유의미한 것은 `/skillify` 로 수동 스킬화 또는 `_sys/skills/skills/_drafts/` 로 이동")
    lines.append("- 사전 커버리지 부족이 느껴지면 `skill-mine/scripts/skill_miner/vocab/actions.yaml` · `objects.yaml` 보강")
    lines.append("- 기존 스킬과 overlap 이 높으면 신규 생성 대신 해당 스킬의 triggers 를 확장 고려")
    return "\n".join(lines) + "\n"


# ── Orchestration ─────────────────────────────────────────────────────

def analyze(
    graph_path: Path,
    report_path: Path,
    corpus_size: int,
    days: int,
    min_size: int = 3,
    min_novelty: float = 0.3,
) -> dict:
    result = graph_build.load_graph(graph_path)
    G: nx.Graph = result["graph"]
    existing = scan_existing_skills()

    candidates: list[dict] = []
    rejected: list[dict] = []
    for cid, members in result["communities"].items():
        c = community_to_candidate(cid, members, G, existing)
        if c is None:
            rejected.append({
                "label": f"cluster-{cid}",
                "size": sum(1 for m in members if G.nodes[m].get("type") == "prompt"),
                "novelty": 0.0,
                "reason": "size<3",
            })
            continue
        if c["size"] < min_size:
            c["reason"] = "size<min"
            rejected.append(c)
            continue
        if c["novelty"] < min_novelty:
            c["reason"] = "novelty<min"
            rejected.append(c)
            continue
        candidates.append(c)

    candidates.sort(key=lambda x: x["rank"], reverse=True)

    report = render_report(candidates, rejected, result, corpus_size, days)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(report, encoding="utf-8")

    return {
        "candidates": candidates,
        "rejected": rejected,
        "report_path": str(report_path),
    }


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Analyze graph into skill candidates.")
    parser.add_argument("--graph", required=True, help="graph JSON from graph_build")
    parser.add_argument("--out", required=True, help="output markdown report path")
    parser.add_argument("--corpus-size", type=int, default=0)
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--min-size", type=int, default=3)
    parser.add_argument("--min-novelty", type=float, default=0.3)
    args = parser.parse_args(argv)

    summary = analyze(
        Path(args.graph),
        Path(args.out),
        corpus_size=args.corpus_size,
        days=args.days,
        min_size=args.min_size,
        min_novelty=args.min_novelty,
    )
    print(
        f"[analyze] candidates={len(summary['candidates'])} rejected={len(summary['rejected'])} "
        f"-> {summary['report_path']}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

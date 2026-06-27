#!/usr/bin/env python3
"""build-graph.py — Universal knowledge graph builder for any project.

Two modes:
  --mode wiki   Parse markdown wiki-links (vault notes, docs)
  --mode code   AST extraction via Graphify tree-sitter (code repos)
  --mode auto   Detect mode from directory contents

Usage:
    # Vault notes (wiki-link graph)
    python build-graph.py --target <vault.path> --mode wiki

    # Code repo (AST graph)
    python build-graph.py --target ~/dev/hwp-cli --mode code

    # Auto-detect
    python build-graph.py --target /path/to/repo

    # Custom output
    python build-graph.py --target ~/dev/myproject --out-dir ~/dev/myproject/graphify-out
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

import networkx as nx
from networkx.readwrite import json_graph


# ── Constants ──────────────────────────────────────────────────────────

WIKILINK_RE = re.compile(r"\[\[([^\]|]+?)(?:\|[^\]]+?)?\]\]")
FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
CODE_EXTENSIONS = {
    ".py", ".js", ".ts", ".tsx", ".jsx", ".go", ".rs", ".java", ".c", ".cpp",
    ".h", ".hpp", ".cs", ".kt", ".rb", ".php", ".swift", ".lua", ".zig",
    ".ex", ".exs", ".jl", ".scala", ".m", ".ps1", ".vue", ".svelte",
}


# ── Frontmatter parser ────────────────────────────────────────────────

def parse_frontmatter(text: str) -> dict:
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}
    fm = {}
    for line in m.group(1).splitlines():
        line = line.strip()
        if not line or line.startswith("#") or ":" not in line:
            continue
        key, _, val = line.partition(":")
        key, val = key.strip(), val.strip()
        if val and val[0] in ('"', "'") and val[-1] == val[0]:
            val = val[1:-1]
        if val.startswith("[") and val.endswith("]"):
            items = [s.strip().strip('"').strip("'") for s in val[1:-1].split(",") if s.strip()]
            fm[key] = items
        else:
            fm[key] = val
    return fm


def extract_body(text: str) -> str:
    m = FRONTMATTER_RE.match(text)
    return text[m.end():] if m else text


# ── Mode detection ─────────────────────────────────────────────────────

def detect_mode(target: Path) -> str:
    notes_dir = target / "notes"
    if notes_dir.is_dir() and any(notes_dir.glob("*.md")):
        md_count = len(list(notes_dir.glob("*.md")))
        if md_count > 10:
            return "wiki"

    code_count = sum(1 for f in target.rglob("*") if f.suffix in CODE_EXTENSIONS and f.is_file())
    md_count = sum(1 for f in target.rglob("*.md") if f.is_file())

    if code_count > md_count:
        return "code"
    return "wiki"


# ── Wiki-link extraction (for vault/docs) ─────────────────────────────

def extract_wiki(target: Path) -> list[dict]:
    notes_dir = target / "notes" if (target / "notes").is_dir() else target
    md_files = sorted(notes_dir.glob("*.md"))

    if not md_files:
        print(f"  No .md files in {notes_dir}", file=sys.stderr)
        return [{"nodes": [], "edges": []}]

    all_filenames = {f.stem for f in md_files}
    nodes, edges = [], []

    for f in md_files:
        text = f.read_text(encoding="utf-8", errors="replace")
        fm = parse_frontmatter(text)
        body = extract_body(text)
        links = WIKILINK_RE.findall(body)

        node = {
            "id": f.stem,
            "label": f.stem.replace("-", " ").title(),
            "type": fm.get("type", "unknown"),
            "domain": fm.get("domain", "unknown"),
            "description": fm.get("description", ""),
            "confidence": fm.get("confidence", ""),
            "source_file": str(f.relative_to(target)),
        }
        topics = fm.get("topics", [])
        if isinstance(topics, list):
            topics = [t.replace("[[", "").replace("]]", "") for t in topics]
            node["topics"] = ", ".join(topics)
        else:
            node["topics"] = str(topics)
        nodes.append(node)

        for link in links:
            link_target = link.strip().lower().replace(" ", "-")
            if link_target in all_filenames:
                edges.append({
                    "source": f.stem,
                    "target": link_target,
                    "relation": "wiki_link",
                    "confidence_tag": "EXTRACTED",
                    "confidence": 1.0,
                })

    return [{"nodes": nodes, "edges": edges}]


# ── Code extraction (AST via Graphify) ─────────────────────────────────

def extract_code(target: Path) -> list[dict]:
    try:
        from graphify.extract import collect_files, extract
    except ImportError:
        print("ERROR: graphify not installed. Run: uv pip install graphifyy", file=sys.stderr)
        sys.exit(1)

    files = collect_files(target, follow_symlinks=False)
    print(f"  Collected {len(files)} files")

    if not files:
        return [{"nodes": [], "edges": []}]

    result = extract(files)
    nodes = result.get("nodes", [])
    edges = result.get("edges", [])
    print(f"  Extracted {len(nodes)} nodes, {len(edges)} edges")
    return [result]


# ── Graph build ────────────────────────────────────────────────────────

def build_graph(extractions: list[dict]) -> nx.Graph:
    G = nx.Graph()
    for ext in extractions:
        for node in ext.get("nodes", []):
            nid = node.get("id", "")
            G.add_node(nid, **{k: v for k, v in node.items() if k != "id"})
        for edge in ext.get("edges", []):
            src, tgt = edge.get("source", ""), edge.get("target", "")
            G.add_edge(src, tgt, **{k: v for k, v in edge.items() if k not in ("source", "target")})
    return G


# ── Community detection ────────────────────────────────────────────────

def get_hub_nodes(G: nx.Graph) -> set[str]:
    """Identify structural hub nodes to exclude from clustering."""
    return {n for n, d in G.nodes(data=True) if d.get("type") == "moc"}


def detect_communities(G: nx.Graph, exclude_hubs: bool = True) -> dict[int, list[str]]:
    hubs = get_hub_nodes(G) if exclude_hubs else set()
    H = G.subgraph([n for n in G.nodes if n not in hubs]).copy()

    if H.number_of_nodes() == 0:
        return {}

    try:
        from graspologic.partition import leiden
        node_list = list(H.nodes)
        partition = leiden(nx.to_numpy_array(H, nodelist=node_list), seed=42)
        comms: dict[int, list[str]] = {}
        for idx, cid in enumerate(partition):
            comms.setdefault(int(cid), []).append(node_list[idx])
        return comms
    except (ImportError, Exception):
        pass

    try:
        communities_gen = nx.community.louvain_communities(H, seed=42)
        return {i: list(c) for i, c in enumerate(communities_gen)}
    except Exception:
        return {i: list(c) for i, c in enumerate(nx.connected_components(H))}


# ── Analysis ───────────────────────────────────────────────────────────

def find_god_nodes(G: nx.Graph, top_n: int = 10) -> list[dict]:
    hub_types = {"moc", "file"}
    candidates = [
        (n, d) for n, d in G.degree()
        if G.nodes[n].get("type", "") not in hub_types
    ]
    candidates.sort(key=lambda x: x[1], reverse=True)
    return [{"id": n, "degree": d, "label": G.nodes[n].get("label", n)} for n, d in candidates[:top_n]]


def find_surprising_connections(G: nx.Graph, communities: dict[int, list[str]], top_n: int = 15) -> list[dict]:
    hubs = get_hub_nodes(G)
    node_to_comm = {}
    for cid, members in communities.items():
        for m in members:
            node_to_comm[m] = cid

    cross_edges = []
    for u, v, data in G.edges(data=True):
        if u in hubs or v in hubs:
            continue
        cu, cv = node_to_comm.get(u, -1), node_to_comm.get(v, -1)
        if cu != cv and cu >= 0 and cv >= 0:
            cross_edges.append({
                "source": u, "target": v,
                "source_community": cu, "target_community": cv,
                "source_type": G.nodes[u].get("type", "?"),
                "target_type": G.nodes[v].get("type", "?"),
                "relation": data.get("relation", ""),
            })

    for e in cross_edges:
        e["score"] = G.degree(e["source"]) + G.degree(e["target"])
    cross_edges.sort(key=lambda x: x["score"], reverse=True)
    return cross_edges[:top_n]


def compute_community_stats(G: nx.Graph, communities: dict[int, list[str]]) -> list[dict]:
    stats = []
    for cid, members in sorted(communities.items()):
        sub = G.subgraph(members)
        types = {}
        for m in members:
            t = G.nodes[m].get("type", G.nodes[m].get("domain", "unknown"))
            types[t] = types.get(t, 0) + 1
        primary = max(types, key=types.get) if types else "unknown"
        stats.append({
            "id": cid, "size": len(members), "edges": sub.number_of_edges(),
            "primary_type": primary, "type_mix": types,
            "members_sample": members[:5],
        })
    return stats


# ── Report generation ──────────────────────────────────────────────────

def generate_report(
    G: nx.Graph, communities: dict, god_nodes: list, surprises: list,
    comm_stats: list, target: Path, mode: str,
) -> str:
    today = datetime.now().strftime("%Y-%m-%d")
    project_name = target.name
    hubs = get_hub_nodes(G)
    lines = [
        f"# Graph Report: {project_name} ({today})",
        f"",
        f"## Overview",
        f"",
        f"- **Target**: `{target}`",
        f"- **Mode**: {mode}",
        f"- **Nodes**: {G.number_of_nodes()}" + (f" ({len(hubs)} hubs excluded from clustering)" if hubs else ""),
        f"- **Edges**: {G.number_of_edges()}",
        f"- **Communities**: {len(communities)}",
        f"- **Isolates**: {nx.number_of_isolates(G)}",
        f"- **Connected components**: {nx.number_connected_components(G)}",
        f"- **Density**: {nx.density(G):.4f}",
        "",
    ]

    lines.append("## God Nodes (Top Connected)")
    lines.append("")
    lines.append("| Rank | Node | Degree |")
    lines.append("|------|------|--------|")
    for i, gn in enumerate(god_nodes, 1):
        lines.append(f"| {i} | `{gn['id']}` | {gn['degree']} |")
    lines.append("")

    lines.append("## Communities")
    lines.append("")
    for cs in comm_stats:
        if cs["size"] == 1:
            continue
        sample = ", ".join(f"`{m}`" for m in cs["members_sample"])
        mix = ", ".join(f"{t}({c})" for t, c in sorted(cs["type_mix"].items(), key=lambda x: -x[1]))
        lines.append(f"### Community {cs['id']} ({cs['size']} nodes, primary: {cs['primary_type']})")
        lines.append(f"- Type mix: {mix}")
        lines.append(f"- Internal edges: {cs['edges']}")
        lines.append(f"- Sample: {sample}")
        lines.append("")

    singletons = [cs for cs in comm_stats if cs["size"] == 1]
    if singletons:
        lines.append(f"*{len(singletons)} singleton communities omitted.*")
        lines.append("")

    lines.append("## Surprising Connections (Cross-Community)")
    lines.append("")
    if surprises:
        lines.append("| Source | Target | Score |")
        lines.append("|--------|--------|-------|")
        for s in surprises:
            lines.append(f"| `{s['source']}` | `{s['target']}` | {s['score']} |")
    else:
        lines.append("*No cross-community edges found.*")
    lines.append("")

    return "\n".join(lines)


# ── Export ─────────────────────────────────────────────────────────────

def export_graph_json(G: nx.Graph, out_path: Path):
    data = json_graph.node_link_data(G)
    out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def export_report(report: str, out_path: Path):
    out_path.write_text(report, encoding="utf-8")


# ── Main ───────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Build knowledge graph for any project")
    parser.add_argument("--target", type=Path, required=True, help="Target directory")
    parser.add_argument("--mode", choices=["auto", "wiki", "code"], default="auto", help="Extraction mode")
    parser.add_argument("--out-dir", type=Path, default=None, help="Output directory (default: target/graphify-out or vault/reports)")
    parser.add_argument("--no-hubs", action="store_true", help="Exclude hub nodes from clustering")
    args = parser.parse_args()

    target = args.target.expanduser().resolve()
    if not target.is_dir():
        print(f"ERROR: {target} is not a directory", file=sys.stderr)
        sys.exit(1)

    # Detect mode
    mode = args.mode
    if mode == "auto":
        mode = detect_mode(target)
        print(f"Auto-detected mode: {mode}")

    # Determine output directory
    if args.out_dir:
        out_dir = args.out_dir.expanduser().resolve()
    elif mode == "wiki" and (target / "reports").is_dir():
        out_dir = target / "reports"
    else:
        out_dir = target / "graphify-out"
    out_dir.mkdir(parents=True, exist_ok=True)

    # Extract
    print(f"Building graph for {target} (mode: {mode}) ...")
    if mode == "wiki":
        extractions = extract_wiki(target)
    else:
        extractions = extract_code(target)

    node_count = sum(len(e.get("nodes", [])) for e in extractions)
    edge_count = sum(len(e.get("edges", [])) for e in extractions)
    print(f"  {node_count} nodes, {edge_count} edges")

    if node_count == 0:
        print("  No nodes extracted. Exiting.")
        sys.exit(0)

    # Build
    print("Building graph ...")
    G = build_graph(extractions)

    # Cluster
    print("Detecting communities ...")
    exclude_hubs = args.no_hubs or mode == "wiki"
    communities = detect_communities(G, exclude_hubs=exclude_hubs)
    print(f"  {len(communities)} communities detected")

    for cid, members in communities.items():
        for m in members:
            if m in G.nodes:
                G.nodes[m]["community"] = cid

    # Analyze
    print("Analyzing ...")
    gn = find_god_nodes(G)
    surprises = find_surprising_connections(G, communities)
    comm_stats = compute_community_stats(G, communities)

    # Report
    print("Generating report ...")
    report = generate_report(G, communities, gn, surprises, comm_stats, target, mode)

    # Export
    today = datetime.now().strftime("%y%m%d")
    project_name = target.name
    graph_path = out_dir / "graph.json"
    report_path = out_dir / f"graph-report-{today}.md"

    # For vault backwards compat
    if mode == "wiki" and out_dir.name == "reports":
        graph_path = out_dir / "vault-graph.json"
        report_path = out_dir / f"graph-report-{today}.md"

    export_graph_json(G, graph_path)
    export_report(report, report_path)

    print(f"\nOutputs:")
    print(f"  Graph: {graph_path}")
    print(f"  Report: {report_path}")
    print(f"\nSummary:")
    print(f"  Nodes: {G.number_of_nodes()}")
    print(f"  Edges: {G.number_of_edges()}")
    print(f"  Communities: {len(communities)}")
    if gn:
        print(f"  God nodes: {', '.join(g['id'] for g in gn[:5])}")
    print(f"  Cross-community edges: {len(surprises)}")

    # Print MCP server hint
    print(f"\nTo serve as MCP:")
    print(f"  python -c \"from graphify.serve import serve; serve('{graph_path}')\"")


if __name__ == "__main__":
    main()

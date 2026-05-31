"""Build a NetworkX graph from the materialized virtual wiki-vault.

Reuses primitives from ~/.anchor/skills/_builtin/lib/build-graph.py so vault graph and
skill mining stay on the same graph pipeline.
"""
from __future__ import annotations
import importlib.util
import json
import sys
from pathlib import Path

import networkx as nx
from networkx.readwrite import json_graph


def _find_workspace_root() -> Path:
    for path in Path(__file__).resolve().parents:
        if (path / "workspace.config.yaml").is_file():
            return path
    raise RuntimeError("Cannot find workspace.config.yaml from skill-mine location")


WORK_ROOT = _find_workspace_root()
BUILD_GRAPH_PATH = WORK_ROOT / "_sys" / "skills" / "lib" / "build-graph.py"


def _load_build_graph_module():
    spec = importlib.util.spec_from_file_location("build_graph", BUILD_GRAPH_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load build-graph.py from {BUILD_GRAPH_PATH}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


BG = _load_build_graph_module()


def _enrich_prompt_timestamps(virtual_vault: Path, G: nx.Graph) -> None:
    """Backfill `timestamp`/`session` on prompt nodes.

    build-graph.py's extract_wiki() only propagates a whitelist of frontmatter
    fields — timestamp is dropped. We re-read the prompt note frontmatter here
    so analyze.py can compute unique_days / day_span accurately.
    """
    notes_dir = Path(virtual_vault) / "notes"
    if not notes_dir.is_dir():
        return
    for nid in list(G.nodes):
        if not str(nid).startswith("p_"):
            continue
        note = notes_dir / f"{nid}.md"
        if not note.exists():
            continue
        try:
            fm = BG.parse_frontmatter(note.read_text(encoding="utf-8"))
        except OSError:
            continue
        ts = fm.get("timestamp")
        if ts:
            G.nodes[nid]["timestamp"] = ts
        sess = fm.get("session")
        if sess:
            G.nodes[nid]["session"] = sess


def build_prompt_graph(virtual_vault: Path) -> dict:
    extractions = BG.extract_wiki(Path(virtual_vault))
    G: nx.Graph = BG.build_graph(extractions)
    _enrich_prompt_timestamps(Path(virtual_vault), G)
    communities: dict[int, list[str]] = BG.detect_communities(G, exclude_hubs=False)
    god_nodes = BG.find_god_nodes(G, top_n=20)
    surprising = BG.find_surprising_connections(G, communities, top_n=15)
    stats = BG.compute_community_stats(G, communities)
    return {
        "graph": G,
        "communities": communities,
        "god_nodes": god_nodes,
        "surprising": surprising,
        "stats": stats,
    }


def write_graph(result: dict, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    G: nx.Graph = result["graph"]
    data = json_graph.node_link_data(G)
    payload = {
        "graph": data,
        "communities": {str(k): v for k, v in result["communities"].items()},
        "god_nodes": result["god_nodes"],
        "surprising": result["surprising"],
        "stats": result["stats"],
    }
    out_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")


def load_graph(path: Path) -> dict:
    payload = json.loads(path.read_text(encoding="utf-8"))
    G = json_graph.node_link_graph(payload["graph"])
    communities = {int(k): v for k, v in payload.get("communities", {}).items()}
    return {
        "graph": G,
        "communities": communities,
        "god_nodes": payload.get("god_nodes", []),
        "surprising": payload.get("surprising", []),
        "stats": payload.get("stats", []),
    }


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Build a NetworkX graph from a virtual wiki-vault.")
    parser.add_argument("--in", dest="inp", required=True, help="virtual-vault root dir")
    parser.add_argument("--out", required=True, help="output graph JSON")
    args = parser.parse_args(argv)

    result = build_prompt_graph(Path(args.inp))
    write_graph(result, Path(args.out))
    G = result["graph"]
    print(
        f"[graph] nodes={G.number_of_nodes()} edges={G.number_of_edges()} "
        f"communities={len(result['communities'])} god_nodes={len(result['god_nodes'])} "
        f"surprising={len(result['surprising'])} -> {args.out}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())

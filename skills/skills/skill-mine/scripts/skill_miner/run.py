"""Orchestrator for the skill-miner pipeline (graph-based, LLM-free)."""
from __future__ import annotations
import argparse
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import extract
import materialize
import graph_build
import analyze

def _find_workspace_root() -> Path:
    for path in Path(__file__).resolve().parents:
        if (path / "workspace.config.yaml").is_file():
            return path
    return Path.cwd()


ROOT = _find_workspace_root()
REPORTS = ROOT / "_sys" / "reports"
CACHE = REPORTS / ".cache"
DEFAULT_PROJECT_DIR = Path.home() / ".claude" / "projects"
REGISTRY = ROOT / "project-registry.yaml"


def today() -> str:
    return datetime.now().strftime("%y%m%d")


def stage_extract(args) -> Path:
    since = datetime.now(timezone.utc) - timedelta(days=args.days)
    recs = extract.extract_prompts(Path(args.project_dir), since=since)
    out = CACHE / f"prompts-{today()}.jsonl"
    extract.write_cache(recs, out)
    print(f"[extract] {len(recs)} prompts (since {since.date()}) -> {out}")
    return out


def stage_materialize(args, prompts_path: Path) -> Path:
    prompts = extract.load_cache(prompts_path)
    out = CACHE / f"virtual-vault-{today()}"
    stats = materialize.materialize(prompts, out, Path(args.registry))
    print(
        f"[materialize] {stats['prompts']} prompts, {stats['matched_prompts']} matched, "
        f"{stats['total_hits']} hits, {stats['stub_notes']} stubs -> {out}"
    )
    return out


def stage_graph(vault_dir: Path) -> Path:
    result = graph_build.build_prompt_graph(vault_dir)
    out = CACHE / f"prompts-graph-{today()}.json"
    graph_build.write_graph(result, out)
    G = result["graph"]
    print(
        f"[graph] nodes={G.number_of_nodes()} edges={G.number_of_edges()} "
        f"communities={len(result['communities'])} god_nodes={len(result['god_nodes'])} "
        f"surprising={len(result['surprising'])} -> {out}"
    )
    return out


def stage_analyze(graph_path: Path, prompts_path: Path, args) -> Path:
    corpus_size = sum(
        1 for line in prompts_path.read_text(encoding="utf-8").splitlines() if line.strip()
    )
    out = REPORTS / f"skill-candidates-{today()}.md"
    summary = analyze.analyze(
        graph_path,
        out,
        corpus_size=corpus_size,
        days=args.days,
        min_size=args.min_size,
        min_novelty=args.min_novelty,
    )
    print(f"[analyze] candidates={len(summary['candidates'])} rejected={len(summary['rejected'])} -> {out}")
    return out


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Skill Miner (graph-based, LLM-free)")
    parser.add_argument("--project-dir", default=str(DEFAULT_PROJECT_DIR))
    parser.add_argument("--registry", default=str(REGISTRY))
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument(
        "--stage",
        choices=["extract", "materialize", "graph", "analyze", "all"],
        default="all",
    )
    parser.add_argument("--from-cache", action="store_true", help="Reuse today's cached artifacts")
    parser.add_argument("--min-size", type=int, default=3, help="Minimum prompts per candidate")
    parser.add_argument("--min-novelty", type=float, default=0.3, help="Minimum novelty (0~1)")
    args = parser.parse_args(argv)

    CACHE.mkdir(parents=True, exist_ok=True)
    REPORTS.mkdir(parents=True, exist_ok=True)

    prompts_path = CACHE / f"prompts-{today()}.jsonl"
    vault_dir = CACHE / f"virtual-vault-{today()}"
    graph_path = CACHE / f"prompts-graph-{today()}.json"

    # Extract
    if args.stage in ("extract", "all"):
        prompts_path = stage_extract(args)
    elif not prompts_path.exists():
        raise SystemExit(f"[run] expected cached {prompts_path}")
    if args.stage == "extract":
        return 0

    # Materialize
    if args.stage in ("materialize", "all"):
        if args.from_cache and vault_dir.exists():
            print(f"[materialize] reusing cache {vault_dir}")
        else:
            vault_dir = stage_materialize(args, prompts_path)
    elif not vault_dir.exists():
        raise SystemExit(f"[run] expected cached {vault_dir}")
    if args.stage == "materialize":
        return 0

    # Graph build
    if args.stage in ("graph", "all"):
        if args.from_cache and graph_path.exists():
            print(f"[graph] reusing cache {graph_path}")
        else:
            graph_path = stage_graph(vault_dir)
    elif not graph_path.exists():
        raise SystemExit(f"[run] expected cached {graph_path}")
    if args.stage == "graph":
        return 0

    # Analyze
    stage_analyze(graph_path, prompts_path, args)
    return 0


if __name__ == "__main__":
    sys.exit(main())

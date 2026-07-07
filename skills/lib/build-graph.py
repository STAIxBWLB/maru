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
import unicodedata
from datetime import date, datetime
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

# ── Workspace (--work-root) constants — DR-023 ─────────────────────────
# Keep aligned with migrate_tree.py SKIP_DIRS (work repo, _meta/scripts/).
# Cross-repo import is impossible (this file ships in the anchor app bundle),
# so the set is replicated literally. If migrate_tree.py SKIP_DIRS changes,
# update this too. Additions beyond that set (DR-023 §2): inbox/sites/dev
# (submodules + runtime), shared (share-outbox staging), _templates/templates
# (scaffold dirs). Files whose frontmatter contains "{{" are template stubs
# and are skipped separately (avoids minting bu:{{bu}} hubs).
WORK_SKIP_DIRS = {
    ".git", "node_modules", ".venv", ".sync-conflicts", "temp", ".anchor",
    ".pnpm-store", ".conductor", ".dotfiles", ".omx", ".omc", ".gstack",
    ".frontend-slides", ".claude", ".archive", "archive", "vault",
    "inbox", "sites", "dev", "shared", "_templates", "templates",
}
# Wiki-link-bearing frontmatter fields on work docs → fm_ref edges to vault
# stems (DR-019 §2 node-adoption criterion ② / edge type fm_ref).
WORK_WIKI_FIELDS = (
    "projects", "project", "vault_note", "topics",
    "attendees", "relatedMeetings", "relatedTasks",
)
BU_SLUG_RE = re.compile(r"[a-z0-9][a-z0-9-]*$")
# Edge precedence for the simple undirected workspace graph (DR-023 §5).
# Higher index wins when two relations land on the same node pair.
EDGE_PRIORITY = {
    "wiki_link": 0, "fm_ref": 1, "bu_member": 2,
    "source_ref": 3, "related": 4, "supersedes": 5,
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


# ── Workspace (work-layer) extraction — DR-019 §2 / DR-023 ────────────
#
# Adds a second operational layer on top of the vault wiki graph:
#   nodes  work:<relpath-noext>  (qualifying work docs)
#          bu:<slug>             (business-unit hubs)
#          work:<relpath-noext>  type=file  (source_ref stub targets)
#   edges  wiki_link  work body [[..]] → vault stem
#          source_ref vault note source: → work doc / stub
#          related    work → work (related[] frontmatter)
#          fm_ref     work wiki-link field → vault stem (field attr)
#          bu_member  work → bu:<slug>
#          supersedes vault decision note supersedes/superseded_by
# The vault layer (extract_wiki) is untouched; this only *adds*.

def _nfc(s: str) -> str:
    return unicodedata.normalize("NFC", s)


def _node_label(rel: str) -> str:
    """Human label from a relpath. Generic stems (readme/index) are qualified
    with the parent dir so 33 README docs don't all collapse to 'Readme'."""
    p = Path(rel)
    stem = _nfc(p.stem)
    if stem.lower() in ("readme", "index") and p.parent.name:
        stem = f"{p.parent.name}-{stem}"
    return stem.replace("-", " ").title()


def _coerce(v):
    """Scalar-coerce a frontmatter value for JSON export (dates → str)."""
    if isinstance(v, (date, datetime)):
        return v.isoformat()
    if isinstance(v, (list, dict)):
        return str(v)
    return v if isinstance(v, (str, int, float, bool)) or v is None else str(v)


def _safe_load_fm(text: str) -> dict:
    m = FRONTMATTER_RE.match(text)
    if not m:
        return {}
    try:
        import yaml
        data = yaml.safe_load(m.group(1))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _wikilinks_in(value) -> list[str]:
    """Resolve wiki-link targets in a frontmatter value to vault-stem keys."""
    return [
        _nfc(t.strip()).lower().replace(" ", "-")
        for t in WIKILINK_RE.findall(str(value))
    ]


def _resolve_related(entry, doc_rel: str, work_root: Path, stem_index: dict,
                     work_ids: set, counters: dict):
    """Resolve one related[] entry → target work node id or None (DR-023 §3)."""
    rel = None
    if isinstance(entry, dict):
        rel = entry.get("rel")
        entry = entry.get("doc", "")
    s = str(entry).strip()
    if not s:
        return None, rel
    # strip trailing Korean/annotation parenthetical: "... (상위 결정)"
    s = re.sub(r"\s*\([^)]*\)\s*$", "", s).strip()
    wl = WIKILINK_RE.findall(s)
    if wl:
        key = _nfc(wl[0].strip()).lower().replace(" ", "-")
        targets = stem_index.get(key)
        if not targets:
            counters["related_unresolved"] += 1
            return None, rel
        if len(targets) > 1:
            counters["related_ambiguous"] += 1
            return None, rel
        return targets[0], rel
    # path form
    if s.startswith("~"):
        counters["related_home_escape"] += 1
        return None, rel
    doc_dir = os.path.dirname(doc_rel)
    joined = os.path.normpath(os.path.join(doc_dir, s))
    if joined.startswith(".."):
        counters["related_root_escape"] += 1
        return None, rel
    if s.endswith("/") or not joined.endswith(".md"):
        counters["related_dir_skip"] += 1
        return None, rel
    node_id = "work:" + joined[:-3]
    if node_id in work_ids:
        return node_id, rel
    counters["related_unresolved"] += 1
    return None, rel


_CFG_SKIP = {".git", "node_modules", ".venv", ".sync-conflicts", "archive",
             ".archive", "vault", "temp"}


def _load_bu_slugs(work_root: Path) -> set:
    """Valid bu_id slugs from bu-config.yaml files (DR-023 §7).

    bu-config.yaml lives under `.anchor/` (or 00-readme/), so the full
    WORK_SKIP_DIRS (which skips `.anchor`) is NOT applied here — only truly
    irrelevant trees are pruned.
    """
    slugs = set()
    try:
        import yaml
    except Exception:
        return slugs
    for cfg in work_root.rglob("bu-config.yaml"):
        if any(part in _CFG_SKIP for part in cfg.relative_to(work_root).parts):
            continue
        try:
            data = yaml.safe_load(cfg.read_text(encoding="utf-8"))
        except Exception:
            continue
        if isinstance(data, dict):
            bid = str(data.get("bu_id", "")).replace("[[", "").replace("]]", "").strip()
            if BU_SLUG_RE.fullmatch(bid):
                slugs.add(bid)
    return slugs


def extract_work(work_root: Path, vault_target: Path, vault_stems: set) -> list[dict]:
    work_root = work_root.expanduser().resolve()
    counters = {
        "work_docs": 0, "yaml_fail": 0, "template_skip": 0,
        "related_unresolved": 0, "related_ambiguous": 0, "related_dir_skip": 0,
        "related_root_escape": 0, "related_home_escape": 0,
        "source_stub": 0, "source_dead": 0, "source_nonmd": 0,
        "source_skiproot": 0, "collisions": 0, "dup_edges": 0,
    }
    valid_bu = _load_bu_slugs(work_root)

    # Pass 1 — collect qualifying work docs (nodes + stem index).
    docs = {}          # node_id -> {rel, fm, body}
    stem_index = {}    # basename-stem -> [node_id, ...]
    for dirpath, dirnames, filenames in os.walk(work_root):
        dirnames[:] = [d for d in dirnames if d not in WORK_SKIP_DIRS]
        for fn in filenames:
            if not fn.endswith(".md"):
                continue
            fp = Path(dirpath) / fn
            rel = _nfc(str(fp.relative_to(work_root)))
            text = fp.read_text(encoding="utf-8", errors="replace")
            m = FRONTMATTER_RE.match(text)
            if not m:
                continue
            raw_fm = m.group(1)
            if "{{" in raw_fm:                      # template stub — DR-023 §2
                counters["template_skip"] += 1
                continue
            fm = _safe_load_fm(text)
            if not fm:
                if raw_fm.strip():
                    counters["yaml_fail"] += 1
                continue
            has_dt = bool(fm.get("document_type"))
            has_wl = any(fm.get(f) for f in WORK_WIKI_FIELDS) or bool(fm.get("related"))
            if not (has_dt or has_wl):
                continue
            node_id = "work:" + rel[:-3]
            docs[node_id] = {"rel": rel, "fm": fm, "body": extract_body(text)}
            # key matches _resolve_related's wikilink lookup (space→dash)
            stem_index.setdefault(_nfc(fp.stem).lower().replace(" ", "-"), []).append(node_id)
            counters["work_docs"] += 1

    work_ids = set(docs)
    nodes, edges = [], []

    # bu hubs — business_unit values that are known bu_ids (DR-023 §7)
    used_bu = set()
    for node_id, d in docs.items():
        bu = str(d["fm"].get("business_unit", "")).replace("[[", "").replace("]]", "").strip()
        if bu and bu in valid_bu:
            used_bu.add(bu)
    for slug in sorted(used_bu):
        nodes.append({"id": "bu:" + slug, "type": "bu", "domain": "bu",
                      "label": slug, "source_file": ""})
    bu_ids = {"bu:" + s for s in used_bu}

    # work doc nodes
    for node_id, d in docs.items():
        fm = d["fm"]
        nodes.append({
            "id": node_id,
            "label": _node_label(d["rel"]),
            "type": str(_coerce(fm.get("document_type") or "work-doc")),
            "domain": d["rel"].split("/", 1)[0],
            "description": str(_coerce(fm.get("title") or fm.get("description") or ""))[:200],
            "source_file": d["rel"],
        })

    known = set(vault_stems) | work_ids | bu_ids   # stubs added below

    # Pass 2 — work-doc edges (related / fm_ref / wiki_link / bu_member).
    cand = []   # (relation, src, tgt, attrs)
    for node_id, d in docs.items():
        fm, rel = d["fm"], d["rel"]
        related = fm.get("related")
        if related is not None:
            entries = related if isinstance(related, list) else [related]
            for e in entries:
                tgt, rtype = _resolve_related(e, rel, work_root, stem_index, work_ids, counters)
                if tgt:
                    attrs = {"rel": str(_coerce(rtype))} if rtype else {}
                    cand.append(("related", node_id, tgt, attrs))
        for field in WORK_WIKI_FIELDS:
            if field not in fm:
                continue
            for key in _wikilinks_in(fm[field]):
                if key in vault_stems:
                    cand.append(("fm_ref", node_id, key, {"field": field}))
        for key in [_nfc(l.strip()).lower().replace(" ", "-") for l in WIKILINK_RE.findall(d["body"])]:
            if key in vault_stems:
                cand.append(("wiki_link", node_id, key, {}))
        bu = str(fm.get("business_unit", "")).replace("[[", "").replace("]]", "").strip()
        if "bu:" + bu in bu_ids:
            cand.append(("bu_member", node_id, "bu:" + bu, {}))

    # Pass 3 — vault notes: source_ref (+ stub nodes) and supersedes.
    notes_dir = vault_target / "notes" if (vault_target / "notes").is_dir() else vault_target
    stub_nodes = {}
    for f in sorted(notes_dir.glob("*.md")):
        fm = _safe_load_fm(f.read_text(encoding="utf-8", errors="replace"))
        if not fm:
            continue
        src = fm.get("source")
        if isinstance(src, str) and src.strip():
            raw = src.strip().strip('"').strip("'")
            if raw and not raw.startswith(("http://", "https://")):
                if raw.startswith("work/"):
                    raw = raw[len("work/"):]
                raw = _nfc(raw)
                ext = os.path.splitext(raw)[1]
                if raw.endswith("/") or (ext and ext != ".md"):
                    counters["source_nonmd"] += 1        # directory or non-.md target — unresolvable by design
                else:
                    norm = raw[:-3] if raw.endswith(".md") else raw
                    tgt = "work:" + norm
                    if tgt in work_ids:
                        cand.append(("source_ref", f.stem, tgt, {}))
                    elif set(Path(norm).parts) & WORK_SKIP_DIRS:
                        counters["source_skiproot"] += 1  # C1: source into an excluded tree (sites/inbox/archive…)
                    elif (work_root / (norm + ".md")).is_file():
                        if tgt not in stub_nodes:
                            stub_nodes[tgt] = {"id": tgt, "type": "file",
                                               "label": _node_label(norm + ".md"),
                                               "domain": norm.split("/", 1)[0], "source_file": norm + ".md"}
                            counters["source_stub"] += 1
                        cand.append(("source_ref", f.stem, tgt, {}))
                    elif (work_root / norm).is_dir():
                        counters["source_nonmd"] += 1     # extension-less directory
                    else:
                        counters["source_dead"] += 1
        for field in ("supersedes", "superseded_by"):
            val = fm.get(field)
            if val:
                for key in _wikilinks_in(val):
                    if key in vault_stems:
                        cand.append(("supersedes", f.stem, key, {"field": field}))

    nodes.extend(stub_nodes.values())
    known |= set(stub_nodes)

    # Edge assembly — ghost-node filter + precedence dedupe (DR-023 §5).
    best = {}   # frozenset(pair) -> (priority, relation, src, tgt, attrs)
    for relation, src, tgt, attrs in cand:
        if src not in known or tgt not in known or src == tgt:
            continue
        pair = frozenset((src, tgt))
        prio = EDGE_PRIORITY.get(relation, 0)
        cur = best.get(pair)
        if cur is None:
            best[pair] = (prio, relation, src, tgt, attrs)
        else:
            # C3: distinguish cross-relation precedence overrides from plain duplicates
            if relation != cur[1]:
                counters["collisions"] += 1
            else:
                counters["dup_edges"] += 1
            if prio > cur[0]:
                best[pair] = (prio, relation, src, tgt, attrs)
    for prio, relation, src, tgt, attrs in best.values():
        edges.append({"source": src, "target": tgt, "relation": relation,
                      "confidence_tag": "EXTRACTED", "confidence": 1.0, **attrs})

    extract_work.counters = counters
    print(f"  work: {counters['work_docs']} docs, {len(used_bu)} bu hubs, "
          f"{counters['source_stub']} stubs, {len(edges)} edges", file=sys.stderr)
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
    """Identify structural hub nodes to exclude from clustering.

    `bu` added for the workspace layer (DR-023 §8) — vault-only graphs have no
    type=bu nodes, so vault runs are unaffected (byte-stable).
    """
    return {n for n, d in G.nodes(data=True) if d.get("type") in ("moc", "bu")}


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
    hub_types = {"moc", "file", "bu"}
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
    parser.add_argument("--work-root", type=Path, default=None,
                        help="Add work operational layer → workspace-graph.json (DR-019 §2). "
                             "--target stays the vault; report write is suppressed.")
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
        if args.work_root:
            vault_stems = {n["id"] for e in extractions for n in e.get("nodes", [])}
            extractions = extractions + extract_work(args.work_root, target, vault_stems)
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
    if args.work_root:
        # DR-023 §6: workspace layer writes ONLY workspace-graph.json and
        # suppresses the report (else it clobbers today's vault graph-report).
        graph_path = out_dir / "workspace-graph.json"
        report_path = None
    elif mode == "wiki" and out_dir.name == "reports":
        graph_path = out_dir / "vault-graph.json"       # vault backwards compat
        report_path = out_dir / f"graph-report-{today}.md"
    else:
        graph_path = out_dir / "graph.json"
        report_path = out_dir / f"graph-report-{today}.md"

    export_graph_json(G, graph_path)
    if report_path is not None:
        export_report(report, report_path)

    print(f"\nOutputs:")
    print(f"  Graph: {graph_path}")
    print(f"  Report: {report_path if report_path else '(suppressed — workspace layer)'}")
    print(f"\nSummary:")
    print(f"  Nodes: {G.number_of_nodes()}")
    print(f"  Edges: {G.number_of_edges()}")
    print(f"  Communities: {len(communities)}")
    if gn:
        print(f"  God nodes: {', '.join(g['id'] for g in gn[:5])}")
    print(f"  Cross-community edges: {len(surprises)}")
    if args.work_root:
        rels = {}
        for _, _, d in G.edges(data=True):
            rels[d.get("relation", "?")] = rels.get(d.get("relation", "?"), 0) + 1
        print(f"  Edge relations: {rels}")
        print(f"  Work counters: {getattr(extract_work, 'counters', {})}")

    # Print MCP server hint
    print(f"\nTo serve as MCP:")
    print(f"  python -c \"from graphify.serve import serve; serve('{graph_path}')\"")


if __name__ == "__main__":
    main()

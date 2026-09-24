#!/usr/bin/env python3
"""Tests for build-graph.py reporting fixes (issue #326)."""

import importlib.util
import sys
import types
from pathlib import Path

import networkx as nx
import pytest

_SPEC = importlib.util.spec_from_file_location(
    "build_graph", Path(__file__).parent / "build-graph.py")
BG = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(BG)


def two_community_graph() -> nx.Graph:
    G = nx.Graph()
    for i in range(5):
        for j in range(i + 1, 5):
            G.add_edge(f"a{i}", f"a{j}")
            G.add_edge(f"b{i}", f"b{j}")
    G.add_edge("a0", "b0")
    return G


def install_fake_leiden(monkeypatch, leiden):
    fake_pkg = types.ModuleType("graspologic")
    fake_partition = types.ModuleType("graspologic.partition")
    fake_partition.leiden = leiden
    fake_pkg.partition = fake_partition
    monkeypatch.setitem(sys.modules, "graspologic", fake_pkg)
    monkeypatch.setitem(sys.modules, "graspologic.partition", fake_partition)


# ── Defect 1: partitioner fallback must be reported ─────────────────────

def test_leiden_exception_falls_back_to_louvain_with_reason(monkeypatch):
    def leiden(*args, **kwargs):
        raise TypeError("leiden() got an unexpected keyword argument 'seed'")
    install_fake_leiden(monkeypatch, leiden)

    G = two_community_graph()
    comms = BG.detect_communities(G)
    assert comms, "build must still succeed via the louvain fallback"
    assert G.graph["partitioner"] == "louvain"
    assert "TypeError" in G.graph["partitioner_fallback"]

    report = BG.generate_report(G, comms, [], [], [], Path("vault"), "wiki")
    assert "- **Partitioner**: louvain (fallback —" in report
    assert "TypeError" in report


def test_leiden_success_labels_partitioner(monkeypatch):
    def leiden(matrix, seed=None):
        assert seed == 42
        return [0] * matrix.shape[0]
    install_fake_leiden(monkeypatch, leiden)

    G = two_community_graph()
    BG.detect_communities(G)
    assert G.graph["partitioner"] == "leiden"
    assert G.graph["partitioner_fallback"] is None

    report = BG.generate_report(G, {}, [], [], [], Path("vault"), "wiki")
    assert "- **Partitioner**: leiden (graspologic, random_seed=42)" in report


def test_missing_graspologic_falls_back_to_louvain():
    if importlib.util.find_spec("graspologic") is not None:
        pytest.skip("graspologic installed; ImportError path not reachable")
    G = two_community_graph()
    comms = BG.detect_communities(G)
    assert comms
    assert G.graph["partitioner"] == "louvain"
    assert "not installed" in G.graph["partitioner_fallback"]


# ── Defect 2: report the true cross-community edge count ────────────────

def many_cross_edges_graph(n: int = 20) -> tuple[nx.Graph, dict]:
    G = nx.Graph()
    for i in range(n):
        G.add_edge(f"a{i}", f"b{i}")
    communities = {0: [f"a{i}" for i in range(n)], 1: [f"b{i}" for i in range(n)]}
    return G, communities


def test_surprising_connections_report_true_total():
    G, communities = many_cross_edges_graph(20)
    rows, total = BG.find_surprising_connections(G, communities)
    assert total == 20
    assert len(rows) == 15  # display cap

    report = BG.generate_report(
        G, communities, [], rows, [], Path("vault"), "wiki",
        surprises_total=total)
    assert "20 total (top 15 shown)" in report


# ── Defect 3: per-endpoint cap on surprising connections ────────────────

def single_hub_graph(n: int = 10) -> tuple[nx.Graph, dict]:
    G = nx.Graph()
    for i in range(n):
        G.add_edge("hub_node", f"b{i}")
    communities = {0: ["hub_node"], 1: [f"b{i}" for i in range(n)]}
    return G, communities


def test_surprise_cap_limits_repeated_endpoint():
    G, communities = single_hub_graph(10)
    rows, total = BG.find_surprising_connections(G, communities, max_per_node=2)
    assert total == 10
    rows_with_hub = [
        r for r in rows
        if r["source"] == "hub_node" or r["target"] == "hub_node"
    ]
    assert len(rows_with_hub) <= 2


def test_zero_cap_reproduces_precap_ordering():
    G, communities = single_hub_graph(10)
    rows, total = BG.find_surprising_connections(G, communities, max_per_node=0)
    assert total == 10
    assert len(rows) == 10  # uncapped: every row contains the hub node

    expected = sorted(
        ({"source": "hub_node", "target": f"b{i}"} for i in range(10)),
        key=lambda e: G.degree(e["source"]) + G.degree(e["target"]),
        reverse=True,
    )
    assert [(r["source"], r["target"]) for r in rows] == [
        (e["source"], e["target"]) for e in expected
    ]
    assert [r["score"] for r in rows] == [
        G.degree(e["source"]) + G.degree(e["target"]) for e in expected
    ]

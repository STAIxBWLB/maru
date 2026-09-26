#!/usr/bin/env python3
"""vault-lint deterministic core — read-only fs scan of a vault.

Runs the vault-scope checks (L01 L02 L03 L09 L10 L11 L12) and prints the
report body as markdown. Report writing (Obsidian MCP) and the LINT log line
stay in SKILL.md. Reads notes/ via fs read-only — the same exception
build-graph.py relies on (lib/vault_adapter.md).

  python3 lint.py --vault <vault.path> [--registry <project-registry.yaml>]
                  [--note notes/<x>.md] [--self-test]
"""
import argparse
import json
import re
import sys
from datetime import date, datetime
from pathlib import Path

import yaml

FM_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*\n?", re.S)
WIKI_RE = re.compile(r"\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]")
LOG_RE = re.compile(r"^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})\s+(\S+)\s+(.*)$")
TREND_DATE_RE = re.compile(r"graph-report-(\d{6})\.md$")

TYPES = {"insight", "decision", "observation", "person", "project", "method", "moc", "reference"}
CONFIDENCE = {"proven", "likely", "experimental"}
STATUS = {"active", "superseded", "archived"}
HUB_MOC = "index"  # vault/AGENTS.md §Navigation root; exempt from L03
# keep aligned with _meta/rules/ingest-chain.md §TYPE 집합 / §비표준 TYPE 처리
CANONICAL = {"INGEST", "ROUTE", "EXTRACT", "CONNECT", "DIGEST", "LEARN", "LINT",
             "TASK", "GRAPH", "SYNC", "RETHINK", "SOURCE"}
LEGACY = {"CREATE", "UPDATE", "MIGRATE", "REFACTOR", "MERGE", "MOVE", "RELOCATE", "RENAME",
          "DRAFT", "REVIEW", "RESEARCH", "REF", "CLEANUP", "CLOSE", "DONE", "SUPERSEDED",
          "DUPLICATE", "SKIP", "EDIT", "CORRECT"}
WIKI_FIELDS = ("topics", "project", "projects", "superseded_by", "supersedes")
STALE_DAYS = 7
LOG_MAX_LINES = 20_000


def load_fm(text):
    m = FM_RE.match(text)
    if not m:
        return None
    try:
        d = yaml.safe_load(m.group(1))
    except yaml.YAMLError:
        return None
    return d if isinstance(d, dict) else {}


def body_of(text):
    m = FM_RE.match(text)
    return text[m.end():] if m else text


def links_in(value):
    """wiki-link targets inside a frontmatter value (str or list)."""
    out = []
    for v in (value if isinstance(value, list) else [value]):
        if isinstance(v, str):
            out += [t.strip() for t in WIKI_RE.findall(v)]
    return out


def target_stem(t):
    t = t.strip()
    if t.endswith(".md"):
        t = t[:-3]
    return t.rsplit("/", 1)[-1]


def scan(vault: Path, only=None):
    notes = {}
    for f in sorted((vault / "notes").glob("*.md")):
        text = f.read_text(encoding="utf-8", errors="replace")
        fm = load_fm(text)
        fm_links = []
        if fm:
            for k in WIKI_FIELDS:
                if k in fm:
                    fm_links += [(k, t) for t in links_in(fm[k])]
        notes[f.stem] = {
            "rel": f"notes/{f.name}", "fm": fm,
            "body_links": [t.strip() for t in WIKI_RE.findall(body_of(text))],
            "fm_links": fm_links,
        }
    return notes


def check_notes(notes, registry_ids):
    stems = set(notes)
    l01, l02, l10 = [], [], []
    inlinks = {s: 0 for s in stems}
    for stem, n in notes.items():
        fm = n["fm"]
        for t in n["body_links"]:
            ts = target_stem(t)
            if ts in stems:
                if ts != stem:
                    inlinks[ts] += 1
            else:
                l01.append(f"`{n['rel']}`: `[[{t}]]` (body) → 대상 노트 없음")
        for field, t in n["fm_links"]:
            ts = target_stem(t)
            if ts in stems:
                if ts != stem:
                    inlinks[ts] += 1
            else:
                l01.append(f"`{n['rel']}`: `[[{t}]]` ({field}) → 대상 노트 없음")
        if fm is None:
            l02.append(f"`{n['rel']}`: frontmatter 없음/파싱 실패")
            continue
        typ = fm.get("type")
        if typ not in TYPES:
            l02.append(f"`{n['rel']}`: `type: {typ}` 허용값 아님 ({' | '.join(sorted(TYPES))})")
        topics = fm.get("topics") or []
        if typ == "moc":
            if not fm.get("description"):
                l02.append(f"`{n['rel']}`: `type: moc` 노트는 `description` 필수")
        elif not topics:
            l02.append(f"`{n['rel']}`: `topics` 없음/빈 배열")
        for key, allowed in (("confidence", CONFIDENCE), ("status", STATUS)):
            if key in fm and fm[key] is not None and str(fm[key]) not in allowed:
                hint = " (status는 노트 생애주기이지 사업 진행 상태가 아님 — 작업 상태는 본문에)" if key == "status" else ""
                l02.append(f"`{n['rel']}`: `{key}: {fm[key]}` 허용값 아님 ({' | '.join(sorted(allowed))}){hint}")
        proj = fm.get("project")
        if isinstance(proj, str) and proj.strip():
            tl = links_in(proj)
            if tl:
                for t in tl:
                    if target_stem(t) not in stems:
                        l10.append(f"`{n['rel']}`: `project: [[{t}]]` dead wiki-link")
            elif registry_ids is not None and proj.strip() not in registry_ids:
                l10.append(f"`{n['rel']}`: `project: {proj}` registry id 아님")
    l03 = []
    for stem, n in sorted(notes.items()):
        if stem == HUB_MOC or n["fm"] is None:
            continue
        if not (n["fm"].get("topics") or []) and inlinks[stem] == 0:
            l03.append(f"`{n['rel']}`: in-link 0, topics 0")
    superseded = sum(1 for n in notes.values() if n["fm"] and n["fm"].get("status") == "superseded")
    return l01, l02, l03, l10, superseded


def check_log(log_path: Path):
    warns, legacy_n, legacy_last, data = [], 0, None, 0
    if not log_path.exists():
        return [f"`{log_path}` 없음"], "log 없음"
    for i, line in enumerate(log_path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        if not line.strip() or line.startswith("#"):
            continue
        data += 1
        m = LOG_RE.match(line)
        if not m:
            warns.append(f"`log:{i}`: 구조 위반 (`YYYY-MM-DD HH:MM  TYPE  ...` 아님): `{line[:60]}`")
            continue
        d, _, typ, _ = m.groups()
        if typ in CANONICAL:
            continue
        if typ in LEGACY:
            legacy_n += 1
            legacy_last = max(legacy_last or d, d)
        else:
            warns.append(f"`log:{i}`: TYPE `{typ}` 미등록 (정규 12종·정규화표 모두 없음)")
    if data > LOG_MAX_LINES:
        warns.append(f"log {data} 라인 > {LOG_MAX_LINES} — 수동 아카이브 권장")
    info = (f"legacy TYPE {legacy_n}건 (정규화표 등재), 최종 사용 {legacy_last}, 신규 발생 없음"
            if legacy_n else "legacy TYPE 0건")
    return warns, info


def check_graph(reports: Path, today: date):
    l11, l12 = [], []
    rep = sorted(reports.glob("graph-report-*.md"))
    if not rep:
        l11.append("graph report 없음 — `/vault-graph build` 필요")
    else:
        m = TREND_DATE_RE.search(rep[-1].name)
        age = (today - datetime.strptime(m.group(1), "%y%m%d").date()).days if m else None
        if age is None or age > STALE_DAYS:
            l11.append(f"`{rep[-1].name}`: {age}일 경과 (> {STALE_DAYS}) — `/vault-graph build` 재실행 권장")
    gj = reports / "vault-graph.json"
    if not gj.exists():
        return l11, l12, None
    g = json.loads(gj.read_text(encoding="utf-8"))
    comm = {n["id"]: n.get("community") for n in g.get("nodes", []) if n.get("community") is not None}
    members, cross = {}, {}
    for nid, c in comm.items():
        members.setdefault(c, []).append(nid)
        cross.setdefault(c, 0)
    for e in g.get("links") or g.get("edges") or []:
        cs, ct = comm.get(e.get("source")), comm.get(e.get("target"))
        if cs is not None and ct is not None and cs != ct:
            cross[cs] += 1
            cross[ct] += 1
    singles = sorted(m[0] for m in members.values() if len(m) == 1)
    for c, m in members.items():
        if len(m) > 1 and cross[c] == 0:
            shown = ", ".join(f"`{x}`" for x in sorted(m)[:10])
            more = f" +{len(m) - 10} more" if len(m) > 10 else ""
            l12.append(f"island community ({len(m)} notes): {shown}{more} — `/vault-connect` 필요")
    stats = {"nodes": len(g.get("nodes", [])), "edges": len(g.get("links") or g.get("edges") or []),
             "communities": len(members), "singletons": singles}
    return l11, l12, stats


def section(title, items, sev, extra=None):
    out = [f"## {title} ({sev}, {len(items)}건)", ""]
    out += [f"- {x}" for x in items] or ["위반 없음"]
    if extra:
        out += ["", extra]
    return out + [""]


def run(vault: Path, registry: Path | None, only: str | None, today: date):
    notes = scan(vault)
    registry_ids = None
    if registry and registry.exists():
        d = yaml.safe_load(registry.read_text(encoding="utf-8")) or {}
        registry_ids = {p.get("id") for p in d.get("projects", []) if isinstance(p, dict)}
    l01, l02, l03, l10, superseded = check_notes(notes, registry_ids)
    if only:
        key = f"`{only}`"
        l01, l02, l03, l10 = ([x for x in lst if x.startswith(key)] for lst in (l01, l02, l03, l10))
    l09, l09_info = check_log(vault / "log")
    l11, l12, gstats = check_graph(vault / "reports", today)
    errors = len(l01) + len(l02)
    warns = len(l03) + len(l09) + len(l10) + len(l11) + len(l12)
    out = [f"<!-- lint.py {today:%Y-%m-%d} notes={len(notes)} errors={errors} warnings={warns} -->", ""]
    out += section("L01 — dead wiki-link", l01, "error")
    out += section("L02 — 필수 frontmatter / 허용값", l02, "error",
                   f"정보: `status: superseded` {superseded}건" + (" — supersede 프로토콜 미가동" if superseded == 0 else ""))
    out += section("L03 — orphan", l03, "warn", f"hub MOC `notes/{HUB_MOC}.md`는 설계상 예외")
    out += section("L09 — 로그 포맷", l09, "warn", f"정보: {l09_info}")
    out += section("L10 — project 값", l10, "warn", None if registry_ids is not None else "registry 미지정 — plain id 검사 생략")
    out += section("L11 — graph report staleness", l11, "warn")
    gx = (f"nodes {gstats['nodes']} / edges {gstats['edges']} / communities {gstats['communities']}; "
          f"singleton {len(gstats['singletons'])}개" + (": " + ", ".join(f"`{s}`" for s in gstats["singletons"][:10]) if gstats["singletons"] else "")) if gstats else "vault-graph.json 없음 — L12 생략"
    out += section("L12 — island community", l12, "warn", gx)
    return "\n".join(out), errors, warns


def self_test():
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        v = Path(td); (v / "notes").mkdir(); (v / "reports").mkdir()
        w = lambda name, s: (v / "notes" / f"{name}.md").write_text(s, encoding="utf-8")
        w("index", "---\ntype: moc\ndescription: hub\n---\n# hub\n")
        w("projects", "---\ntype: moc\ndescription: domain\ntopics:\n  - \"[[index]]\"\n---\n")
        w("a", "---\ntype: insight\ndescription: d\ndomain: projects\ntopics:\n  - \"[[projects]]\"\n---\nsee [[missing-note]] and [[b]]\n")
        w("b", "---\ntype: decision\ndescription: d\ndomain: projects\nconfidence: high\nstatus: done\ntopics: [\"[[projects]]\"]\n---\n")
        w("c", "---\ntype: insight\ndescription: d\ndomain: projects\nproject: nope\n---\norphan\n")
        (v / "log").write_text("# header\n2026-08-01 10:00  EXTRACT  rise  x → notes/a.md  — insight\n"
                               "2026-07-19 09:00  RENAME  -  a → b  — legacy\n"
                               "- 2026-05-11T05:03:16Z task-management: bad\n"
                               "2026-08-02 10:00  BOGUS  -  x  — unregistered\n", encoding="utf-8")
        (v / "reports" / "graph-report-260101.md").write_text("# old\n", encoding="utf-8")
        (v / "reports" / "vault-graph.json").write_text(json.dumps({
            "nodes": [{"id": "a", "community": 0}, {"id": "b", "community": 0}, {"id": "c", "community": 1},
                      {"id": "d", "community": 2}, {"id": "e", "community": 2}],
            "links": [{"source": "a", "target": "b"}, {"source": "d", "target": "e"}, {"source": "b", "target": "c"}]}),
            encoding="utf-8")
        reg = v / "registry.yaml"; reg.write_text("projects:\n  - id: rise\n", encoding="utf-8")
        report, errors, warns = run(v, reg, None, date(2026, 8, 19))
        assert "[[missing-note]]" in report and report.count("대상 노트 없음") == 1, report
        assert "`confidence: high`" in report and "`status: done`" in report, report
        assert "`notes/c.md`: `topics` 없음" in report, report
        assert "`notes/c.md`: in-link 0" in report and "notes/index.md`: in-link" not in report, report
        assert "legacy TYPE 1건" in report and "TYPE `BOGUS` 미등록" in report and "구조 위반" in report, report
        assert "`project: nope` registry id 아님" in report, report
        assert "graph-report-260101.md`: 230일" in report, report
        assert "island community (2 notes): `d`, `e`" in report and "singleton 1개: `c`" in report, report
        assert (errors, warns) == (4, 6), (errors, warns)
        only, _, _ = run(v, reg, "notes/b.md", date(2026, 8, 19))
        assert "notes/a.md" not in only.split("## L09")[0] and "`confidence: high`" in only
    print("self-test ok")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--vault", type=Path, help="vault root (contains notes/, log, reports/)")
    ap.add_argument("--registry", type=Path, help="project-registry.yaml (L10 plain-id check)")
    ap.add_argument("--note", help="limit L01/L02/L03/L10 to one note, e.g. notes/x.md")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        return self_test()
    if not a.vault:
        ap.error("--vault required")
    report, errors, warns = run(a.vault.expanduser(), a.registry.expanduser() if a.registry else None, a.note, date.today())
    print(report)
    print(f"SUMMARY errors={errors} warnings={warns}", file=sys.stderr)


if __name__ == "__main__":
    main()

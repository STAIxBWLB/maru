"""공문서/대학 기본 스타일 후처리 패스 (lxml).

hwp-cli `new`가 생성한 HWPX(또는 임의 HWPX)에 workspace corpus 관례를 입힌다
(근거: references/style-patterns.md, 137개 실문서 분석):

- 표: 내용 비례 칼럼 폭(2col 라벨:값 1:3~1:4 특례, 균등 내용은 균등 유지),
  헤더행 음영(#F2F2F2)+굵게+가운데, 짧은 칼럼 본문 셀 가운데.
- 제목(H1): 가운데 + 15pt 굵게.

가드(균등 폭 아닌 표 스킵, borderFill 혼합 표 스킵, 이미 CENTER/bold면 재사용)로
임의 파일(beautify)에도 안전하고 멱등이다. 헤더 리소스 추가 시 itemCnt를 항상
자식 수로 재계산한다(한글 호환 불변식).
"""

from __future__ import annotations

import unicodedata
import zipfile
from copy import deepcopy
from pathlib import Path

from lxml import etree

import hwpx_xml as hx

HC_NS = "http://www.hancom.co.kr/hwpml/2011/core"
HC = f"{{{HC_NS}}}"
HH = f"{{{hx.HH_NS}}}"

MIN_COL_HWPU = 3400  # 좁은 칼럼 바닥 (~12mm)
LABEL_MIN, LABEL_MAX = 7200, 8500  # 2col 라벨 폭 25~30mm
SHORT_COL_DW = 8  # 표시폭 ≤8 → 짧은 칼럼(가운데 정렬 후보)
UNIFORM_RATIO = 1.25  # 칼럼 가중치 max/min ≤ 1.25 → 균등 유지
TITLE_HEIGHT = 1500  # 제목 15pt (charPr height 단위 = pt×100)


# ── 표시폭/텍스트 측정 ────────────────────────────────────────────────────────

def _disp(s: str) -> int:
    """동아시아 전각 2, 그 외 1로 센 표시폭."""
    return sum(2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1 for ch in s)


def _cell_paragraphs(tc: etree._Element) -> list[etree._Element]:
    return list(tc.iter(f"{hx.HP}p"))


def _cell_dw(tc: etree._Element) -> int | None:
    """셀 내용의 최대 줄 표시폭. 중첩 표가 있으면 None(측정 제외)."""
    for e in tc.iter():
        if hx.localname(e) == "tbl":
            return None
    best = 0
    for p in _cell_paragraphs(tc):
        for line in hx.paragraph_text(p).split("\n"):
            best = max(best, _disp(line))
    return best


# ── header.xml 리소스 헬퍼 (재사용 우선 → 클론, itemCnt 재계산) ───────────────

def _find_list(head_root: etree._Element, name: str) -> etree._Element | None:
    for e in head_root.iter():
        if hx.localname(e) == name:
            return e
    return None


def _children(container: etree._Element) -> list[etree._Element]:
    return [c for c in container if isinstance(c.tag, str)]


def _bump_itemcnt(container: etree._Element) -> None:
    container.set("itemCnt", str(len(_children(container))))


def _next_id(container: etree._Element) -> str:
    ids = [int(c.get("id")) for c in _children(container) if (c.get("id") or "").isdigit()]
    return str(max(ids, default=-1) + 1)


def _by_id(container: etree._Element, id_: str) -> etree._Element | None:
    for c in _children(container):
        if c.get("id") == id_:
            return c
    return None


def _align_el(para_pr: etree._Element) -> etree._Element | None:
    for c in para_pr:
        if hx.localname(c) == "align":
            return c
    return None


def ensure_center_parapr(head_root: etree._Element, base_id: str, cache: dict) -> str:
    """base가 이미 CENTER면 그대로(멱등), 아니면 CENTER 클론 id."""
    if base_id in cache:
        return cache[base_id]
    plist = _find_list(head_root, "paraProperties")
    base = _by_id(plist, base_id) if plist is not None else None
    if base is None:
        return base_id
    al = _align_el(base)
    if al is not None and al.get("horizontal") == "CENTER":
        cache[base_id] = base_id
        return base_id
    clone = deepcopy(base)
    clone.set("id", _next_id(plist))
    cal = _align_el(clone)
    if cal is None:
        cal = etree.SubElement(clone, f"{HH}align")
    cal.set("horizontal", "CENTER")
    plist.append(clone)
    _bump_itemcnt(plist)
    cache[base_id] = clone.get("id")
    return cache[base_id]


def _has_child(el: etree._Element, name: str) -> bool:
    return any(hx.localname(c) == name for c in el)


def _fontref_sig(char_pr: etree._Element) -> tuple:
    for c in char_pr:
        if hx.localname(c) == "fontRef":
            return tuple(sorted(c.attrib.items()))
    return ()


def ensure_bold_charpr(head_root: etree._Element, base_id: str, cache: dict) -> str:
    """base가 이미 bold면 그대로; 동일 height/fontRef/italic의 bold 쌍둥이 재사용;
    없으면 bold 클론 id."""
    if base_id in cache:
        return cache[base_id]
    clist = _find_list(head_root, "charProperties")
    base = _by_id(clist, base_id) if clist is not None else None
    if base is None:
        return base_id
    if _has_child(base, "bold"):
        cache[base_id] = base_id
        return base_id
    sig = (base.get("height"), _fontref_sig(base), _has_child(base, "italic"))
    for cand in _children(clist):
        if _has_child(cand, "bold") and (
            cand.get("height"), _fontref_sig(cand), _has_child(cand, "italic")
        ) == sig:
            cache[base_id] = cand.get("id")
            return cache[base_id]
    clone = deepcopy(base)
    clone.set("id", _next_id(clist))
    bold = clone.makeelement(f"{HH}bold", {})
    anchor = next(
        (c for c in clone if hx.localname(c) in ("underline", "strikeout")), None
    )
    if anchor is not None:
        anchor.addprevious(bold)
    else:
        clone.append(bold)
    clist.append(clone)
    _bump_itemcnt(clist)
    cache[base_id] = clone.get("id")
    return cache[base_id]


def _face_color(border_fill: etree._Element) -> str | None:
    for e in border_fill.iter():
        if hx.localname(e) == "winBrush":
            return e.get("faceColor")
    return None


def ensure_shaded_borderfill(
    head_root: etree._Element, base_id: str, face: str, cache: dict
) -> str:
    """base 테두리에 winBrush 음영(face)을 더한 borderFill id (재사용 우선)."""
    key = (base_id, face)
    if key in cache:
        return cache[key]
    blist = _find_list(head_root, "borderFills")
    base = _by_id(blist, base_id) if blist is not None else None
    if base is None:
        return base_id
    if _face_color(base) == face:
        cache[key] = base_id
        return base_id
    for cand in _children(blist):
        if _face_color(cand) == face:
            cache[key] = cand.get("id")
            return cache[key]
    clone = deepcopy(base)
    clone.set("id", _next_id(blist))
    for fb in [c for c in clone if hx.localname(c) == "fillBrush"]:
        clone.remove(fb)
    fill = etree.SubElement(clone, f"{HC}fillBrush")
    etree.SubElement(
        fill, f"{HC}winBrush", faceColor=face, hatchColor="#999999", alpha="0"
    )
    blist.append(clone)
    _bump_itemcnt(blist)
    cache[key] = clone.get("id")
    return cache[key]


def ensure_title_charpr(head_root: etree._Element, base_id: str, cache: dict) -> str:
    """15pt(1500)+bold charPr (생성물엔 H2 charPr가 정확히 이것 — 재사용)."""
    if base_id in cache:
        return cache[base_id]
    clist = _find_list(head_root, "charProperties")
    base = _by_id(clist, base_id) if clist is not None else None
    if base is None:
        return base_id
    if base.get("height") == str(TITLE_HEIGHT) and _has_child(base, "bold"):
        cache[base_id] = base_id
        return base_id
    sig = _fontref_sig(base)
    cands = [
        c
        for c in _children(clist)
        if c.get("height") == str(TITLE_HEIGHT) and _has_child(c, "bold")
    ]
    hit = next((c for c in cands if _fontref_sig(c) == sig), None)
    if hit is None and cands:
        hit = cands[0]
    if hit is not None:
        cache[base_id] = hit.get("id")
        return cache[base_id]
    clone = deepcopy(base)
    clone.set("id", _next_id(clist))
    clone.set("height", str(TITLE_HEIGHT))
    if not _has_child(clone, "bold"):
        bold = clone.makeelement(f"{HH}bold", {})
        anchor = next(
            (c for c in clone if hx.localname(c) in ("underline", "strikeout")), None
        )
        if anchor is not None:
            anchor.addprevious(bold)
        else:
            clone.append(bold)
    clist.append(clone)
    _bump_itemcnt(clist)
    cache[base_id] = clone.get("id")
    return cache[base_id]


# ── 표 스타일링 ───────────────────────────────────────────────────────────────

def _table_cells(tbl: etree._Element):
    """[(tc, col, row, colspan)] — cellAddr/cellSpan/cellSz가 온전한 셀만."""
    cells = []
    for tr in tbl:
        if hx.localname(tr) != "tr":
            continue
        for tc in tr:
            if hx.localname(tc) != "tc":
                continue
            addr = next((c for c in tc if hx.localname(c) == "cellAddr"), None)
            span = next((c for c in tc if hx.localname(c) == "cellSpan"), None)
            sz = next((c for c in tc if hx.localname(c) == "cellSz"), None)
            if addr is None or sz is None:
                continue
            cells.append(
                (
                    tc,
                    int(addr.get("colAddr") or 0),
                    int(addr.get("rowAddr") or 0),
                    int(span.get("colSpan") or 1) if span is not None else 1,
                    sz,
                )
            )
    return cells


def _column_widths(tbl: etree._Element, cells, ncols: int) -> list[int] | None:
    """내용 비례 칼럼 폭. None = 손대지 않음(균등 유지/이미 폭 지정/측정 불가)."""
    row0 = [c for c in cells if c[2] == 0]
    if not row0 or ncols < 2:
        return None
    total = sum(int(c[4].get("width") or 0) for c in row0)
    if total <= 0:
        return None
    # 가드: 현재 균등 폭이 아니면(누군가 폭을 지정) 스킵 — beautify 안전/멱등.
    units = [int(c[4].get("width") or 0) / c[3] for c in row0]
    if max(units) - min(units) > 2:
        return None
    raw: list[int] = [0] * ncols
    for tc, col, _row, cs, _sz in cells:
        if cs != 1 or col >= ncols:
            continue
        dw = _cell_dw(tc)
        if dw is not None:
            raw[col] = max(raw[col], dw)
    weights = [min(20, max(3, w if w > 0 else 3)) for w in raw]
    if max(weights) / min(weights) <= UNIFORM_RATIO:
        return None  # 내용이 고른 표는 균등 유지
    if ncols == 2 and raw[0] <= SHORT_COL_DW:
        label = min(LABEL_MAX, max(LABEL_MIN, total // 4))
        return [label, total - label]
    # 가중치 비례 + 최소폭 바닥 재분배(총폭 보존)
    fixed: dict[int, int] = {}
    free = set(range(ncols))
    widths: dict[int, int] = {}
    while free:
        rem = total - sum(fixed.values())
        wsum = sum(weights[c] for c in free)
        widths = {c: rem * weights[c] // wsum for c in free}
        under = [c for c in free if widths[c] < MIN_COL_HWPU]
        if not under:
            break
        for c in under:
            fixed[c] = MIN_COL_HWPU
            free.discard(c)
    out = [fixed.get(c, widths.get(c, MIN_COL_HWPU)) for c in range(ncols)]
    out[out.index(max(out))] += total - sum(out)  # 정수 오차 → 최광폭 칼럼
    return out


def _style_table(
    head_root: etree._Element,
    tbl: etree._Element,
    header_fill: str,
    caches: dict,
    stats: dict,
) -> None:
    ncols = int(tbl.get("colCnt") or 0)
    nrows = int(tbl.get("rowCnt") or 0)
    cells = _table_cells(tbl)
    if not cells:
        return
    stats["tables"] += 1

    colw = _column_widths(tbl, cells, ncols)
    if colw is not None:
        for _tc, col, _row, cs, sz in cells:
            sz.set("width", str(sum(colw[col : col + cs])))
        for p in tbl.iter(f"{hx.HP}p"):
            hx.remove_linesegarray(p)
        stats["widths_changed"] += 1

    if nrows < 2:
        return  # 단일 행 표: 폭만

    row0 = [c for c in cells if c[2] == 0]
    body = [c for c in cells if c[2] >= 1]

    # 헤더행: 전 셀 borderFill 동일할 때만 음영(이미 스타일된 표 보호 + 멱등)
    bf_refs = {tc.get("borderFillIDRef") for tc, *_ in cells}
    if len(bf_refs) == 1:
        base_bf = bf_refs.pop()
        if base_bf:
            sid = ensure_shaded_borderfill(head_root, base_bf, header_fill, caches["bf"])
            if sid != base_bf:
                for tc, *_ in row0:
                    tc.set("borderFillIDRef", sid)
                stats["header_cells"] += len(row0)
    for tc, *_ in row0:
        for sub in tc:
            if hx.localname(sub) == "subList":
                sub.set("vertAlign", "CENTER")
        for p in _cell_paragraphs(tc):
            cur = p.get("paraPrIDRef") or "0"
            p.set("paraPrIDRef", ensure_center_parapr(head_root, cur, caches["para"]))
            for run in p:
                if hx.localname(run) == "run" and run.get("charPrIDRef") is not None:
                    run.set(
                        "charPrIDRef",
                        ensure_bold_charpr(
                            head_root, run.get("charPrIDRef"), caches["char"]
                        ),
                    )

    # 본문 짧은 칼럼(순번/숫자류) 가운데 정렬
    for col in range(ncols):
        cands = [
            (tc, cs)
            for tc, c, _r, cs, _sz in body
            if c == col and cs == 1
        ]
        if not cands:
            continue
        dws = [_cell_dw(tc) for tc, _ in cands]
        if any(d is None for d in dws) or max(dws, default=0) > SHORT_COL_DW:
            continue
        if any(len(_cell_paragraphs(tc)) != 1 for tc, _ in cands):
            continue
        for tc, _ in cands:
            for p in _cell_paragraphs(tc):
                cur = p.get("paraPrIDRef") or "0"
                new = ensure_center_parapr(head_root, cur, caches["para"])
                if new != cur:
                    p.set("paraPrIDRef", new)
                    stats["body_centered"] += 1


# ── 제목 ─────────────────────────────────────────────────────────────────────

def _max_charpr_height(head_root: etree._Element) -> int:
    clist = _find_list(head_root, "charProperties")
    if clist is None:
        return 0
    return max(
        (int(c.get("height") or 0) for c in _children(clist)), default=0
    )


def _center_title(head_root: etree._Element, sec: etree._Element, caches: dict) -> bool:
    """첫 본문 문단이 H1 제목이면 가운데 + 15pt 굵게. run 자식은 불가침(secPr 보유)."""
    paras = hx.body_paragraphs(sec)
    if not paras:
        return False
    p = paras[0]
    if not hx.paragraph_text(p).strip():
        return False
    runs = [r for r in p if hx.localname(r) == "run"]
    run_heights = []
    clist = _find_list(head_root, "charProperties")
    for r in runs:
        cid = r.get("charPrIDRef")
        if cid and clist is not None:
            c = _by_id(clist, cid)
            if c is not None:
                run_heights.append(int(c.get("height") or 0))
    is_title = p.get("styleIDRef") == "1" or (
        run_heights
        and max(run_heights) >= 1300
        and max(run_heights) == _max_charpr_height(head_root)
    )
    if not is_title:
        return False
    changed = False
    cur = p.get("paraPrIDRef") or "0"
    new = ensure_center_parapr(head_root, cur, caches["para"])
    if new != cur:
        p.set("paraPrIDRef", new)
        changed = True
    for r in runs:
        cid = r.get("charPrIDRef")
        if cid is not None:
            nid = ensure_title_charpr(head_root, cid, caches["title"])
            if nid != cid:
                r.set("charPrIDRef", nid)
                changed = True
    if changed:
        hx.remove_linesegarray(p)
    return changed


# ── 진입점 ───────────────────────────────────────────────────────────────────

def apply_default_style(
    path: Path | str,
    out: Path | str | None = None,
    *,
    header_fill: str = "#F2F2F2",
    title_center: bool = True,
) -> dict:
    """공문서 기본 스타일 패스. out 생략 시 제자리. stats dict 반환."""
    src = Path(path)
    dst = Path(out) if out is not None else src
    sec_names = hx.section_entry_names(src)
    with zipfile.ZipFile(src) as z:
        if "Contents/header.xml" not in z.namelist():
            raise ValueError(f"header.xml 없음 — HWPX 아님: {src}")
        head_tree = hx.parse_xml(z.read("Contents/header.xml"))
        sec_trees = {n: hx.parse_xml(z.read(n)) for n in sec_names}

    head_root = head_tree.getroot()
    stats = {
        "tables": 0,
        "widths_changed": 0,
        "header_cells": 0,
        "body_centered": 0,
        "title_centered": False,
    }
    caches: dict = {"para": {}, "char": {}, "bf": {}, "title": {}}

    for i, (name, tree) in enumerate(sec_trees.items()):
        sec = hx.find_sec(tree.getroot())
        for tbl in sec.iter(f"{hx.HP}tbl"):
            if any(hx.localname(a) == "tbl" for a in tbl.iterancestors()):
                continue  # 중첩 표는 외곽만
            _style_table(head_root, tbl, header_fill, caches, stats)
        if i == 0 and title_center:
            stats["title_centered"] = _center_title(head_root, sec, caches)

    overrides = {n: hx.serialize(t) for n, t in sec_trees.items()}
    overrides["Contents/header.xml"] = hx.serialize(head_tree)
    hx.rewrite_entries(src, dst, overrides)
    return stats

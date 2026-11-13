"""Korean layout fix for a written .pptx.

Usage: python3 ko_fix.py deck.pptx [--font "Noto Sans CJK KR"] [-o out.pptx]

- Re-tags runs written as lang="en-US" to lang="ko-KR" (altLang="en-US"), in
  slides, layouts, masters, charts and speaker notes.
  PowerPoint then wraps Hangul at word boundaries instead of mid-word.
- With --font, sets the theme's East Asian (<a:ea>) and Hangul (script="Hang")
  fonts, which pptxgenjs leaves empty, so Hangul does not fall back to the host default.
Rewrites the deck in place unless -o is given, keeping the deck's file mode.
Runs its self-checks first.
"""
import argparse
import os
import re
import stat
import tempfile
import zipfile
from xml.sax.saxutils import quoteattr

TEXT_PARTS = re.compile(r"ppt/(slides|slideLayouts|slideMasters|charts|notesSlides)/[^/]+\.xml$")
THEME_PART = re.compile(r"ppt/theme/theme\d+\.xml$")


def copy_mode(src: str, dst: str) -> None:
    """Give dst the mode src has: a rewritten deck keeps its permissions (0600 otherwise)."""
    os.chmod(dst, stat.S_IMODE(os.stat(src).st_mode))


def retag(xml: str) -> str:
    xml = xml.replace('lang="en-US" altLang="en-US"', 'lang="ko-KR" altLang="en-US"')
    return re.sub(r'lang="en-US"(?! altLang)', 'lang="ko-KR" altLang="en-US"', xml)


def set_theme_font(xml: str, font: str) -> str:
    attr = quoteattr(font)  # escapes &, < and quotes for the XML attribute
    hang = f'<a:font script="Hang" typeface={attr}/>'

    def fix(block: str) -> str:
        block = re.sub(r'<a:ea typeface="[^"]*"', lambda _: f'<a:ea typeface={attr}', block)
        if '<a:font script="Hang"' in block:
            return re.sub(r'<a:font script="Hang" typeface="[^"]*"/>', lambda _: hang, block)
        return re.sub(r"(<a:cs [^>]*/>|</a:cs>)", lambda m: m.group(1) + hang, block, count=1)

    return re.sub(r"<a:(majorFont|minorFont)>.*?</a:\1>", lambda m: fix(m.group(0)), xml, flags=re.S)


def selftest():
    assert retag('<a:rPr lang="en-US" b="1"/>') == '<a:rPr lang="ko-KR" altLang="en-US" b="1"/>'
    assert retag('<a:rPr lang="en-US" altLang="en-US"/>') == '<a:rPr lang="ko-KR" altLang="en-US"/>'
    t = '<a:minorFont><a:latin typeface="X"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>'
    out = set_theme_font(t, "F")
    assert '<a:ea typeface="F"' in out and '<a:font script="Hang" typeface="F"/>' in out, out
    t2 = '<a:majorFont><a:ea typeface=""/><a:cs typeface=""/><a:font script="Hang" typeface="Old"/></a:majorFont>'
    assert set_theme_font(t2, "F").count('typeface="F"') == 2
    assert 'typeface="A &amp; B"' in set_theme_font(t, "A & B")

    # Speaker notes carry runs too, so they are retagged with the slides.
    assert TEXT_PARTS.match("ppt/notesSlides/notesSlide2.xml")
    assert not TEXT_PARTS.match("ppt/notesSlides/_rels/notesSlide2.xml.rels")

    # A rewritten deck keeps the mode it arrived with instead of mkstemp's 0600.
    # Compared against the source, not a literal: Windows os.chmod only toggles read-only.
    with tempfile.TemporaryDirectory() as d:
        src, dst = os.path.join(d, "src.pptx"), os.path.join(d, "dst.pptx")
        for p in (src, dst):
            open(p, "w").close()
        os.chmod(src, 0o640)
        copy_mode(src, dst)
        assert stat.S_IMODE(os.stat(dst).st_mode) == stat.S_IMODE(os.stat(src).st_mode)


def main():
    selftest()
    ap = argparse.ArgumentParser()
    ap.add_argument("deck")
    ap.add_argument("--font")
    ap.add_argument("-o", "--out")
    a = ap.parse_args()
    out = a.out or a.deck
    fd, tmp = tempfile.mkstemp(suffix=".pptx", dir=os.path.dirname(os.path.abspath(out)))
    os.close(fd)
    runs = 0
    try:
        with zipfile.ZipFile(a.deck) as zi, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as zo:
            for item in zi.infolist():
                data = zi.read(item.filename)
                if TEXT_PARTS.match(item.filename):
                    text = data.decode("utf-8")
                    runs += text.count('lang="en-US"')
                    data = retag(text).encode("utf-8")
                elif a.font and THEME_PART.match(item.filename):
                    data = set_theme_font(data.decode("utf-8"), a.font).encode("utf-8")
                zo.writestr(item, data)
        copy_mode(a.deck, tmp)
        os.replace(tmp, out)
    except BaseException:
        os.remove(tmp)
        raise
    print(f"ko_fix: {runs} runs re-tagged ko-KR" + (f", theme Hangul font = {a.font}" if a.font else "") + f" -> {out}")


if __name__ == "__main__":
    main()

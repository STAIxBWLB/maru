#!/usr/bin/env python3
"""Self-check for skills#126: the engine-missing message reaches the user.

Run with the bundled env's Python: python check_extract_engine_error.py
Exits 0 and prints "ok" when both cases hold:
1. No engine on PATH, HWP_CLI unset: extracting a .hwp/.hwpx prints the
   engine-missing message to stderr, once, while the fallbacks still run.
2. Engine present but failing on the file: no engine-missing message, and the
   fallback parser still produces the text.
"""
import contextlib
import io
import os
import stat
import sys
import tempfile
import zipfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import extract_all as ea  # noqa: E402

HWPX_XML = (
    '<?xml version="1.0" encoding="UTF-8"?>'
    '<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" '
    'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">'
    "<hp:p><hp:run><hp:t>fallback text</hp:t></hp:run></hp:p></hs:sec>"
)


def reset():
    ea._find_hwp_cli.cache_clear()
    ea._report_engine_missing.cache_clear()


def run(fn, path):
    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        try:
            out = fn(path)
        except Exception as e:  # the .hwp fallback chain may still fail on a fake file
            out = e
    return out, err.getvalue()


def main():
    tmp = Path(tempfile.mkdtemp())
    hwpx = tmp / "doc.hwpx"
    with zipfile.ZipFile(hwpx, "w") as z:
        z.writestr("Contents/section0.xml", HWPX_XML)
    hwp = tmp / "doc.hwp"
    hwp.write_bytes(b"not an ole file")

    os.environ.pop("HWP_CLI", None)
    empty = tmp / "empty"
    empty.mkdir()
    os.environ["PATH"] = str(empty)

    # Case 1: no engine.
    reset()
    _, err = run(ea.extract_hwp, hwp)
    assert ea.ENGINE_MISSING_MESSAGE in err, err
    out, err2 = run(ea.extract_hwpx, hwpx)
    assert out == "fallback text", out
    assert ea.ENGINE_MISSING_MESSAGE not in err2, "message should print once per run"

    # Case 2: engine exists but fails on the file.
    failing = tmp / "bin"
    failing.mkdir()
    stub = failing / "ahwp"
    stub.write_text('#!/bin/sh\n[ "$2" = --help ] && exit 0\nexit 3\n')
    stub.chmod(stub.stat().st_mode | stat.S_IEXEC)
    os.environ["PATH"] = str(failing)
    reset()
    out, err = run(ea.extract_hwpx, hwpx)
    assert out == "fallback text", out
    assert ea.ENGINE_MISSING_MESSAGE not in err, err
    print("ok")


if __name__ == "__main__":
    main()

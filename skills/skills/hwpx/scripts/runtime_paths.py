"""Path resolution for the hwpx skill's bundled-JRE runtime.

Layout (relative to this file):
  scripts/runtime_paths.py        ← __file__
  scripts/                        ← parent
  /                               ← SKILL_ROOT (skills/hwpx/)
  ancestor _sys/skills/env/       ← ENV_ROOT (jre + .venv)
  runtime/                        ← bundled Java assets (in skill, committed)
"""
from __future__ import annotations

import os
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parent.parent          # skills/hwpx/
RUNTIME = SKILL_ROOT / "runtime"


def _find_env_root(start: Path) -> Path:
    for base in (start, *start.parents):
        for candidate in (
            base / "env",
            base / "_sys" / "skills" / "env",
            base / "skills" / "env",
        ):
            if (candidate / "pyproject.toml").exists() or (candidate / ".venv").exists():
                return candidate
    return SKILL_ROOT.parents[2] / "skills" / "env"


ENV_ROOT = _find_env_root(SKILL_ROOT)

JAVA_BIN = ENV_ROOT / "jre" / "bin" / "java"
HWPXLIB_JAR = RUNTIME / "hwpxlib-1.0.5.jar"
WRITER_CLASS_DIR = RUNTIME                                    # contains HwpxWriter.class
WRITER_CLASS = RUNTIME / "HwpxWriter.class"
TEMPLATE_HELPER = RUNTIME / "hwpx_template_export.py"
TIDY_TEMPLATES = RUNTIME / "templates"

VENV_PY = ENV_ROOT / ".venv" / "bin" / "python3"

SETUP_HINT = (
    "JRE 미설치. 다음을 실행:\n"
    f"  bash {ENV_ROOT}/scripts/setup-jre.sh"
)


def classpath() -> str:
    return f"{HWPXLIB_JAR}{os.pathsep}{WRITER_CLASS_DIR}"


def assert_jre() -> None:
    """Fail fast with a helpful message if the bundled JRE/jar/class are missing."""
    missing = [str(p) for p in (JAVA_BIN, HWPXLIB_JAR, WRITER_CLASS) if not p.exists()]
    if missing:
        raise RuntimeError(
            "bundled-JRE writer 자산 누락:\n  - "
            + "\n  - ".join(missing)
            + f"\n\n{SETUP_HINT}"
        )


def tidy_template(template_id: str) -> Path:
    """Resolve a tidy-style template file (report/gongmun/minutes/proposal/notice)."""
    safe = "".join(c for c in template_id if c.isalnum() or c in "_-").lower() or "report"
    return TIDY_TEMPLATES / f"{safe}.hwpx"

"""Path resolution for the hwpx skill's bundled Java runtime.

Layout (relative to this file):
  scripts/runtime_paths.py        ← __file__
  scripts/                        ← parent
  /                               ← SKILL_ROOT (skills/hwpx/)
  ancestor skills/envs/default/   ← ENV_ROOT (jre + .venv)
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
            base / "envs" / "default",
            base / "_sys" / "skills" / "env",
            base / "skills" / "env",
            base / "skills" / "envs" / "default",
        ):
            if (candidate / "pyproject.toml").exists() or (candidate / ".venv").exists():
                return candidate
    return SKILL_ROOT.parents[2] / "skills" / "envs" / "default"


ENV_ROOT = _find_env_root(SKILL_ROOT)

JAVA_BIN = ENV_ROOT / "jre" / "bin" / "java"
HWPXLIB_JAR = RUNTIME / "hwpxlib-1.0.5.jar"
WRITER_CLASS_DIR = RUNTIME
WRITER_CLASS = RUNTIME / "HwpxWriter.class"
WRITER_SOURCE = RUNTIME / "HwpxWriter.java"
VENV_PY = ENV_ROOT / ".venv" / "bin" / "python3"

SETUP_HINT = (
    "bundled Java runtime 미설치. 다음을 실행:\n"
    f"  bash {ENV_ROOT}/scripts/setup-jre.sh"
)


def classpath() -> str:
    return f"{HWPXLIB_JAR}{os.pathsep}{WRITER_CLASS_DIR}"


def assert_jre() -> None:
    """Fail fast with a helpful message if bundled Java assets are missing."""
    missing = [str(p) for p in (JAVA_BIN, HWPXLIB_JAR, WRITER_SOURCE) if not p.exists()]
    if missing:
        raise RuntimeError(
            "bundled Java writer 자산 누락:\n  - "
            + "\n  - ".join(missing)
            + f"\n\n{SETUP_HINT}"
        )

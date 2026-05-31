# Document Runtime Reference

`env/` provides the Python/Node runtime used by document and graph skills.

## Layout

```text
env/
├── pyproject.toml        # Python dependencies managed by uv
├── uv.lock
├── package.json          # Node dependencies managed by pnpm
├── pnpm-lock.yaml
├── setup.sh
├── Makefile
├── .claude/
│   ├── hooks/init-env.sh
│   └── templates/settings.json
└── scripts/
    ├── extract_all.py
    ├── extract_pdf.py
    ├── ocr_pipeline.py
    ├── setup-jre.sh
    └── utils/file_detector.py
```

Ignored runtime directories: `.venv/`, `jre/`, `node_modules/`, `input/`,
`output/`, `temp/`, and `logs/`.

## Processing Strategy

- HWP v5: `libhwp` first, then `hwp5txt`, then direct OLE parsing if needed.
- HWPX: ZIP/XML parsing with `BeautifulSoup` and `lxml`.
- PDF: `pymupdf` for fast text extraction, `pdfplumber` for tables, OCR tools for scanned PDFs.
- HWPX writing: the `hwpx` skill uses the venv python (`~/.anchor/env/.venv`) and a bundled JRE, resolved by `scripts/runtime_paths.py`.

## Verification

```bash
# Health-check the canonical env (venv / node / jre)
bash ~/.anchor/skills/_builtin/envs/default/setup.sh --verify --target ~/.anchor/env

# dev-in-tree system-dependency check
make verify
```

If a runtime is missing, (re)provision with:

```bash
bash ~/.anchor/skills/_builtin/envs/default/setup.sh --target ~/.anchor/env
```

## Env resolution (canonical)

Skill wrappers and `scripts/runtime_paths.py` resolve the python interpreter in
this order — **this is the source of truth; keep the duplicated `find_env_python`
copies in the wrappers in sync with it**:

1. `$SKILL_PYTHON` (caller override)
2. `$ANCHOR_SKILLS_ENV/.venv/bin/python3` (host-injected)
3. `$VIRTUAL_ENV/bin/python3` (active venv)
4. `$HOME/.anchor/env/.venv/bin/python3` (canonical fixed location)
5. repo-local walk-up: `env/.venv`, `envs/default/.venv`, `skills/envs/default/.venv` (dev-in-tree)
6. system `python3` (warning)

The JRE is resolved separately (it is **not** under `~/.anchor/env`):
`$ENV_ROOT/jre` → `~/.anchor/skills/_builtin/envs/default/jre` → dev-in-tree
`skills/envs/default/jre`. The Anchor host injects `ANCHOR_SKILLS_ENV`,
`VIRTUAL_ENV`, `PATH` (`+.venv/bin`), and `NODE_PATH` (`+node_modules`) for
in-app runs; the shell wrappers export the same set so bare CLI sessions match.

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
    ├── setup-node.sh
    └── utils/file_detector.py
```

Ignored runtime directories: `.venv/`, `node/`, `node_modules/`, `input/`,
`output/`, `temp/`, and `logs/`.

## Processing Strategy

- HWP v5: `libhwp` first, then `hwp5txt`, then direct OLE parsing if needed.
- HWPX: ZIP/XML parsing with `BeautifulSoup` and `lxml`.
- PDF: `pymupdf` for fast text extraction, `pdfplumber` for tables, OCR tools for scanned PDFs.
- HWPX writing: use the released native `hwp` binary and its unified exported `hwp` skill tree (minimum `v1.0.0`); verify the selected absolute binary's version before generation, fill, or validation. No bundled JRE.

## Verification

```bash
# Health-check the canonical env (venv / node)
bash ~/.maru/skills/_builtin/envs/default/setup.sh --verify --target ~/.maru/env

# dev-in-tree system-dependency check
make verify
```

If a runtime is missing, (re)provision with:

```bash
bash ~/.maru/skills/_builtin/envs/default/setup.sh --target ~/.maru/env
```

## Env resolution (canonical)

Skill wrappers resolve the python interpreter in this order — **this is the
source of truth; keep the duplicated `find_env_python` copies in the wrappers in
sync with it**:

1. `$SKILL_PYTHON` (caller override)
2. `$MARU_SKILLS_ENV/.venv/bin/python3` (host-injected)
3. `$HOME/.maru/env/.venv/bin/python3` (canonical fixed location)
4. repo-local walk-up: `env/.venv`, `envs/default/.venv`, `skills/envs/default/.venv` (dev-in-tree)
5. system `python3` (warning)

Ambient `$VIRTUAL_ENV` is intentionally ignored as an input so unrelated shell
venvs cannot shadow the Maru runtime. The Maru host injects `MARU_SKILLS_ENV`,
`VIRTUAL_ENV`, `PATH` (`+.venv/bin`), and `NODE_PATH` (`+node_modules`) for
in-app runs; the shell wrappers export the same set so bare CLI sessions match.

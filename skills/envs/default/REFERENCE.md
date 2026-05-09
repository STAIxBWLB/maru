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
- HWPX writing: public `hwpx` skill uses repo-local `env/.venv` and optional `env/jre`.

## Verification

```bash
cd ~/workspace/work/_sys/skills/env
make verify
```

If system packages are missing, install them with the platform package manager
or run `make setup`.

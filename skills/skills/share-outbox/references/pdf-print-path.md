# PDF Print Path (Markdown -> HTML -> Chrome headless)

Outgoing PDFs are produced by printing HTML with Chrome, not by rendering
HWPX. Reason: the hwp-cli PDF renderer cannot continue a table across a page
boundary; every row after the boundary is silently dropped (data loss, not
just visual clipping). Chunking tables only shrinks the loss; it does not
remove it. The browser print engine paginates tables correctly (rows stay
whole, header rows repeat per page).

## Pipeline

Use the bundled script (markdown-it-py based; runs on the shared env, no
extra packages):

```bash
~/.maru/env/.venv/bin/python \
  ~/.maru/skills/share-outbox/scripts/md_to_pdf_chrome.py \
  <src.md> -o <tmp>/<stem>.pdf [--title "문서 제목"]
```

- Chrome/Chromium is auto-detected (macOS app path, then PATH); override
  with `--chrome <bin>` or `CHROME_BIN`. An explicit `--chrome` that does
  not resolve is an error (no silent fallback). Exits with code 2 and a
  fallback hint when no browser is found.
- A leading YAML frontmatter block is stripped before rendering, so
  internal metadata never reaches the outgoing PDF.
- The intermediate HTML goes to a temp file, removed on success and kept
  on failure for debugging; pass `--keep-html` to always keep it.
- `--title` defaults to the first H1 (else the file stem); it is
  HTML-escaped.
- Supported syntax: CommonMark + tables + strikethrough. Footnotes and
  task lists are not rendered (plugins not bundled) and pass through as
  raw text; the page verification step below catches this.

Then verify before staging: read the PDF pages (or render them) and confirm
long tables break between rows with the header repeated, and that the last
row of every table is present. Only then pass the PDF to
`prepare_share_file.py`.

## Print CSS baseline

The stylesheet is embedded in the script (`CSS` constant). The two
load-bearing rules are:

```css
thead { display: table-header-group; }  /* header repeats on every page */
tr { page-break-inside: avoid; }        /* never split a row */
```

Keep them even if the rest of the theme changes. Also relevant:
`@page { size: A4; margin: 18mm 15mm 16mm 15mm }` and
`word-break: keep-all` (keeps Korean words unbroken inside cells). Adjust
the theme by editing the constant, not by post-processing the HTML.

## Fallbacks

- No Chrome on the machine: convert first, then print with LibreOffice if
  installed. Either `md2docx <src.md>` then
  `soffice --headless --convert-to pdf <stem>.docx`, or
  `hwpx styled --markdown <src.md>` then
  `hwpx to-pdf --engine soffice <stem>.hwpx` (LibreOffice cannot import
  raw Markdown as a document).
- Bare `hwpx to-pdf` (engine auto/hwp) is a last resort for table-free
  documents only, and the output pages must be visually verified before
  sending. The table row loss exits 0, so the auto engine's soffice
  fallback never triggers on it.

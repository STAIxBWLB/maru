# PDF Print Path (Markdown -> HTML -> Chrome headless)

Outgoing PDFs are produced by printing HTML with Chrome, not by rendering
HWPX. Reason: the hwp-cli PDF renderer cannot continue a table across a page
boundary; every row after the boundary is silently dropped. Chunking tables
only shrinks the loss; it does not remove it. The browser print engine
paginates tables correctly (rows stay whole, header rows repeat per page).

## Pipeline

1. Markdown -> HTML body with the workspace Python runtime:

   ```bash
   ~/.maru/env/.venv/bin/python - <<'EOF'
   import markdown
   md = open('<src.md>', encoding='utf-8').read()
   body = markdown.markdown(md, extensions=['tables'])
   html = ('<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8">'
           '<title><TITLE></title><style>' + CSS + '</style></head>'
           '<body>' + body + '</body></html>')
   open('<tmp>/<stem>.html', 'w', encoding='utf-8').write(html)
   EOF
   ```

2. Print to PDF with Chrome headless (present on macOS workstations; no
   extra install):

   ```bash
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
     --headless --disable-gpu --no-pdf-header-footer \
     --print-to-pdf="<tmp>/<stem>.pdf" "file://<tmp>/<stem>.html"
   ```

3. Verify before staging: read the PDF pages (or render them) and confirm
   long tables break between rows with the header repeated, and that the
   last row of every table is present. Only then pass the PDF to
   `prepare_share_file.py`.

## Print CSS baseline

```css
@page { size: A4; margin: 18mm 15mm 16mm 15mm; }
* { box-sizing: border-box; }
body { font-family: "Apple SD Gothic Neo", "Malgun Gothic", sans-serif;
       font-size: 9.5pt; line-height: 1.5; color: #111; margin: 0;
       word-break: keep-all; }
h1 { font-size: 17pt; text-align: center; margin: 0 0 14pt; }
h2 { font-size: 12.5pt; margin: 16pt 0 6pt; border-left: 4px solid #1a4f8b;
     padding-left: 7px; page-break-after: avoid; }
h3 { font-size: 10.5pt; margin: 10pt 0 4pt; page-break-after: avoid; }
p, li { margin: 3pt 0; }
ul { padding-left: 16pt; margin: 4pt 0; }
table { width: 100%; border-collapse: collapse; margin: 6pt 0 10pt;
        font-size: 8.6pt; }
thead { display: table-header-group; }   /* header repeats on every page */
tr { page-break-inside: avoid; }         /* never split a row */
th { background: #eef2f7; border: 0.6pt solid #555; padding: 3.5pt 4pt;
     text-align: center; font-weight: 700; }
td { border: 0.6pt solid #777; padding: 3.5pt 4pt; vertical-align: middle; }
td:first-child { white-space: nowrap; font-weight: 600; text-align: center; }
```

The two load-bearing rules are `thead { display: table-header-group }` and
`tr { page-break-inside: avoid }`; keep them even if the rest of the theme
changes. `word-break: keep-all` keeps Korean words unbroken inside cells.

## Fallbacks

- No Chrome on the machine: use LibreOffice if installed
  (`soffice --headless --convert-to pdf`), or `hwpx to-pdf --engine soffice`.
- `hwpx to-pdf` (hwp-cli engine) is a last resort for table-free documents
  only, and the output pages must be visually verified before sending.

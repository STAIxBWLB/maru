# Bundled JRE Writer — pattern, setup, troubleshooting

This document describes the **self-contained Java HWPX writer** integrated into the `hwpx` skill. The pattern was lifted directly from the `tidy` macOS app (`<workspace-root>/dev/tidy/app/resources/hwpx/`) where it was used to give every user identical HWPX output regardless of which Python/Java they had installed.

## Why bundle a JRE

The skill already has `python-hwpx` (NC-licensed) bound through `_sys/skills/env/.venv`. Three problems pushed us toward a parallel Java path:

1. **License**: `python-hwpx` is Non-Commercial. `hwpxlib` (kr.dogfoot) is Apache-2.0, so commercial deliverables can ship with it.
2. **Determinism**: tidy ships a known-good Temurin 21 + hwpxlib 1.0.5 pair so every user produces byte-identical structural output. Reusing that bundle in the skill gives the same guarantee.
3. **System Java drift**: assuming `java` on `$PATH` produces version-skewed bugs (Java 8 vs 17 vs 21 hwpxlib behavior). Bundling sidesteps that entirely.

## Layout

```
_sys/
├── .gitignore                              # excludes env/jre/ and env/.venv/
└── env/
    ├── scripts/setup-jre.sh                # one-shot installer (idempotent)
    ├── jre/                                # ~35 MB, gitignored
    │   └── bin/java                        # Temurin 21.0.10 (arm64 macOS by default)
    └── .venv/                              # existing python-hwpx venv

_sys/skills/skills/hwpx/
├── runtime/                                # ~1.4 MB, committed
│   ├── HwpxWriter.java                     # source (~80 LOC)
│   ├── HwpxWriter.class                    # compiled, Java 21 ABI
│   ├── hwpxlib-1.0.5.jar                   # Hancom HWPX manipulation lib
│   ├── hwpx_template_export.py             # ~730 LOC, HTML→template filler
│   └── templates/
│       ├── report.hwpx
│       ├── gongmun.hwpx
│       ├── minutes.hwpx
│       ├── proposal.hwpx
│       ├── notice.hwpx
│       └── README.md
└── scripts/
    ├── runtime_paths.py                    # path resolver (JRE/jar/templates)
    ├── write_java.py                       # `hwpx write-java` impl + mimetype fix
    ├── export_html.py                      # `hwpx export-html` cascade impl
    └── hwpx_cli.py                         # registers the two new subcommands
```

## Setup

```bash
bash _sys/skills/env/scripts/setup-jre.sh
```

The script is idempotent (skips if `jre/bin/java` already runs) and tries two paths in order:

1. **Donor copy**: if `<workspace-root>/dev/tidy/app/resources/hwpx/jre` exists, `cp -R` from there. This is the offline path used during initial bring-up.
2. **Temurin download**: otherwise, fetches the latest Temurin 21 JRE for the host OS/arch from `https://api.adoptium.net/v3/binary/latest/21/ga/{os}/{arch}/jre/hotspot/normal/eclipse` and unpacks it.

Currently arm64 macOS / x64 macOS / arm64 Linux / x64 Linux are recognized. Windows is not yet wired up (PR welcome).

## Runtime invocation

`write_java.py::write_java(output, lines)` shells out to:

```
$JAVA_BIN -cp $HWPXLIB_JAR:$WRITER_CLASS_DIR HwpxWriter <output.hwpx>
```

with stdin = `\n`-joined `H1:/H2:/H3:/P:` lines (UTF-8). Then `_normalize_mimetype()` re-zips the result so the `mimetype` entry is the **first** entry and **STORED** — hwpxlib emits it as DEFLATE which Hancom Office tolerates but our `validate` command (and EPUB/OWPML convention) rejects.

`export_html.py::export_html(html, out, template_id)` is a 3-stage cascade matching tidy's `document:export-hwp` IPC handler (`ipc-handlers.js:2756–2807`). On any Stage's failure, the next is tried; only if all three fail does it raise.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `bundled-JRE writer 자산 누락` | `_sys/skills/env/jre/` missing or corrupt | `bash _sys/skills/env/scripts/setup-jre.sh` |
| `validate FAIL: mimetype이 STORED 아님` | Old build before `_normalize_mimetype` was wired | Re-run `write-java`; the post-process runs every time now |
| `HwpxWriter failed (exit 1): NoClassDefFoundError` | classpath wrong (jar moved or renamed) | Confirm `runtime/hwpxlib-1.0.5.jar` exists; bump version pin in `runtime_paths.py` |
| `export-html` always falls through to Stage 2 | Stage 1 raising silently | Run `./hwpx write-java <out>` directly to surface the JRE error |
| Wrong arch ("Bad CPU type") | tidy donor was arm64 but host is x86_64 | Delete `_sys/skills/env/jre/`, re-run `setup-jre.sh` so it falls through to Temurin download for the host arch |
| Want a newer hwpxlib | Pinned 1.0.5 in code | Drop new jar in `runtime/`, update jar path constant in `runtime_paths.py`, smoke-test `write-java`, commit |

## What was deliberately NOT ported

tidy's `ipc-handlers.js` has another ~1500 LOC of JS post-processing (`htmlToHwpxBlocks`, `rewriteHwpxWithBlocks`, `enhanceEditableHwpxStyles`, `enhanceFilledTemplateHwpx`) that preserve table cell merges, header background colors, font sizes, etc. That layer is intentionally out of scope for the first port — Stage 2 (python-hwpx + tidy template helper) covers most of the same ground via placeholder substitution and label-cell matching. If/when we need raw HTML→styled-HWPX without templates, that work would land in `export_html.py::_try_bundled` as a richer block model.

## Cross-references

- `references/library-landscape.md` — comparison of hwpxlib vs python-hwpx vs pyhwpx vs pyhwp.
- `references/hwpx-structure.md` — why mimetype STORED matters.
- `references/raw-zip-fallback.md` — pure-python HWPX manipulation when neither library is available.
- tidy source: `<workspace-root>/dev/tidy/app/electron/ipc-handlers.js:2754–2908`, `<workspace-root>/dev/tidy/app/resources/hwpx/`.

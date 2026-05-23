# Bundled Java Writer — pattern, setup, troubleshooting

This document describes the **self-contained Java HWPX writer** integrated into the `hwpx` skill. The pattern was lifted directly from the `tidy` macOS app (`<workspace-root>/dev/tidy/app/resources/hwpx/`) where it was used to give every user identical HWPX output regardless of which Python/Java they had installed.

## Why bundle Java

The skill uses bundled OpenJDK + hwpxlib for generation. Two problems pushed us toward this path:

1. **Determinism**: tidy ships a known-good Temurin 21 + hwpxlib 1.0.5 pair so every user produces byte-identical structural output. Reusing that bundle in the skill gives the same guarantee.
2. **System Java drift**: assuming `java` on `$PATH` produces version-skewed bugs (Java 8 vs 17 vs 21 hwpxlib behavior). Bundling sidesteps that entirely.

## Layout

```
skills/envs/default/
├── .gitignore                              # excludes jre/ and .venv/
├── scripts/
│   └── setup-jre.sh                        # one-shot installer (idempotent)
├── jre/                                    # gitignored Temurin 21 JDK runtime
│   └── bin/java
└── .venv/                                  # shared Python utilities

skills/skills/hwpx/
├── runtime/                                # ~1.4 MB, committed
│   ├── HwpxWriter.java                     # source (~80 LOC)
│   ├── HwpxWriter.class                    # optional compiled class
│   ├── hwpxlib-1.0.5.jar                   # Hancom HWPX manipulation lib
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
bash skills/envs/default/scripts/setup-jre.sh
```

The script is idempotent when `jre/bin/java` includes the `jdk.compiler` module required for Java source-file launch.

It fetches the latest Temurin 21 JDK for the host OS/arch from `https://api.adoptium.net/v3/binary/latest/21/ga/{os}/{arch}/jdk/hotspot/normal/eclipse` and unpacks it.

Currently arm64 macOS / x64 macOS / arm64 Linux / x64 Linux are recognized. Windows is not yet wired up (PR welcome).

## Runtime invocation

`write_java.py::write_java(output, lines)` shells out to either the compiled class when present, or Java source-file launch otherwise:

```
$JAVA_BIN -cp $HWPXLIB_JAR:$WRITER_CLASS_DIR HwpxWriter <output.hwpx>
$JAVA_BIN -cp $HWPXLIB_JAR:$WRITER_CLASS_DIR HwpxWriter.java <output.hwpx>
```

with stdin = `\n`-joined `H1:/H2:/H3:/P:` lines (UTF-8). Then `_normalize_mimetype()` re-zips the result so the `mimetype` entry is the **first** entry and **STORED** — hwpxlib emits it as DEFLATE which Hancom Office tolerates but our `validate` command (and EPUB/OWPML convention) rejects.

`export_html.py::export_html(html, out, template_id)` is a 2-stage cascade inspired by tidy's `document:export-hwp` IPC handler (`ipc-handlers.js:2756–2807`). On Stage 1 failure, the optional pypandoc fallback is tried; only if both fail does it raise.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `bundled Java runtime 미설치` | `skills/envs/default/jre/` missing or corrupt | `bash skills/envs/default/scripts/setup-jre.sh` |
| `validate FAIL: mimetype이 STORED 아님` | Old build before `_normalize_mimetype` was wired | Re-run `write-java`; the post-process runs every time now |
| `HwpxWriter failed (exit 1): NoClassDefFoundError` | classpath wrong (jar moved or renamed) | Confirm `runtime/hwpxlib-1.0.5.jar` exists; bump version pin in `runtime_paths.py` |
| `export-html` falls through to pypandoc | Stage 1 raising silently | Run `./hwpx write-java <out>` directly to surface the JRE error |
| Wrong arch ("Bad CPU type") | runtime arch differs from host | Delete `skills/envs/default/jre/`, re-run `setup-jre.sh` so it downloads for the host arch |
| Want a newer hwpxlib | Pinned 1.0.5 in code | Drop new jar in `runtime/`, update jar path constant in `runtime_paths.py`, smoke-test `write-java`, commit |

## What was deliberately NOT ported

tidy's `ipc-handlers.js` has another ~1500 LOC of JS post-processing (`htmlToHwpxBlocks`, `rewriteHwpxWithBlocks`, `enhanceEditableHwpxStyles`, `enhanceFilledTemplateHwpx`) that preserve table cell merges, header background colors, font sizes, etc. That layer is intentionally out of scope for the first port. If/when we need raw HTML→styled-HWPX without templates, that work would land in `export_html.py::_try_bundled` as a richer block model.

## Cross-references

- `references/library-landscape.md` — comparison of raw ZIP/XML, hwpxlib, pyhwpx, and pyhwp.
- `references/hwpx-structure.md` — why mimetype STORED matters.
- `references/raw-zip-fallback.md` — pure-python HWPX manipulation when neither library is available.
- tidy source: `<workspace-root>/dev/tidy/app/electron/ipc-handlers.js:2754–2908`, `<workspace-root>/dev/tidy/app/resources/hwpx/`.

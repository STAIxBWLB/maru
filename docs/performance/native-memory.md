# Native memory measurement (issue #327)

Procedure and evidence for sustained WebContent memory usage in the real,
release-mode macOS app. Chromium e2e and the browser dev shell prove
lifecycle behaviour (what gets mounted, torn down, or suspended); they prove
nothing about WKWebView memory. Only the numbers in this document's tables,
captured with the harness below, count as memory evidence.

## Harness

`scripts/measure-native-memory.py` (python3 stdlib, macOS only, read-only).

```bash
python3 scripts/measure-native-memory.py \
  --label graph-open-close-30x --duration 600 --interval 5 \
  --note "release 1.1.8 candidate, fixture graph 1.2k nodes / 3.4k edges, 3 tabs" \
  --out docs/performance/native-memory-<scenario>.jsonl
```

- Attribution: WebKit helpers (WebContent, GPU, Networking) are children of
  launchd, so the script attributes them through
  `responsibility_get_pid_responsible_for_pid` (libquarantine), the relation
  the shared process coalition is built on. Helper pid changes between samples
  are reported as restarts per role, so a WebContent reset never reads as a
  memory drop.
- Metrics per process per sample:
  - `phys_footprint`: `/usr/bin/footprint`, the number Activity Monitor's
    Memory column approximates and Jetsam accounts against (includes
    compressed pages and graphics memory charged to the process).
  - `phys_footprint_peak`: lifetime maximum of that process identity.
  - `rss_bytes`: `ps` RSS. Excludes compressed and swapped pages, counts shared
    pages fully. Never compare RSS with footprint or Activity Monitor totals.
  - JS heap size is not observable from outside WebContent and is never
    equated with either metric.
- Safety: sampling stops when reclaimable memory (free + inactive +
  speculative + purgeable pages from `vm_stat`) drops below `--min-free-mib`
  (default 1024). Do not intentionally reproduce a machine-wide OOM.
- Output: one JSON line per sample plus a `summary` line with start / peak /
  end footprint, sample count, and process identities per role. Record only
  counts, sizes, and timings; never document contents or personal paths.

## Scenarios

Every scenario is run against a release-mode build (`pnpm tauri:build`, never
the `native-e2e` feature), on the same machine, with the same synthetic
fixture workspace, after a two-minute warm-up, at least three repeated runs.
Record app build, OS, fixture size, graph node/edge counts, open tabs, visible
mode, elapsed time, and the sampling interval in `--note`.

| scenario | what to do while sampling | what to read |
|---|---|---|
| idle startup | open the fixture, wait 5 min | end footprint per role, no restarts |
| graph open / hide / reopen | 30 cycles: open panel graph, switch to terminal tab, wait past the grace period, switch back; then idle 2 min | end vs start footprint after the idle; helper restarts |
| graph updates while hidden | hide the graph, edit or add 20 notes, reveal | footprint delta at reveal; derivation runs once |
| HTML preview open-edit-close | 30 cycles on a large HTML document | end vs start footprint; no monotonic growth |
| mode / workspace switching | cycle every mode adapter 10 times, switch workspace twice | footprint and restarts |
| 60-minute mixed soak | interleave all of the above for 60 min | peak, end, restarts |

## Regression gate (proposed, from #327)

After warm-up, 30 graph or preview open-close cycles followed by a two-minute
idle must stay within `max(256 MiB, 10% of warm baseline)` of the starting
attributed footprint (app + WebContent + GPU). Fixture-specific active-surface
peak budgets are established from the first three complete runs; any change to
the gate updates #327 with evidence.

## What the code change covers

- Closing the tool panel while Graph is the selected surface now unmounts the
  graph node (`graphPanelMounted` in `src/lib/graphSurfaceVisibility.ts`).
  Before, `graphMounted` stayed true on that exact transition and the Sigma
  renderer, WebGL contexts, and FA2 worker outlived the panel.
- A hidden graph surface (panel open, terminal tab active) stops the layout
  worker at once, freezes the entry set so model derivation and the enrichment
  overlay do not rerun for edits made while hidden, and after
  `GRAPH_SUSPEND_GRACE_MS` (30 s) unmounts the WebGL canvas. GraphView state
  (selection, filters, local focus, cached positions) and a camera snapshot
  survive, so reveal reconstructs without a layout rerun when topology is
  unchanged.
- Regression coverage: `src/lib/graphSurfaceVisibility.test.ts` (mount rule,
  grace override, deferred suspend) and the two `#327` cases in
  `e2e/graph-shell.spec.ts` (close-while-selected releases the renderer bridge;
  hidden surface suspends and restores).

## Baseline captured in this PR

Installed release build **1.1.7**, the user's real workspace already open,
no interaction during sampling, 90 s at 5 s intervals, 18 samples
(`docs/performance/native-memory-baseline-1.1.7-idle.jsonl`, label
`idle-installed-1.1.7`, macOS 27.0, Apple silicon). This is an
observation of a long-running session, not a controlled idle-startup run: the
process had been running for hours with unknown prior interaction.

| role | pid stable | footprint start | footprint end | lifetime peak (`phys_footprint_peak`) | RSS (first sample) |
|---|---|---|---|---|---|
| app (`maru`) | yes | 82 MiB | 82 MiB | 390 MiB | 78 MiB |
| WebContent | yes | 6,007 MiB | 6,011 MiB | 8,556 MiB | 822 MiB |
| GPU | yes | 71 MiB | 71 MiB | 492 MiB | 43 MiB |
| Networking | yes | 7 MiB | 7 MiB | 7 MiB | 5 MiB |

Reading: a single WebContent process sitting at roughly 6 GiB while idle,
with a lifetime peak of 8.4 GiB, is consistent with the reported ~10 GB
incident and with the Jetsam snapshot in #327 (3.9 GiB current, 7.3 GiB peak
the day before). It does not identify the retaining path. The RSS column shows
why RSS is not the metric: 822 MiB resident versus 6 GiB footprint means most
of that footprint is compressed or otherwise not resident.

## Not done in this PR (open acceptance criteria)

- No before/after release-mode comparison: the branch has not been built as a
  release app and measured against 1.1.7 on the same fixture.
- No repeated runs and no 60-minute soak.
- No profiling of the HTML preview / `HtmlVisualEditor` retention path; no
  product change was made there.
- The incident itself remains unreproduced. Claims are limited to the
  verified close-path defect, the hidden-surface lifecycle, and the baseline
  observation above.

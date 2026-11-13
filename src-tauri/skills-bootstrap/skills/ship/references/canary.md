# Canary

Apply this file when the run will deploy (`/ship`, `/ship deploy`) a repository
with a deployed web surface: capture the baseline before the change reaches
production, then observe and compare after the stage 5 deploy signal. It
extends stage 5 Verify and is never a merge gate. A repository with no web
surface (API-only, library, CLI) skips it; write `Canary: not applicable
(<reason>)` in the report.

## Inputs

Read routes, observation window, interval, and thresholds from the
repository's runbook. Where the runbook is silent, use these defaults and mark
each one `(default)` in the report:

- Routes: the production origin root plus up to four same-origin links from its
  main navigation.
- Window: 3 minutes after the deploy signal, one round every 60 seconds.
- Load-time anomaly: slower than baseline by both 50% and 1 second.

Resolve the production origin as stage 5 does (deploy workflow
`environment.url`, platform config, or README).

## Observation rules

Every check is read-only. Load pages with GET and probe links with HEAD; never
submit forms, sign in, or probe or follow a link whose path suggests a state change
(logout, delete, unsubscribe, cancel). A route that needs sign-in is listed as
unverified scope instead of being visited.

For each route, record:

- HTTP status of the page itself.
- Console errors, by message text, so a new error is distinguishable from one
  the baseline already had.
- Broken same-origin links: links on the page whose HEAD returns 404. Any other
  failure is `unknown`, not broken.
- Load time.

Use whatever page-check tool the host already has (browser automation, a
headless page tool, or HTTP requests). When no tool can read the console,
record console errors as unverified rather than zero. Measure baseline and
observation with the same tool, since load-time figures from different tools
do not compare.

## Baseline

Capture before production changes: at stage 1, before the merge, because a
push-triggered or git-integration deploy starts at the merge. With
`/ship deploy`, capture before the dispatch. Record the time, the origin, and
which deployment was live when the platform reports it (deployment id or
commit). With `--all`, one baseline before the first merge covers the run.

Keep the baseline in the session; this procedure writes no files. In
`/ship check` and `--dry-run`, list the routes and their source without
requesting them.

A baseline that does not exist, failed, or was captured after production
changed is not a baseline. The report section is then titled
`Canary: current-state check`, reports observed values only, and makes no
before/after claim and no regression verdict.

## Observation and classification

After the stage 5 signal confirms the deploy, run rounds over the window,
checking every route each round and comparing it to its baseline:

- New anomaly: status turns non-2xx, a console error absent from the
  baseline, a new broken link, or a load-time anomaly. Values the baseline
  already had are not anomalies.
- One-off: seen in a single round and gone in the next.
- Repeated: seen in two or more rounds, consecutive or not.
- Recovered incident: repeated, then cleared before the window ended. Keep it
  in the report; recovery does not erase it.

When an anomaly first appears in the final round, run one more round before
classifying it. A repeated anomaly still present at the end of the window goes
at the top of the report. Canary reports; it never rolls back, redeploys, or
reverts.

## Report fields

Fill the Canary section of the Ship Report:

- Baseline: captured this run, with time and live deployment; or `none`, with
  the section titled current-state check.
- Routes: each route, with `(default)` when not from the runbook; window and
  interval actually run.
- Per-route deltas: baseline -> latest for status, console error count with new
  messages quoted, broken links, load time.
- Anomalies: each one classified one-off or repeated, with the round(s) seen.
- Recovered incidents.
- Unverified scope: routes behind sign-in, anything the tool could not read,
  and always permissions, data integrity, and external delivery (mail,
  webhooks, jobs). These are never inferred from page state.

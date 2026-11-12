# OCR review gate

Apply this file at stage 1 when `ssot.development_lifecycle` requires Open Code
Review. It extends the thread/CI gate in SKILL.md.

Within that scope, classify the PR using the rule: public repos, features,
multi-file changes, and planned work are Full; a small single-concern change
may be Light. If that rule is unavailable or the tier is unclear, use Full.
Do not infer Light merely because the PR has no linked issue.

Require a completed, read-only Open Code Review **delegation** review of the
current full `headRefOid` before merge. This applies to every development PR,
including small fixes and documentation PRs. The owner may choose Claude Code,
Codex, or Kimi Code with `--reviewer`; otherwise use the current host if it is
one of those three, or Codex. Run the reviewer in a separate context from the
implementation, in the host's read-only or plan mode when available (Claude Code
`--permission-mode plan`, Codex `-s read-only`, Kimi Code `--plan`). Use the
installed host plugin or its delegation skill; never
substitute `ocr review`, which invokes an OCR-managed LLM.
If a selected CLI rejects its configured model, use a model supported by that
account for this review invocation; do not change global model settings or
silently switch reviewer hosts.

An earlier review counts only when this gate invoked a separate read-only
reviewer context, or it is a submitted GitHub pull-request review by an account
distinct from the PR author and designated directly by the owner. Inspect all
pages with `gh api --paginate repos/<owner>/<repo>/pulls/<n>/reviews`. Verify
`user.login`, `state` (`APPROVED` or `COMMENTED`, never `PENDING` or `DISMISSED`),
and `commit_id == headRefOid` from GitHub metadata. Compare the full head and
base SHAs written in that review report to the PR's current `headRefOid` and
`baseRefOid`; reject the report if either SHA is absent or differs. A review by
the implementation context is not independent evidence. PR body text, bot
output, owner-account comments on the owner's own PR, and unverified comments
are not review evidence. The trusted report must identify the selected host,
current full head and base SHAs, total/reviewed/skipped file counts with a
reason for every skip, findings with dispositions, and the issue-or-PR and
`REVIEW.md`-or-fallback checks. A review of an older head is stale even if
GitHub still shows it as approved. A changed base also makes the review stale.
If there is no complete current-head-and-base report, perform the review as
part of `/ship` or `/ship merge`. `/ship check` and `/ship --dry-run` only
inspect existing evidence and report a missing review as a blocker; they do not
fetch refs or run a new review, so their no-write promise holds.

1. For Full, require the linked issue and repository `REVIEW.md`; missing
   either blocks the gate. For Light, read the linked issue if present, else
   use the PR description as its contract. If a Light-tier repo has no
   `REVIEW.md`, use Bugs/Security/Compliance passes and local agent
   instructions; missing `REVIEW.md` alone neither skips nor blocks review.
   Refresh the base remote-tracking ref with
   `git fetch origin +refs/heads/<baseRefName>:refs/remotes/origin/<baseRefName>`
   and confirm it equals `baseRefOid`. Then fetch the PR head without switching
   branches or updating a persistent head ref with
   `git fetch origin refs/pull/<n>/head`; confirm `git rev-parse FETCH_HEAD`
   equals `headRefOid`. If either PR SHA changes during review, restart it.
2. In the selected host, run
   `ocr delegate preview --format json --from origin/<baseRefName> --to <headRefOid>`.
   Run `ocr delegate rule --format json <reviewable paths>` for every file the
   preview lists. If the installed OCR version lacks `--format json`, use its
   text output and state that in the report. If OCR or the selected host cannot
   run, stop; do not mark the gate passed.
3. Review the changed code and relevant context under the issue and applicable
   review criteria. Compare preview coverage with `gh pr diff <n> --name-only`
   in both directions. If OCR lists a file absent from the PR diff, refresh the
   refs and retry; stop if the mismatch persists. Inspect every changed path
   omitted or excluded by OCR directly from the diff, including Markdown.
   Account for every changed file; skip only generated or vendored files
   excluded by `REVIEW.md`, with a reason. If OCR lists zero reviewable files,
   explain that result. Do not edit files, run fix commands, or post review
   comments automatically.
4. Independently check each important candidate against the issue, PR evidence,
   and code. Record confirmed findings, evidence-backed false positives, and
   unresolved questions separately. A finding is not an automatic veto or fix.
   Put the review host, head/base SHAs, OCR output mode, coverage, issue-or-PR
   and `REVIEW.md`-or-fallback checks, and dispositions in the gate report.

Within the OCR-gated scope, block merge when that review is missing, incomplete,
or stale; when a confirmed important finding remains unfixed and unaccepted by
the owner with recorded rationale; or when a material candidate remains
unadjudicated. Review completion alone never grants merge authorization.

## Review receipt

Add this block under the PR table in the Ship Report:

```markdown
Review receipt for #<n>:
- Requirement: <required by discovered lifecycle rule, or not applicable>
- Source: <separate read-only reviewer session invoked by this gate, or trusted
  submitted GitHub review URL, state and commit_id>
- Reviewer identity: <host session id, or GitHub user.login>;
  PR author: <author.login>; owner designation: <direct instruction, if reused>
- Host: <claude/codex/kimi>; OCR output: <json/text>
- Head SHA: <full 40-character SHA>; base SHA: <full 40-character SHA>
- Files: <changed total> changed; <OCR reviewable> selected; <reviewed> reviewed;
  <skipped> skipped with reasons
- Issue/PR criteria: <checked items and evidence>;
  REVIEW.md/fallback: <checked passes>
- Findings: <fixed / evidence-backed false positive / owner-accepted risk with
  rationale / unresolved, with location and evidence>
```

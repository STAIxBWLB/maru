import * as Dialog from "@radix-ui/react-dialog";
import { GitCommit, GitPullRequest, WandSparkles, X } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import {
  gitChanges,
  gitCommit,
  gitDiff,
  gitGenerateCommitMessage,
  gitSyncCommitPush,
  gitSyncPullRebase,
  gitSyncScan,
  type AgentProvider,
} from "../lib/api";
import { useTranslation } from "../lib/i18n";
import type { GitFileChange, GitStatus } from "../lib/types";
import { Button } from "./ui/Button";

const GIT_SYNC_COMMIT_PUSH_APPROVAL_KIND = "git.sync.commit_push";

function lineClass(line: string): string {
  if (line.startsWith("@@")) return "diff-line hunk";
  if (line.startsWith("+++") || line.startsWith("---")) return "diff-line meta";
  if (line.startsWith("+")) return "diff-line add";
  if (line.startsWith("-")) return "diff-line del";
  return "diff-line ctx";
}

interface Props {
  open: boolean;
  vaultPath: string | null;
  status: GitStatus | null;
  aiRuntime: AgentProvider;
  aiCommandOverride?: string | null;
  onConfirmApproval: (input: {
    kind: string;
    summary: string;
    target?: string | null;
    payloadPreview?: string | null;
  }) => Promise<string | null>;
  onClose: () => void;
  onCommitted: (next: GitStatus) => void;
}

/** Stages the selected changes and creates a commit via the user's local git binary.
 *  Hooks (pre-commit, commit-msg) run as configured — we don't pass
 *  --no-verify, so a hook failure surfaces here for the user to resolve. */
export function CommitDialog({
  open,
  vaultPath,
  status,
  aiRuntime,
  aiCommandOverride,
  onConfirmApproval,
  onClose,
  onCommitted,
}: Props) {
  const { t } = useTranslation();
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [autoCommitting, setAutoCommitting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<GitFileChange[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [syncReport, setSyncReport] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setMessage("");
    setError(null);
    setSubmitting(false);
    setGenerating(false);
    setAutoCommitting(false);
    setSyncing(false);
    setFiles([]);
    setExpanded(null);
    setDiff(null);
    setSyncReport([]);
    if (!vaultPath) return;
    let cancelled = false;
    gitChanges(vaultPath)
      .then((next) => {
        if (!cancelled) {
          setFiles(next);
          setSelectedPaths(new Set(next.map((file) => file.path)));
        }
      })
      .catch(() => {
        // Soft-fail: dialog still works without the file list.
      });
    return () => {
      cancelled = true;
    };
  }, [open, vaultPath]);

  function toggleDiff(file: GitFileChange) {
    if (!vaultPath) return;
    if (expanded === file.path) {
      setExpanded(null);
      setDiff(null);
      return;
    }
    setExpanded(file.path);
    setDiff(null);
    setDiffLoading(true);
    gitDiff(vaultPath, file.path)
      .then((text) => {
        setDiff(text);
      })
      .catch((err) => {
        setDiff(`! ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => setDiffLoading(false));
  }

  async function submit() {
    if (!vaultPath) return;
    const trimmed = message.trim();
    if (!trimmed) {
      setError(t("commit.error.emptyMessage"));
      return;
    }
    const paths = Array.from(selectedPaths);
    if (paths.length === 0) {
      setError(t("commit.error.emptySelection"));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const next = await gitCommit(vaultPath, trimmed, paths);
      onCommitted(next);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function generateMessage(): Promise<string | null> {
    if (!vaultPath) return null;
    const paths = Array.from(selectedPaths);
    if (paths.length === 0) {
      setError(t("commit.error.emptySelection"));
      return null;
    }
    setGenerating(true);
    setError(null);
    try {
      const generated = await gitGenerateCommitMessage(
        vaultPath,
        paths,
        aiRuntime,
        aiCommandOverride ?? null,
      );
      setMessage(generated);
      return generated;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return null;
    } finally {
      setGenerating(false);
    }
  }

  async function autoCommit() {
    if (!vaultPath) return;
    const paths = Array.from(selectedPaths);
    if (paths.length === 0) {
      setError(t("commit.error.emptySelection"));
      return;
    }
    setAutoCommitting(true);
    setError(null);
    try {
      const generated = await gitGenerateCommitMessage(
        vaultPath,
        paths,
        aiRuntime,
        aiCommandOverride ?? null,
      );
      setMessage(generated);
      const next = await gitCommit(vaultPath, generated, paths);
      onCommitted(next);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAutoCommitting(false);
    }
  }

  async function runGitSync() {
    if (!vaultPath) return;
    setSyncing(true);
    setError(null);
    setSyncReport([]);
    const append = (line: string) => setSyncReport((current) => [...current, line]);
    let currentRepo = "scan";
    try {
      const scan = await gitSyncScan(vaultPath, false);
      append(`SYNC_ROOT: ${scan.syncRoot}`);
      append(`CONFIRM_BEFORE_COMMIT: ${scan.confirmBeforeCommit ? "yes" : "no"}`);
      for (const item of scan.excluded) {
        append(`SKIP ${item.path}: ${item.reason}`);
      }
      for (const repo of scan.repos) {
        currentRepo = repo.relPath;
        append(`PULL ${repo.relPath}`);
        const pull = await gitSyncPullRebase(repo.path);
        append(`PULL_OK ${repo.relPath}: ${pull.stashed ? "stashed local changes" : "no local stash"}`);
        const pullNoise = [pull.stderr, pull.stdout]
          .join("\n")
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .slice(0, 3);
        for (const line of pullNoise) append(`PULL_LOG ${repo.relPath}: ${line}`);
      }
      const postPull = await gitSyncScan(vaultPath, false);
      let committed = 0;
      for (const repo of postPull.repos) {
        currentRepo = repo.relPath;
        if (repo.clean || repo.paths.length === 0) {
          append(`CLEAN ${repo.relPath}`);
          continue;
        }
        const generated = await gitGenerateCommitMessage(
          repo.path,
          repo.paths,
          aiRuntime,
          aiCommandOverride ?? null,
        );
        const approvalId = await onConfirmApproval({
          kind: GIT_SYNC_COMMIT_PUSH_APPROVAL_KIND,
          summary: t("commit.sync.approvalSummary", { repo: repo.relPath }),
          target: repo.path,
          payloadPreview: [
            generated,
            "",
            ...repo.paths.map((path) => `- ${path}`),
          ].join("\n"),
        });
        if (!approvalId) {
          append(`CANCEL ${repo.relPath}`);
          break;
        }
        append(`COMMIT ${repo.relPath}: ${generated}`);
        await gitSyncCommitPush({
          repoPath: repo.path,
          message: generated,
          paths: repo.paths,
          approvalId,
        });
        append(`PUSH ${repo.relPath}: ok`);
        committed += 1;
      }
      const next = await gitSyncScan(vaultPath, false);
      append(t("commit.sync.done", { count: committed.toString() }));
      onCommitted({
        isRepo: true,
        modified: next.repos.reduce((sum, repo) => sum + (repo.clean ? 0 : repo.changes), 0),
        staged: 0,
        untracked: 0,
        untrackedKnown: true,
        clean: next.repos.every((repo) => repo.clean),
        branch: status?.branch ?? null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      append(`ERROR ${currentRepo}: ${message}`);
      setError(message);
    } finally {
      setSyncing(false);
    }
  }

  const fileCounts =
    files.length > 0
      ? {
          staged: files.filter((file) => file.staged).length,
          modified: files.filter((file) => !file.staged && !file.untracked).length,
          untracked: files.filter((file) => file.untracked).length,
        }
      : null;
  const summary = fileCounts ?? status;
  const total = summary
    ? summary.modified + summary.staged + summary.untracked
    : 0;

  function renderDiff(text: string): React.ReactNode {
    if (!text) return null;
    return text.split("\n").map((line, idx) => {
      const cls = lineClass(line);
      return (
        <span key={idx} className={cls}>
          {line}
          {"\n"}
        </span>
      );
    });
  }

  function toggleSelected(path: string) {
    setSelectedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content commit-dialog">
          <div className="dialog-header">
            <Dialog.Title>{t("commit.title")}</Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="icon-button"
                aria-label={t("dialog.close")}
                title={t("dialog.close")}
              >
                <X size={14} />
              </button>
            </Dialog.Close>
          </div>

          {summary ? (
            <div className="commit-summary">
              <span className="commit-branch">{status?.branch ?? "—"}</span>
              <span className="commit-counts">
                {t("commit.summary", {
                  staged: summary.staged.toString(),
                  modified: summary.modified.toString(),
                  untracked: summary.untracked.toString(),
                  total: total.toString(),
                })}
              </span>
            </div>
          ) : null}

          {files.length > 0 ? (
            <>
              <div className="commit-selection-summary">
                {t("commit.selected", {
                  selected: selectedPaths.size.toString(),
                  total: files.length.toString(),
                })}
              </div>
              <ul className="commit-files">
                {files.map((file) => {
                const isOpen = expanded === file.path;
                return (
                  <li
                    key={file.path}
                    className={
                      file.untracked
                        ? "commit-file untracked"
                        : file.staged
                          ? "commit-file staged"
                          : "commit-file modified"
                    }
                  >
                    <div className="commit-file-row">
                      <input
                        type="checkbox"
                        className="commit-file-check"
                        checked={selectedPaths.has(file.path)}
                        onChange={() => toggleSelected(file.path)}
                        aria-label={t("commit.file.include", { path: file.path })}
                      />
                      <button
                        type="button"
                        className="commit-file-open"
                        onClick={() => toggleDiff(file)}
                        title={`${file.indexStatus}${file.worktreeStatus} ${file.path}`}
                      >
                        <span className="commit-file-status">
                          {file.untracked
                            ? "?"
                            : file.staged
                              ? file.indexStatus.trim() || "•"
                              : file.worktreeStatus.trim() || "•"}
                        </span>
                        <span className="commit-file-path">{file.path}</span>
                      </button>
                    </div>
                    {isOpen ? (
                      <pre className="commit-file-diff">
                        {diffLoading ? "…" : renderDiff(diff ?? "")}
                      </pre>
                    ) : null}
                  </li>
                );
                })}
              </ul>
            </>
          ) : null}

          <label className="commit-label">
            <span className="commit-label-row">
              <span>{t("commit.message.label")}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void generateMessage()}
                disabled={generating || submitting || autoCommitting || syncing || selectedPaths.size === 0}
                icon={<WandSparkles size={13} />}
              >
                {generating ? t("commit.generate.loading") : t("commit.generate")}
              </Button>
            </span>
            <textarea
              className="commit-message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder={t("commit.message.placeholder")}
              rows={4}
              autoFocus
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
          </label>

          {error ? <div className="commit-error">{error}</div> : null}
          {syncReport.length > 0 ? (
            <pre className="commit-sync-report">{syncReport.join("\n")}</pre>
          ) : null}

          <div className="dialog-actions">
            <Dialog.Close asChild>
              <Button variant="ghost">{t("dialog.cancel")}</Button>
            </Dialog.Close>
            <Button
              variant="ghost"
              onClick={() => void runGitSync()}
              disabled={syncing || submitting || autoCommitting || generating}
              icon={<GitPullRequest size={14} />}
            >
              {syncing ? t("commit.sync.running") : t("commit.sync")}
            </Button>
            <Button
              variant="ghost"
              onClick={() => void autoCommit()}
              disabled={syncing || submitting || autoCommitting || generating || selectedPaths.size === 0}
              icon={<WandSparkles size={14} />}
            >
              {autoCommitting ? t("commit.auto.running") : t("commit.auto")}
            </Button>
            <Button
              variant="primary"
              onClick={() => void submit()}
              disabled={syncing || submitting || autoCommitting || generating || !message.trim() || selectedPaths.size === 0}
              icon={<GitCommit size={14} />}
            >
              {submitting ? t("commit.submitting") : t("commit.submit")}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

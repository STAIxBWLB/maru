import * as Dialog from "@radix-ui/react-dialog";
import { GitCommit, X } from "lucide-react";
import { useEffect, useState } from "react";
import { gitChanges, gitCommit, gitDiff } from "../lib/api";
import { useTranslation } from "../lib/i18n";
import type { GitFileChange, GitStatus } from "../lib/types";
import { Button } from "./ui/Button";

interface Props {
  open: boolean;
  vaultPath: string | null;
  status: GitStatus | null;
  onClose: () => void;
  onCommitted: (next: GitStatus) => void;
}

/** Stages all changes and creates a commit via the user's local git binary.
 *  Hooks (pre-commit, commit-msg) run as configured — we don't pass
 *  --no-verify, so a hook failure surfaces here for the user to resolve. */
export function CommitDialog({ open, vaultPath, status, onClose, onCommitted }: Props) {
  const { t } = useTranslation();
  const [message, setMessage] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [files, setFiles] = useState<GitFileChange[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    setMessage("");
    setError(null);
    setSubmitting(false);
    setFiles([]);
    setExpanded(null);
    setDiff(null);
    if (!vaultPath) return;
    let cancelled = false;
    gitChanges(vaultPath)
      .then((next) => {
        if (!cancelled) setFiles(next);
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
    setSubmitting(true);
    setError(null);
    try {
      const next = await gitCommit(vaultPath, trimmed);
      onCommitted(next);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  const total = status
    ? status.modified + status.staged + status.untracked
    : 0;

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
              <button type="button" className="icon-button" aria-label={t("dialog.close")}>
                <X size={14} />
              </button>
            </Dialog.Close>
          </div>

          {status ? (
            <div className="commit-summary">
              <span className="commit-branch">{status.branch ?? "—"}</span>
              <span className="commit-counts">
                {t("commit.summary", {
                  staged: status.staged.toString(),
                  modified: status.modified.toString(),
                  untracked: status.untracked.toString(),
                  total: total.toString(),
                })}
              </span>
            </div>
          ) : null}

          {files.length > 0 ? (
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
                    <button
                      type="button"
                      className="commit-file-row"
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
                    {isOpen ? (
                      <pre className="commit-file-diff">
                        {diffLoading ? "…" : diff ?? ""}
                      </pre>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}

          <label className="commit-label">
            {t("commit.message.label")}
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

          <div className="dialog-actions">
            <Dialog.Close asChild>
              <Button variant="ghost">{t("dialog.cancel")}</Button>
            </Dialog.Close>
            <Button
              variant="primary"
              onClick={() => void submit()}
              disabled={submitting || !message.trim()}
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

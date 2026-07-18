import { GitBranch, GitCommit, PencilLine, Plus, Sigma } from "lucide-react";
import { useEffect, useState } from "react";
import { gitStatus, gitStatusFast } from "../lib/api";
import { formatGitStatusDisplay } from "../lib/gitStatusDisplay";
import { useTranslation } from "../lib/i18n";
import type { GitStatus } from "../lib/types";

interface Props {
  vaultPath: string | null;
  enabled: boolean;
  /** Bump this number to force a re-poll (after save/snapshot/refresh). */
  refreshTrigger: number;
  /** Invoked with the latest status when the user clicks a dirty badge —
   *  parent opens the commit dialog. Clean badges do nothing on click. */
  onCommitClick?: (status: GitStatus) => void;
}

/** Topbar badge showing the active workspace's branch + dirty count. Hides
 *  itself when the workspace isn't a git repo so non-versioned workspaces don't
 *  show stale "no branch" text. */
export function GitStatusBadge({ vaultPath, enabled, refreshTrigger, onCommitClick }: Props) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<GitStatus | null>(null);

  useEffect(() => {
    if (!vaultPath || !enabled) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    let pollSeq = 0;
    function poll() {
      if (!vaultPath) return;
      const requestSeq = ++pollSeq;
      let fullApplied = false;
      let fastApplied = false;
      gitStatusFast(vaultPath)
        .then((next) => {
          if (!cancelled && requestSeq === pollSeq && !fullApplied) {
            fastApplied = true;
            setStatus(next);
          }
        })
        .catch(() => {
          if (!cancelled && requestSeq === pollSeq && !fullApplied) setStatus(null);
        });
      gitStatus(vaultPath)
        .then((next) => {
          if (!cancelled && requestSeq === pollSeq) {
            fullApplied = true;
            setStatus(next);
          }
        })
        .catch(() => {
          if (!cancelled && requestSeq === pollSeq && !fastApplied) setStatus(null);
        });
    }
    poll();
    // Catch external state changes — user committing in a terminal,
    // editing a file outside maru, etc. Refresh whenever the window
    // regains focus or visibility.
    function onVisible() {
      if (document.visibilityState === "visible") poll();
    }
    window.addEventListener("focus", poll);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [vaultPath, enabled, refreshTrigger]);

  if (!status || !status.isRepo) return null;

  const display = formatGitStatusDisplay(status);

  const className = display.dirty ? "git-badge dirty" : "git-badge clean";
  const content = (
    <>
      <GitBranch size={10} />
      <span className="git-badge-branch">{display.branch}</span>
      {display.dirty && !display.pendingUntracked ? (
        <>
          <span className="git-badge-metric" title={t("git.badge.staged")}>
            <GitCommit size={9} />
            <span>{display.staged}</span>
          </span>
          <span className="git-badge-metric" title={t("git.badge.modified")}>
            <PencilLine size={9} />
            <span>{display.modified}</span>
          </span>
          <span className="git-badge-metric" title={t("git.badge.new")}>
            <Plus size={10} />
            <span>{display.untracked}</span>
          </span>
          <span className="git-badge-metric total" title={t("git.badge.total")}>
            <Sigma size={9} />
            <span>{display.total}</span>
          </span>
        </>
      ) : null}
      {display.pendingUntracked ? <span className="git-badge-count">~</span> : null}
    </>
  );

  if (display.dirty && onCommitClick) {
    const handleClick = async () => {
      if (vaultPath && !status.untrackedKnown) {
        try {
          const next = await gitStatus(vaultPath);
          setStatus(next);
          onCommitClick(next);
          return;
        } catch {
          // Fall back to the last badge status so the click remains useful.
        }
      }
      onCommitClick(status);
    };
    return (
      <button
        type="button"
        className={className}
        title={display.tooltip}
        aria-label={display.tooltip}
        onClick={handleClick}
      >
        {content}
      </button>
    );
  }

  return (
    <span className={className} title={display.tooltip} aria-label={display.tooltip}>
      {content}
    </span>
  );
}

import { GitBranch } from "lucide-react";
import { useEffect, useState } from "react";
import { gitStatusFast } from "../lib/api";
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
  const [status, setStatus] = useState<GitStatus | null>(null);

  useEffect(() => {
    if (!vaultPath || !enabled) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    function poll() {
      if (!vaultPath) return;
      gitStatusFast(vaultPath)
        .then((next) => {
          if (!cancelled) setStatus(next);
        })
        .catch(() => {
          if (!cancelled) setStatus(null);
        });
    }
    poll();
    // Catch external state changes — user committing in a terminal,
    // editing a file outside anchor, etc. Refresh whenever the window
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

  const total = status.modified + status.staged + status.untracked;
  const dirty = !status.clean;
  const untrackedText = status.untrackedKnown
    ? `${status.untracked} untracked`
    : "untracked not counted";
  const tooltip = dirty
    ? `${status.branch ?? "—"} · ${status.staged} staged · ${status.modified} modified · ${untrackedText} · click to commit`
    : `${status.branch ?? "—"} · tracked clean · ${untrackedText}`;

  const className = dirty ? "git-badge dirty" : "git-badge clean";
  const content = (
    <>
      <GitBranch size={11} />
      <span className="git-badge-branch">{status.branch ?? "—"}</span>
      {dirty ? <span className="git-badge-count">{total}</span> : null}
      {!status.untrackedKnown ? <span className="git-badge-count">~</span> : null}
    </>
  );

  if (dirty && onCommitClick) {
    return (
      <button
        type="button"
        className={className}
        title={tooltip}
        aria-label={tooltip}
        onClick={() => onCommitClick(status)}
      >
        {content}
      </button>
    );
  }

  return (
    <span className={className} title={tooltip} aria-label={tooltip}>
      {content}
    </span>
  );
}

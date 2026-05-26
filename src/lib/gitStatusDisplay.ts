import type { GitStatus } from "./types";

export interface GitStatusDisplay {
  branch: string;
  dirty: boolean;
  total: number;
  staged: number;
  modified: number;
  untracked: number;
  tooltip: string;
  pendingUntracked: boolean;
}

export function formatGitStatusDisplay(status: GitStatus): GitStatusDisplay {
  const branch = status.branch ?? "-";
  const total = status.modified + status.staged + status.untracked;
  const pendingUntracked = !status.untrackedKnown;
  const untrackedText = pendingUntracked ? "checking new files" : `${status.untracked} new`;
  const counts = `${status.staged} staged · ${status.modified} modified · ${untrackedText}`;
  const dirty = !status.clean || pendingUntracked;
  const tooltip = dirty
    ? `${branch} · ${counts}${pendingUntracked ? "" : ` (${total} total)`} · click to commit`
    : `${branch} · tracked clean · ${status.untracked} new`;

  return {
    branch,
    dirty,
    total,
    staged: status.staged,
    modified: status.modified,
    untracked: status.untracked,
    tooltip,
    pendingUntracked,
  };
}

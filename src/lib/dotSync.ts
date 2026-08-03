import type { DotSyncOverview } from "./api";

export type DotSyncBadgeState =
  | "setup"
  | "manual"
  | "scheduled"
  | "paused"
  | "syncing"
  | "attention";

export interface DotSyncBadge {
  state: DotSyncBadgeState;
  scheduledJobs: number;
}

function jobNeedsAttention(intervalSeconds: number, state: string): boolean {
  return intervalSeconds > 0 && state !== "running";
}

export function deriveDotSyncBadge(overview: DotSyncOverview | null): DotSyncBadge {
  if (!overview || !overview.cli.available || !overview.cli.compatible) {
    return { state: "setup", scheduledJobs: 0 };
  }

  const mirror = overview.mirror;
  const peer = overview.peer;
  const mirrorConfigured = Boolean(mirror?.configured);
  const peerConfigured = Boolean(peer?.profile.configured);
  if (!mirrorConfigured && !peerConfigured) {
    return { state: "setup", scheduledJobs: 0 };
  }

  const mirrorJobs = mirrorConfigured ? mirror?.jobs ?? [] : [];
  const peerJobs = peerConfigured && peer ? [peer.job] : [];
  const scheduledJobs = [...mirrorJobs, ...peerJobs].filter(
    (job) => job.intervalSeconds > 0,
  ).length;

  if (mirror?.lockHeld || peer?.profile.lockHeld) {
    return { state: "syncing", scheduledJobs };
  }

  const mirrorAttention = Boolean(
    mirrorConfigured &&
      mirror &&
      (!mirror.localExists ||
        (mirror.target.kind === "local" && !mirror.targetExists) ||
        !mirror.canPush ||
        mirror.conflictCount > 0 ||
        mirrorJobs.some((job) => jobNeedsAttention(job.intervalSeconds, job.state))),
  );
  const peerAttention = Boolean(
    peerConfigured &&
      peer &&
      ((peer.lastExitCode !== null && peer.lastExitCode !== 0) ||
        jobNeedsAttention(peer.job.intervalSeconds, peer.job.state)),
  );
  if (mirrorAttention || peerAttention) {
    return { state: "attention", scheduledJobs };
  }
  if (mirror?.paused) {
    return { state: "paused", scheduledJobs };
  }
  return {
    state: scheduledJobs > 0 ? "scheduled" : "manual",
    scheduledJobs,
  };
}

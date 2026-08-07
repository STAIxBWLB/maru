import { useSyncExternalStore } from "react";
import type { MissionStatus } from "./types";

/** Live progress snapshot for a per-source processing mission. */
export interface MissionProgress {
  missionId: string;
  status: MissionStatus;
  startedAt: string;
  latestActivity: string | null;
}

const LOG_PREFIX = /^\[(?:stdout|stderr)\]\s?/;

/**
 * The most recent non-empty log line with its `[stdout] `/`[stderr] ` stream
 * prefix stripped, or null when there is no output yet.
 */
export function latestActivityLine(lines?: string[]): string | null {
  if (!lines) return null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const cleaned = lines[index].replace(LOG_PREFIX, "").trim();
    if (cleaned.length > 0) return cleaned;
  }
  return null;
}

/** Compact elapsed label: `"5s"`, `"1m 05s"`, `"1h 02m"`. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

let elapsedNow = Date.now();
const elapsedSubscribers = new Set<() => void>();
let elapsedTimer: ReturnType<typeof setInterval> | null = null;

function publishElapsedNow(): void {
  elapsedNow = Date.now();
  for (const subscriber of elapsedSubscribers) subscriber();
}

function startElapsedTimer(): void {
  if (elapsedTimer) return;
  publishElapsedNow();
  elapsedTimer = setInterval(publishElapsedNow, 1000);
}

function stopElapsedTimer(): void {
  if (!elapsedTimer) return;
  clearInterval(elapsedTimer);
  elapsedTimer = null;
}

function subscribeElapsed(subscriber: () => void): () => void {
  elapsedSubscribers.add(subscriber);
  if (elapsedSubscribers.size === 1) startElapsedTimer();
  return () => {
    elapsedSubscribers.delete(subscriber);
    if (elapsedSubscribers.size === 0) stopElapsedTimer();
  };
}

function subscribeElapsedIdle(): () => void {
  return () => {};
}

/**
 * Live elapsed label since `startIso`, re-rendering once per second while
 * `active`. Returns null when inactive or the timestamp is unparseable, and
 * clears its interval when `active` flips false or the component unmounts.
 *
 * Inactive consumers subscribe to a noop so rows for finished missions do
 * not keep the shared 1 Hz timer alive.
 */
export function useElapsed(startIso: string | null, active: boolean): string | null {
  const start = startIso != null ? Date.parse(startIso) : Number.NaN;
  const enabled = active && !Number.isNaN(start);
  const now = useSyncExternalStore(
    enabled ? subscribeElapsed : subscribeElapsedIdle,
    () => elapsedNow,
    () => elapsedNow,
  );
  if (!enabled) return null;
  return formatElapsed(now - start);
}

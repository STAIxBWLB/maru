import { useEffect, useState } from "react";
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

/**
 * Live elapsed label since `startIso`, re-rendering once per second while
 * `active`. Returns null when inactive or the timestamp is unparseable, and
 * clears its interval when `active` flips false or the component unmounts.
 */
export function useElapsed(startIso: string | null, active: boolean): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active, startIso]);
  if (!active || !startIso) return null;
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return null;
  return formatElapsed(now - start);
}

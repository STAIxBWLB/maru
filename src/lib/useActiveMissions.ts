import { useSyncExternalStore } from "react";

import { isTauri, listAiMissions } from "./api";
import { isTrackedAgentMission } from "./skillRuns";
import type { MissionRecord } from "./types";

const MAX_ACTIVE_MISSIONS = 20;
const MAX_TRACKED_MISSIONS = 80;

let activeMissions: MissionRecord[] = [];
let trackedMissions: MissionRecord[] = [];
const subscribers = new Set<() => void>();
let listening = false;
let listenerGeneration = 0;
let unlisten: (() => void) | null = null;

function isActiveMission(mission: MissionRecord): boolean {
  return mission.status === "idle" || mission.status === "running";
}

function sortAndCap(records: MissionRecord[]): MissionRecord[] {
  return records
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, MAX_ACTIVE_MISSIONS);
}

export function activeMissionSnapshot(records: MissionRecord[]): MissionRecord[] {
  const byId = new Map<string, MissionRecord>();
  for (const record of records) byId.set(record.id, record);
  return sortAndCap([...byId.values()].filter(isActiveMission));
}

export function nextActiveMissionSnapshot(
  current: MissionRecord[],
  next: MissionRecord,
): MissionRecord[] {
  const withoutCurrent = current.filter((mission) => mission.id !== next.id);
  return isActiveMission(next)
    ? sortAndCap([next, ...withoutCurrent])
    : sortAndCap(withoutCurrent);
}

function sortAndCapTracked(records: MissionRecord[]): MissionRecord[] {
  return records
    .sort(
      (a, b) =>
        b.lastOutputAt.localeCompare(a.lastOutputAt) ||
        b.startedAt.localeCompare(a.startedAt),
    )
    .slice(0, MAX_TRACKED_MISSIONS);
}

export function trackedMissionSnapshot(records: MissionRecord[]): MissionRecord[] {
  return sortAndCapTracked(records.filter(isTrackedAgentMission));
}

export function nextTrackedMissionSnapshot(
  current: MissionRecord[],
  next: MissionRecord,
): MissionRecord[] {
  return trackedMissionSnapshot([next, ...current.filter((mission) => mission.id !== next.id)]);
}

function publish(active: MissionRecord[], tracked: MissionRecord[]): void {
  activeMissions = active;
  trackedMissions = tracked;
  for (const subscriber of subscribers) subscriber();
}

/** Feeds an externally observed record (e.g. the result of stop_ai_mission)
 *  into both slices, exactly as if it had arrived on ai://mission_update. */
export function ingestMissionUpdate(record: MissionRecord): void {
  publish(
    nextActiveMissionSnapshot(activeMissions, record),
    isTrackedAgentMission(record)
      ? nextTrackedMissionSnapshot(trackedMissions, record)
      : trackedMissions,
  );
}

function stopListening(): void {
  listening = false;
  listenerGeneration += 1;
  unlisten?.();
  unlisten = null;
}

function startListening(): void {
  if (listening) return;
  listening = true;
  const generation = ++listenerGeneration;
  const eventsBeforeInitialLoad: MissionRecord[] = [];
  let initialLoaded = false;

  void (async () => {
    if (isTauri()) {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const off = await listen<MissionRecord>("ai://mission_update", (event) => {
          if (!listening || generation !== listenerGeneration) return;
          if (!initialLoaded) eventsBeforeInitialLoad.push(event.payload);
          publish(
            nextActiveMissionSnapshot(activeMissions, event.payload),
            isTrackedAgentMission(event.payload)
              ? nextTrackedMissionSnapshot(trackedMissions, event.payload)
              : trackedMissions,
          );
        });
        if (!listening || generation !== listenerGeneration) {
          off();
          return;
        }
        unlisten = off;
      } catch {
        // The initial list below still provides a useful ambient snapshot.
      }
    }

    try {
      const records = await listAiMissions();
      let active = activeMissionSnapshot(records);
      let tracked = trackedMissionSnapshot(records);
      for (const event of eventsBeforeInitialLoad) {
        active = nextActiveMissionSnapshot(active, event);
        if (isTrackedAgentMission(event)) {
          tracked = nextTrackedMissionSnapshot(tracked, event);
        }
      }
      if (listening && generation === listenerGeneration) publish(active, tracked);
    } catch {
      // The status is ambient; a transient list failure should not surface globally.
    } finally {
      initialLoaded = true;
    }
  })();
}

function subscribe(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  if (subscribers.size === 1) startListening();
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) stopListening();
  };
}

function getSnapshot(): MissionRecord[] {
  return activeMissions;
}

function getTrackedSnapshot(): MissionRecord[] {
  return trackedMissions;
}

export function useActiveMissions(): MissionRecord[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useTrackedMissions(): MissionRecord[] {
  return useSyncExternalStore(subscribe, getTrackedSnapshot, getTrackedSnapshot);
}

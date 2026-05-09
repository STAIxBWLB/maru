import { CircleStop, Loader2, PauseCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { listAiMissions, stopAiMission } from "../lib/api";
import type { MissionRecord } from "../lib/types";

export function MissionBadge({ onError }: { onError?: (message: string) => void }) {
  const [missions, setMissions] = useState<MissionRecord[]>([]);

  useEffect(() => {
    let cancelled = false;
    void listAiMissions()
      .then((records) => {
        if (!cancelled) setMissions(records);
      })
      .catch(() => {});
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<MissionRecord>("ai://mission_update", (event) => {
          setMissions((current) => upsertMission(current, event.payload));
        }),
      )
      .then((off) => {
        if (cancelled) off();
        else unlisten = off;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const active = useMemo(
    () => missions.find((mission) => mission.status === "idle" || mission.status === "running"),
    [missions],
  );
  if (!active) return null;

  const idle = active.status === "idle";
  return (
    <div className={`mission-badge ${idle ? "idle" : "running"}`} title={active.id}>
      {idle ? <PauseCircle size={14} /> : <Loader2 size={14} className="spin" />}
      <span>{idle ? "Idle" : "Running"}</span>
      <button
        type="button"
        className="icon-button"
        aria-label="Stop mission"
        title="Stop mission"
        onClick={() => {
          void stopAiMission(active.id).catch((err) => {
            onError?.(err instanceof Error ? err.message : String(err));
          });
        }}
      >
        <CircleStop size={13} />
      </button>
    </div>
  );
}

function upsertMission(current: MissionRecord[], next: MissionRecord): MissionRecord[] {
  const exists = current.some((mission) => mission.id === next.id);
  const merged = exists
    ? current.map((mission) => (mission.id === next.id ? next : mission))
    : [next, ...current];
  return merged.sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 8);
}

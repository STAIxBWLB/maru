import { Clock3, Square } from "lucide-react";
import type { MissionRecord } from "../../lib/types";

export function ProcessingMissionsPanel({
  missions,
  logLines,
  onStop,
  emptyLabel = "No active inbox process.",
}: {
  missions: MissionRecord[];
  logLines: Record<string, string[]>;
  onStop: (id: string) => void | Promise<void>;
  emptyLabel?: string;
}) {
  return (
    <div className="processing-panel">
      {missions.length === 0 ? (
        <div className="processing-empty">
          <Clock3 size={16} />
          <span>{emptyLabel}</span>
        </div>
      ) : null}
      {missions.map((mission) => {
        const lines = logLines[mission.id] ?? [];
        const channel = inboxProcessChannel(mission);
        return (
          <article className={`processing-card ${mission.status}`} key={mission.id}>
            <div className="processing-card-header">
              <div>
                <strong>{channel ? `inbox-process ${channel}` : "inbox-process"}</strong>
                <span>{mission.status} · {mission.startedAt}</span>
              </div>
              <button
                type="button"
                className="button button-ghost button-sm"
                onClick={() => void onStop(mission.id)}
                title="Stop processing"
              >
                <Square size={12} />
                <span>Stop</span>
              </button>
            </div>
            <pre className="processing-log">
              {lines.length > 0 ? lines.join("\n") : "Waiting for output..."}
            </pre>
          </article>
        );
      })}
    </div>
  );
}

export function inboxProcessChannel(mission: MissionRecord): string | null {
  const metadata = mission.metadata;
  if (
    typeof metadata === "object" &&
    metadata !== null &&
    "channel" in metadata &&
    typeof metadata.channel === "string"
  ) {
    return metadata.channel;
  }
  return null;
}

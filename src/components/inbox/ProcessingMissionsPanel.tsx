import { Clock3, Square } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "../../lib/i18n";
import { useElapsed } from "../../lib/missionProgress";
import type { MissionRecord } from "../../lib/types";
import { formatShortDate } from "./processedFormat";

const EMPTY_LINES: string[] = [];

export function ProcessingMissionsPanel({
  missions,
  logLines,
  onStop,
  emptyLabel,
  waitingLabel,
}: {
  missions: MissionRecord[];
  logLines: Record<string, string[]>;
  onStop: (id: string) => void | Promise<void>;
  emptyLabel?: string;
  waitingLabel?: string;
}) {
  const { t } = useTranslation();
  const resolvedEmptyLabel = emptyLabel ?? t("inbox.missions.empty");
  const resolvedWaitingLabel = waitingLabel ?? t("inbox.missions.waiting");
  return (
    <div className="processing-panel">
      {missions.length === 0 ? (
        <div className="processing-empty">
          <Clock3 size={16} />
          <span>{resolvedEmptyLabel}</span>
        </div>
      ) : null}
      {missions.map((mission) => (
        <MissionCard
          key={mission.id}
          mission={mission}
          lines={logLines[mission.id] ?? EMPTY_LINES}
          waitingLabel={resolvedWaitingLabel}
          onStop={onStop}
        />
      ))}
    </div>
  );
}

function MissionCard({
  mission,
  lines,
  waitingLabel,
  onStop,
}: {
  mission: MissionRecord;
  lines: string[];
  waitingLabel: string;
  onStop: (id: string) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const logRef = useRef<HTMLPreElement>(null);
  const active = mission.status === "running" || mission.status === "idle";
  const elapsed = useElapsed(mission.startedAt, active);
  const channel = inboxProcessChannel(mission);
  // Keep the newest output in view as lines stream in.
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);
  return (
    <article className={`processing-card ${mission.status}`}>
      <div className="processing-card-header">
        <div>
          <strong>{channel ? `inbox-process ${channel}` : "inbox-process"}</strong>
          <span>
            {mission.status} · {elapsed ?? formatShortDate(mission.startedAt)}
          </span>
        </div>
        <button
          type="button"
          className="button button-ghost button-sm"
          onClick={() => void onStop(mission.id)}
          title={t("mission.stop")}
        >
          <Square size={12} />
          <span>{t("inbox.progress.stop")}</span>
        </button>
      </div>
      <pre className="processing-log" ref={logRef}>
        {lines.length > 0 ? lines.join("\n") : waitingLabel}
      </pre>
    </article>
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

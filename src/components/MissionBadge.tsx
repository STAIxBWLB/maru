import { CircleStop, Loader2, PauseCircle } from "lucide-react";
import { stopAiMission } from "../lib/api";
import { setError } from "../lib/errorStore";
import { useTranslation } from "../lib/i18n";
import { useActiveMissions } from "../lib/useActiveMissions";

export function MissionBadge() {
  const { t } = useTranslation();
  const [active] = useActiveMissions();
  if (!active) return null;

  const idle = active.status === "idle";
  return (
    <div className={`mission-badge ${idle ? "idle" : "running"}`} title={active.id}>
      {idle ? <PauseCircle size={14} /> : <Loader2 size={14} className="spin" />}
      <span>{idle ? t("mission.status.idle") : t("mission.status.running")}</span>
      <button
        type="button"
        className="icon-button"
        aria-label={t("mission.stop")}
        title={t("mission.stop")}
        onClick={() => {
          void stopAiMission(active.id).catch((err) => {
            setError(err instanceof Error ? err.message : String(err));
          });
        }}
      >
        <CircleStop size={13} />
      </button>
    </div>
  );
}

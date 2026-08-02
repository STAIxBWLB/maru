import { RefreshCcw, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { readWorkspaceConfig } from "../../../lib/maruDir";
import { useTranslation } from "../../../lib/i18n";
import type { MaruSettings } from "../../../lib/settings";
import { applyWorkspaceMeetingsOverrides, normalizeMaruSettings } from "../../../lib/settings";
import type { WorkspaceConfig } from "../../../lib/types";
import { MeetingsSettingsTab } from "../../meetings/MeetingsSettingsTab";
import { Button } from "../../ui/Button";
import { ModeHeader } from "../../ui/ModeChrome";

export function MeetingsSettingsSystemTab({
  workPath,
  settings,
  onSettingsChange,
}: {
  workPath: string;
  settings: MaruSettings;
  onSettingsChange: (settings: MaruSettings) => void;
}) {
  const { t } = useTranslation();
  const [workspaceConfig, setWorkspaceConfig] = useState<WorkspaceConfig | null>(null);
  const [draftMeetings, setDraftMeetings] = useState(settings.meetings);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const effectiveMeetings = useMemo(
    () => applyWorkspaceMeetingsOverrides(settings.meetings, workspaceConfig),
    [settings.meetings, workspaceConfig],
  );
  const dirty = JSON.stringify(draftMeetings) !== JSON.stringify(settings.meetings);

  useEffect(() => {
    setDraftMeetings(settings.meetings);
  }, [settings.meetings]);

  useEffect(() => {
    let cancelled = false;
    void readWorkspaceConfig(workPath)
      .then((next) => {
        if (!cancelled) setWorkspaceConfig(next);
      })
      .catch(() => {
        if (!cancelled) setWorkspaceConfig(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workPath]);

  const save = () => {
    setError(null);
    setStatus(null);
    try {
      onSettingsChange(
        normalizeMaruSettings({
          ...settings,
          meetings: draftMeetings,
        }),
      );
      setStatus(t("system.rules.saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="settings-tab">
      <ModeHeader
        title={t("system.tab.meetings")}
        subtitle={t("meetings.settings")}
        actions={
          <>
            <span className={dirty ? "save-state dirty" : "save-state saved"}>
              {dirty ? t("system.rules.dirty") : t("system.rules.saved")}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraftMeetings(settings.meetings);
                setStatus(null);
                setError(null);
              }}
              icon={<RefreshCcw size={14} />}
            >
              Refresh
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!dirty}
              onClick={save}
              icon={<Save size={14} />}
            >
              {t("system.rules.save")}
            </Button>
          </>
        }
      />
      {error ? <div className="inbox-error">{error}</div> : null}
      {status ? <div className="save-state saved">{status}</div> : null}
      <MeetingsSettingsTab
        settings={draftMeetings}
        effectiveSettings={effectiveMeetings}
        onSettingsChange={(meetings) => {
          setDraftMeetings(meetings);
          setStatus(null);
        }}
      />
    </div>
  );
}

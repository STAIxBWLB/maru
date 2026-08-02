import { RefreshCcw, Save } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { readWorkspaceConfig } from "../../../lib/maruDir";
import { useTranslation } from "../../../lib/i18n";
import type { MaruSettings } from "../../../lib/settings";
import { applyWorkspaceTasksOverrides, normalizeMaruSettings } from "../../../lib/settings";
import type { WorkspaceConfig } from "../../../lib/types";
import { TasksSettingsTab } from "../../tasks/TasksSettingsTab";
import { Button } from "../../ui/Button";
import { ModeHeader } from "../../ui/ModeChrome";

export function TasksSettingsSystemTab({
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
  const [draftTasks, setDraftTasks] = useState(settings.tasks);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const effectiveTasks = useMemo(
    () => applyWorkspaceTasksOverrides(settings.tasks, workspaceConfig),
    [settings.tasks, workspaceConfig],
  );
  const dirty = JSON.stringify(draftTasks) !== JSON.stringify(settings.tasks);

  useEffect(() => {
    setDraftTasks(settings.tasks);
  }, [settings.tasks]);

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
          tasks: draftTasks,
        }),
      );
      setStatus(t("system.rules.saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="settings-tab" style={{ width: "100%" }}>
      <ModeHeader
        title={t("system.tab.tasks")}
        actions={
          <>
            <span className={dirty ? "save-state dirty" : "save-state saved"}>
              {dirty ? t("system.rules.dirty") : t("system.rules.saved")}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraftTasks(settings.tasks);
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
      <TasksSettingsTab
        settings={draftTasks}
        effectiveSettings={effectiveTasks}
        onSettingsChange={(tasks) => {
          setDraftTasks(tasks);
          setStatus(null);
        }}
      />
    </div>
  );
}

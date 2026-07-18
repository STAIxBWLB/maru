import type { TasksSettings } from "../../lib/settings";
import { useTranslation } from "../../lib/i18n";

interface TasksSettingsTabProps {
  settings: TasksSettings;
  effectiveSettings?: TasksSettings;
  onSettingsChange: (settings: TasksSettings) => void;
}

export function TasksSettingsTab({
  settings,
  effectiveSettings,
  onSettingsChange,
}: TasksSettingsTabProps) {
  const { t } = useTranslation();
  const update = (patch: Partial<TasksSettings>) => onSettingsChange({ ...settings, ...patch });
  const updateHook = (key: keyof TasksSettings["hooks"], value: boolean) =>
    update({ hooks: { ...settings.hooks, [key]: value } });
  return (
    <div className="settings-form tasks-settings-form">
      <section className="settings-section-panel">
        <div className="settings-section-heading">
          <div>
            <strong>{t("tasks.settings.path.title")}</strong>
            <span>{t("tasks.settings.path.description")}</span>
          </div>
        </div>
        <label className="field checkbox-field">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(event) => update({ enabled: event.target.checked })}
          />
          <span>{t("tasks.settings.enabled")}</span>
        </label>
        <div className="settings-grid two">
          <label className="field">
            <span>{t("tasks.settings.root")}</span>
            <input
              value={settings.root ?? ""}
              placeholder={effectiveSettings?.root ?? "tasks"}
              onChange={(event) => update({ root: event.target.value.trim() || null })}
            />
          </label>
          <label className="field">
            <span>{t("tasks.settings.timezone")}</span>
            <input
              value={settings.timezone ?? ""}
              placeholder={effectiveSettings?.timezone ?? "Asia/Seoul"}
              onChange={(event) => update({ timezone: event.target.value.trim() || null })}
            />
          </label>
        </div>
        <label className="field">
          <span>{t("tasks.settings.gwsBinary")}</span>
          <input
            value={settings.gwsBinary ?? ""}
            placeholder={effectiveSettings?.gwsBinary ?? ""}
            onChange={(event) => update({ gwsBinary: event.target.value.trim() || null })}
          />
        </label>
      </section>

      <section className="settings-section-panel">
        <div className="settings-section-heading">
          <div>
            <strong>{t("tasks.settings.display.title")}</strong>
            <span>{t("tasks.settings.display.description")}</span>
          </div>
        </div>
        <div className="settings-grid three">
          <label className="field">
            <span>{t("tasks.settings.defaultView")}</span>
            <select
              value={settings.defaultView}
              onChange={(event) =>
                update({ defaultView: event.target.value as TasksSettings["defaultView"] })
              }
            >
              <option value="list">{t("tasks.display.list")}</option>
              <option value="month">{t("tasks.calendar.month")}</option>
              <option value="week">{t("tasks.calendar.week")}</option>
              <option value="day">{t("tasks.calendar.day")}</option>
            </select>
          </label>
          <label className="field">
            <span>{t("tasks.settings.weekStartsOn")}</span>
            <select
              value={settings.weekStartsOn}
              onChange={(event) =>
                update({ weekStartsOn: Number(event.target.value) === 0 ? 0 : 1 })
              }
            >
              <option value={1}>{t("tasks.settings.weekStartsOnMonday")}</option>
              <option value={0}>{t("tasks.settings.weekStartsOnSunday")}</option>
            </select>
          </label>
          <label className="field">
            <span>{t("tasks.settings.calendarStartHour")}</span>
            <input
              type="number"
              min={0}
              max={23}
              value={settings.calendarStartHour}
              onChange={(event) =>
                update({
                  calendarStartHour: Math.max(0, Math.min(23, Number(event.target.value) || 0)),
                })
              }
            />
          </label>
        </div>
      </section>

      <section className="settings-section-panel">
        <div className="settings-section-heading">
          <div>
            <strong>{t("tasks.settings.google.title")}</strong>
            <span>{t("tasks.settings.google.description")}</span>
          </div>
        </div>
        <div className="settings-grid two">
          <label className="field">
            <span>{t("tasks.settings.defaultTaskList")}</span>
            <input
              value={settings.defaultTaskList ?? ""}
              placeholder={effectiveSettings?.defaultTaskList ?? ""}
              onChange={(event) => update({ defaultTaskList: event.target.value.trim() || null })}
            />
          </label>
          <label className="field">
            <span>{t("tasks.settings.defaultCalendar")}</span>
            <input
              value={settings.defaultCalendar ?? ""}
              placeholder={effectiveSettings?.defaultCalendar ?? ""}
              onChange={(event) => update({ defaultCalendar: event.target.value.trim() || null })}
            />
          </label>
        </div>
      </section>

      <section className="settings-section-panel">
        <div className="settings-section-heading">
          <div>
            <strong>{t("tasks.settings.hooks.title")}</strong>
            <span>{t("tasks.settings.hooks.description")}</span>
          </div>
        </div>
        {(["appendVaultLog"] as const).map((key) => (
          <label className="field checkbox-field" key={key}>
            <input
              type="checkbox"
              checked={settings.hooks[key]}
              onChange={(event) => updateHook(key, event.target.checked)}
            />
            <span>{t(`tasks.settings.hooks.${key}`)}</span>
          </label>
        ))}
      </section>
    </div>
  );
}

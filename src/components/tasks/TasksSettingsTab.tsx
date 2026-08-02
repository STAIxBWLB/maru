import type { TasksSettings } from "../../lib/settings";
import { useTranslation } from "../../lib/i18n";
import { CompactSelect } from "../ui/ModeChrome";
import { Toggle } from "../ui/Toggle";
import { SettingsSection } from "../settings/SettingsSection";
import { SettingsRow } from "../settings/SettingsRow";

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
      <SettingsSection
        title={t("tasks.settings.path.title")}
        description={t("tasks.settings.path.description")}
      >
        <SettingsRow
          label={t("tasks.settings.enabled")}
          control={
            <Toggle
              checked={settings.enabled}
              onChange={(enabled) => update({ enabled })}
              aria-label={t("tasks.settings.enabled")}
            />
          }
        />
        <SettingsRow
          label={t("tasks.settings.root")}
          htmlFor="tasks-settings-root"
          control={
            <input
              id="tasks-settings-root"
              value={settings.root ?? ""}
              placeholder={effectiveSettings?.root ?? "tasks"}
              onChange={(event) => update({ root: event.target.value.trim() || null })}
            />
          }
        />
        <SettingsRow
          label={t("tasks.settings.timezone")}
          htmlFor="tasks-settings-timezone"
          control={
            <input
              id="tasks-settings-timezone"
              value={settings.timezone ?? ""}
              placeholder={effectiveSettings?.timezone ?? "Asia/Seoul"}
              onChange={(event) => update({ timezone: event.target.value.trim() || null })}
            />
          }
        />
        <SettingsRow
          label={t("tasks.settings.gwsBinary")}
          htmlFor="tasks-settings-gws-binary"
          control={
            <input
              id="tasks-settings-gws-binary"
              value={settings.gwsBinary ?? ""}
              placeholder={effectiveSettings?.gwsBinary ?? ""}
              onChange={(event) => update({ gwsBinary: event.target.value.trim() || null })}
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        title={t("tasks.settings.display.title")}
        description={t("tasks.settings.display.description")}
      >
        <SettingsRow
          label={t("tasks.settings.defaultView")}
          htmlFor="tasks-settings-default-view"
          control={
            <CompactSelect
              id="tasks-settings-default-view"
              value={settings.defaultView}
              onChange={(event) =>
                update({ defaultView: event.target.value as TasksSettings["defaultView"] })
              }
            >
              <option value="list">{t("tasks.display.list")}</option>
              <option value="month">{t("tasks.calendar.month")}</option>
              <option value="week">{t("tasks.calendar.week")}</option>
              <option value="day">{t("tasks.calendar.day")}</option>
            </CompactSelect>
          }
        />
        <SettingsRow
          label={t("tasks.settings.weekStartsOn")}
          htmlFor="tasks-settings-week-starts-on"
          control={
            <CompactSelect
              id="tasks-settings-week-starts-on"
              value={settings.weekStartsOn}
              onChange={(event) =>
                update({ weekStartsOn: Number(event.target.value) === 0 ? 0 : 1 })
              }
            >
              <option value={1}>{t("tasks.settings.weekStartsOnMonday")}</option>
              <option value={0}>{t("tasks.settings.weekStartsOnSunday")}</option>
            </CompactSelect>
          }
        />
        <SettingsRow
          label={t("tasks.settings.calendarStartHour")}
          htmlFor="tasks-settings-calendar-start-hour"
          control={
            <input
              id="tasks-settings-calendar-start-hour"
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
          }
        />
      </SettingsSection>

      <SettingsSection
        title={t("tasks.settings.google.title")}
        description={t("tasks.settings.google.description")}
      >
        <SettingsRow
          label={t("tasks.settings.defaultTaskList")}
          htmlFor="tasks-settings-default-task-list"
          control={
            <input
              id="tasks-settings-default-task-list"
              value={settings.defaultTaskList ?? ""}
              placeholder={effectiveSettings?.defaultTaskList ?? ""}
              onChange={(event) => update({ defaultTaskList: event.target.value.trim() || null })}
            />
          }
        />
        <SettingsRow
          label={t("tasks.settings.defaultCalendar")}
          htmlFor="tasks-settings-default-calendar"
          control={
            <input
              id="tasks-settings-default-calendar"
              value={settings.defaultCalendar ?? ""}
              placeholder={effectiveSettings?.defaultCalendar ?? ""}
              onChange={(event) => update({ defaultCalendar: event.target.value.trim() || null })}
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        title={t("tasks.settings.hooks.title")}
        description={t("tasks.settings.hooks.description")}
      >
        {(["appendVaultLog"] as const).map((key) => (
          <SettingsRow
            key={key}
            label={t(`tasks.settings.hooks.${key}`)}
            control={
              <Toggle
                checked={settings.hooks[key]}
                onChange={(value) => updateHook(key, value)}
                aria-label={t(`tasks.settings.hooks.${key}`)}
              />
            }
          />
        ))}
      </SettingsSection>
    </div>
  );
}

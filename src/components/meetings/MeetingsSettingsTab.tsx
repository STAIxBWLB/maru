import type { MeetingsSettings } from "../../lib/settings";
import { useTranslation } from "../../lib/i18n";
import { Toggle } from "../ui/Toggle";
import { SettingsSection } from "../settings/SettingsSection";
import { SettingsRow } from "../settings/SettingsRow";

interface MeetingsSettingsTabProps {
  settings: MeetingsSettings;
  effectiveSettings?: MeetingsSettings;
  onSettingsChange: (settings: MeetingsSettings) => void;
}

export function MeetingsSettingsTab({
  settings,
  effectiveSettings,
  onSettingsChange,
}: MeetingsSettingsTabProps) {
  const { t } = useTranslation();
  const update = (patch: Partial<MeetingsSettings>) => onSettingsChange({ ...settings, ...patch });
  const updateGuide = (key: keyof MeetingsSettings["guides"], value: string) =>
    update({ guides: { ...settings.guides, [key]: value.trim() || null } });
  const updateHook = (key: keyof MeetingsSettings["hooks"], value: boolean) =>
    update({ hooks: { ...settings.hooks, [key]: value } });
  return (
    <div className="settings-form meetings-settings-form">
      <SettingsSection
        title={t("meetings.settings.path.title")}
        description={t("meetings.settings.path.description")}
      >
        <SettingsRow
          label={t("meetings.settings.enabled")}
          control={
            <Toggle
              checked={settings.enabled}
              onChange={(enabled) => update({ enabled })}
              aria-label={t("meetings.settings.enabled")}
            />
          }
        />
        <SettingsRow
          label={t("meetings.settings.root")}
          htmlFor="meetings-settings-root"
          control={
            <input
              id="meetings-settings-root"
              value={settings.root ?? ""}
              placeholder={effectiveSettings?.root ?? "meetings"}
              onChange={(event) => update({ root: event.target.value.trim() || null })}
            />
          }
        />
        <SettingsRow
          label={t("meetings.settings.filenameTemplate")}
          htmlFor="meetings-settings-filename-template"
          control={
            <input
              id="meetings-settings-filename-template"
              value={settings.filenameTemplate}
              onChange={(event) => update({ filenameTemplate: event.target.value })}
            />
          }
        />
        {(["quickStart", "glossary", "people", "tagStandards", "notesGuidelines"] as const).map(
          (key) => (
            <SettingsRow
              key={key}
              label={t(`meetings.settings.guides.${key}`)}
              htmlFor={`meetings-settings-guide-${key}`}
              control={
                <input
                  id={`meetings-settings-guide-${key}`}
                  value={settings.guides[key] ?? ""}
                  placeholder={effectiveSettings?.guides[key] ?? ""}
                  onChange={(event) => updateGuide(key, event.target.value)}
                />
              }
            />
          ),
        )}
      </SettingsSection>

      <SettingsSection
        title={t("meetings.settings.hooks.title")}
        description={t("meetings.settings.hooks.description")}
      >
        {(["autoTaskExtract", "autoVaultExtract", "autoVaultConnect", "appendVaultLog"] as const).map(
          (key) => (
            <SettingsRow
              key={key}
              label={t(`meetings.settings.hooks.${key}`)}
              control={
                <Toggle
                  checked={settings.hooks[key]}
                  onChange={(value) => updateHook(key, value)}
                  aria-label={t(`meetings.settings.hooks.${key}`)}
                />
              }
            />
          ),
        )}
      </SettingsSection>

      <SettingsSection
        title={t("meetings.settings.types.title")}
        description={t("meetings.settings.types.description")}
      >
        <SettingsRow
          label={t("meetings.settings.types.default")}
          htmlFor="meetings-settings-default-types"
          control={
            <input
              id="meetings-settings-default-types"
              value={settings.defaultTypes.join(", ")}
              onChange={(event) =>
                update({
                  defaultTypes: event.target.value
                    .split(",")
                    .map((item) => item.trim())
                    .filter(Boolean),
                })
              }
            />
          }
        />
        <SettingsRow
          label={t("meetings.settings.calendarStartHour")}
          htmlFor="meetings-settings-calendar-start-hour"
          control={
            <input
              id="meetings-settings-calendar-start-hour"
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
    </div>
  );
}

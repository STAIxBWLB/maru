import type { MeetingsSettings } from "../../lib/settings";
import { useTranslation } from "../../lib/i18n";

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
      <section className="settings-section-panel">
        <div className="settings-section-heading">
          <div>
            <strong>{t("meetings.settings.path.title")}</strong>
            <span>{t("meetings.settings.path.description")}</span>
          </div>
        </div>
        <label className="field checkbox-field">
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(event) => update({ enabled: event.target.checked })}
          />
          <span>{t("meetings.settings.enabled")}</span>
        </label>
        <div className="settings-grid two">
          <label className="field">
            <span>{t("meetings.settings.root")}</span>
            <input
              value={settings.root ?? ""}
              placeholder={effectiveSettings?.root ?? "meetings"}
              onChange={(event) => update({ root: event.target.value.trim() || null })}
            />
          </label>
          <label className="field">
            <span>{t("meetings.settings.filenameTemplate")}</span>
            <input
              value={settings.filenameTemplate}
              onChange={(event) => update({ filenameTemplate: event.target.value })}
            />
          </label>
        </div>
        <div className="settings-grid two">
          {(["quickStart", "glossary", "people", "tagStandards", "notesGuidelines"] as const).map((key) => (
            <label className="field" key={key}>
              <span>{t(`meetings.settings.guides.${key}`)}</span>
              <input
                value={settings.guides[key] ?? ""}
                placeholder={effectiveSettings?.guides[key] ?? ""}
                onChange={(event) => updateGuide(key, event.target.value)}
              />
            </label>
          ))}
        </div>
      </section>

      <section className="settings-section-panel">
        <div className="settings-section-heading">
          <div>
            <strong>{t("meetings.settings.hooks.title")}</strong>
            <span>{t("meetings.settings.hooks.description")}</span>
          </div>
        </div>
        {(["autoTaskExtract", "autoVaultExtract", "autoVaultConnect", "appendVaultLog"] as const).map((key) => (
          <label className="field checkbox-field" key={key}>
            <input
              type="checkbox"
              checked={settings.hooks[key]}
              onChange={(event) => updateHook(key, event.target.checked)}
            />
            <span>{t(`meetings.settings.hooks.${key}`)}</span>
          </label>
        ))}
      </section>

      <section className="settings-section-panel">
        <div className="settings-section-heading">
          <div>
            <strong>{t("meetings.settings.types.title")}</strong>
            <span>{t("meetings.settings.types.description")}</span>
          </div>
        </div>
        <label className="field">
          <span>{t("meetings.settings.types.default")}</span>
          <input
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
        </label>
        <label className="field">
          <span>{t("meetings.settings.calendarStartHour")}</span>
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
      </section>
    </div>
  );
}

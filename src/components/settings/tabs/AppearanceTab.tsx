// ============================ Appearance ============================

import { useTranslation } from "../../../lib/i18n";
import type { MaruSettings, ThemeMode } from "../../../lib/settings";
import { normalizeMaruSettings } from "../../../lib/settings";
import { normalizeAccentInput } from "../../../lib/theme";
import { ModeHeader, SegmentedControl } from "../../ui/ModeChrome";
import { SettingsSection } from "../SettingsSection";
import { SettingsRow } from "../SettingsRow";

const ACCENT_PRESETS = [
  { value: "#b23a26", labelKey: "system.preferences.accentPreset.seal" },
  { value: "#3d392e", labelKey: "system.preferences.accentPreset.ink" },
  { value: "#33565c", labelKey: "system.preferences.accentPreset.celadon" },
  { value: "#8a5a2c", labelKey: "system.preferences.accentPreset.ochre" },
] as const;

export function AppearanceTab({
  settings,
  onSettingsChange,
}: {
  settings: MaruSettings;
  onSettingsChange: (settings: MaruSettings) => void;
}) {
  const { t } = useTranslation();

  const updateUi = (patch: Partial<MaruSettings["ui"]>) => {
    onSettingsChange(
      normalizeMaruSettings({
        ...settings,
        ui: { ...settings.ui, ...patch },
      }),
    );
  };

  return (
    <div className="settings-tab">
      <ModeHeader
        title={t("system.tab.appearance")}
        subtitle={t("system.appearance.subtitle")}
      />
      <SettingsSection title={t("system.appearance.section.theme")}>
        <SettingsRow
          label={t("system.preferences.themeMode")}
          control={
            <SegmentedControl<ThemeMode>
              label={t("system.preferences.themeMode")}
              value={settings.ui.themeMode}
              onChange={(themeMode) => updateUi({ themeMode })}
              options={[
                { value: "system", label: t("system.preferences.theme.system") },
                { value: "light", label: t("system.preferences.theme.light") },
                { value: "dark", label: t("system.preferences.theme.dark") },
              ]}
            />
          }
        />
        <SettingsRow
          label={t("system.preferences.accentColor")}
          htmlFor="appearance-accent-color"
          control={
            <div className="accent-control">
              <input
                id="appearance-accent-color"
                type="color"
                value={settings.ui.accentColor}
                onChange={(event) =>
                  updateUi({
                    accentColor: normalizeAccentInput(event.target.value, settings.ui.accentColor),
                  })
                }
              />
              {ACCENT_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  className={
                    settings.ui.accentColor === preset.value
                      ? "accent-preset-swatch is-active"
                      : "accent-preset-swatch"
                  }
                  style={{ background: preset.value }}
                  title={t(preset.labelKey)}
                  aria-label={t(preset.labelKey)}
                  aria-pressed={settings.ui.accentColor === preset.value}
                  onClick={() => updateUi({ accentColor: preset.value })}
                />
              ))}
            </div>
          }
        />
      </SettingsSection>
    </div>
  );
}

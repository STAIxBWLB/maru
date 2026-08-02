// ============================ Appearance ============================

import { useTranslation } from "../../../lib/i18n";
import type { MaruSettings, ThemeMode } from "../../../lib/settings";
import { normalizeMaruSettings } from "../../../lib/settings";
import { normalizeAccentInput } from "../../../lib/theme";
import { ModeHeader, SegmentedControl } from "../../ui/ModeChrome";
import { SettingsSection } from "../SettingsSection";
import { SettingsRow } from "../SettingsRow";

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
          }
        />
      </SettingsSection>
    </div>
  );
}

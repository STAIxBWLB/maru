// ============================ Connectors ============================

import { useTranslation } from "../../../lib/i18n";
import type { MaruSettings } from "../../../lib/settings";
import { normalizeMaruSettings } from "../../../lib/settings";
import { ModeHeader } from "../../ui/ModeChrome";
import { SettingsSection } from "../SettingsSection";
import { SettingsJsonTab } from "./SettingsJsonTab";

export function ConnectorsTab({
  settings,
  onSettingsChange,
}: {
  settings: MaruSettings;
  onSettingsChange: (settings: MaruSettings) => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="settings-tab">
      <ModeHeader title={t("system.tab.connectors")} subtitle={t("system.connectors.title")} />
      <SettingsSection title={t("system.connectors.title")} padded>
        <SettingsJsonTab
          value={settings.connectors}
          onSave={(value) =>
            onSettingsChange(
              normalizeMaruSettings({
                ...settings,
                connectors: value,
              }),
            )
          }
        />
      </SettingsSection>
    </div>
  );
}

import { LogIn, Play, Square } from "lucide-react";
import type { CommsSettings } from "../../lib/settings";
import type { TelegramPollingStatus } from "../../lib/types";
import { useTranslation } from "../../lib/i18n";

interface CommsSettingsTabProps {
  settings: CommsSettings;
  pollingStatus: TelegramPollingStatus;
  telegramEnvHealthy: boolean | null;
  onSettingsChange: (settings: CommsSettings) => void;
  onStartPolling: () => void;
  onStopPolling: () => void;
  onTelegramLogin: () => void;
  onOpenSkillsEnvSettings: () => void;
}

export function CommsSettingsTab({
  settings,
  pollingStatus,
  telegramEnvHealthy,
  onSettingsChange,
  onStartPolling,
  onStopPolling,
  onTelegramLogin,
  onOpenSkillsEnvSettings,
}: CommsSettingsTabProps) {
  const { t } = useTranslation();
  const updateOutlook = (patch: Partial<CommsSettings["outlook"]>) =>
    onSettingsChange({ ...settings, outlook: { ...settings.outlook, ...patch } });
  const updateTelegram = (patch: Partial<CommsSettings["telegram"]>) =>
    onSettingsChange({ ...settings, telegram: { ...settings.telegram, ...patch } });

  return (
    <div className="comms-settings">
      <section className="comms-settings-card">
        <div>
          <h3>{t("comms.outlook.title")}</h3>
          <p>{t("comms.outlook.settings.description")}</p>
        </div>
        <label className="field checkbox-field">
          <input
            type="checkbox"
            checked={settings.outlook.enabled}
            onChange={(event) => updateOutlook({ enabled: event.target.checked })}
          />
          <span>{t("comms.enabled")}</span>
        </label>
        <label className="field">
          <span>{t("comms.outlook.m365Path")}</span>
          <input
            value={settings.outlook.m365Path ?? ""}
            onChange={(event) => updateOutlook({ m365Path: event.target.value || null })}
            placeholder="/opt/homebrew/bin/m365"
          />
        </label>
        <label className="field">
          <span>{t("comms.maxResults")}</span>
          <input
            type="number"
            min={1}
            max={200}
            value={settings.outlook.maxResults}
            onChange={(event) => updateOutlook({ maxResults: Number(event.target.value) })}
          />
        </label>
      </section>

      <section className="comms-settings-card">
        <div>
          <h3>{t("comms.telegram.title")}</h3>
          <p>{t("comms.telegram.settings.description")}</p>
        </div>
        {telegramEnvHealthy === false ? (
          <div className="comms-setup-banner">
            <div>
              <strong>{t("comms.telegram.setupRequired")}</strong>
              <p>{t("comms.telegram.setupRequiredDetail")}</p>
            </div>
            <button type="button" className="secondary-button" onClick={onOpenSkillsEnvSettings}>
              {t("comms.telegram.openEnvSetup")}
            </button>
          </div>
        ) : null}
        <label className="field checkbox-field">
          <input
            type="checkbox"
            checked={settings.telegram.enabled}
            onChange={(event) => updateTelegram({ enabled: event.target.checked })}
          />
          <span>{t("comms.enabled")}</span>
        </label>
        <label className="field">
          <span>{t("comms.telegram.sessionFile")}</span>
          <input
            value={settings.telegram.sessionFile ?? ""}
            onChange={(event) => updateTelegram({ sessionFile: event.target.value || null })}
            placeholder="~/.anchor/telegram/monitor.session"
          />
        </label>
        <label className="field">
          <span>{t("comms.telegram.pythonPath")}</span>
          <input
            value={settings.telegram.pythonPath ?? ""}
            onChange={(event) => updateTelegram({ pythonPath: event.target.value || null })}
            placeholder="~/.anchor/env/.venv/bin/python"
          />
        </label>
        <label className="field">
          <span>{t("comms.telegram.scriptPath")}</span>
          <input
            value={settings.telegram.scriptPath ?? ""}
            onChange={(event) => updateTelegram({ scriptPath: event.target.value || null })}
            placeholder="~/.anchor/skills/_builtin/skills/io-telegram/scripts/telegram_monitor.py"
          />
        </label>
        <label className="field">
          <span>{t("comms.telegram.interval")}</span>
          <input
            type="number"
            min={30}
            value={settings.telegram.intervalSeconds}
            onChange={(event) => updateTelegram({ intervalSeconds: Number(event.target.value) })}
          />
        </label>
        <label className="field">
          <span>{t("comms.maxResults")}</span>
          <input
            type="number"
            min={1}
            max={200}
            value={settings.telegram.maxResults}
            onChange={(event) => updateTelegram({ maxResults: Number(event.target.value) })}
          />
        </label>
        <label className="field checkbox-field">
          <input
            type="checkbox"
            checked={settings.telegram.legacyAutoDrop}
            onChange={(event) => updateTelegram({ legacyAutoDrop: event.target.checked })}
          />
          <span>{t("comms.telegram.legacyAutoDrop")}</span>
        </label>
        <div className="comms-settings-actions">
          <button type="button" className="secondary-button" onClick={onTelegramLogin}>
            <LogIn size={14} />
            <span>{t("comms.telegram.login")}</span>
          </button>
          {pollingStatus.running ? (
            <button type="button" className="secondary-button" onClick={onStopPolling}>
              <Square size={14} />
              <span>{t("comms.telegram.stopPolling")}</span>
            </button>
          ) : (
            <button type="button" className="secondary-button" onClick={onStartPolling}>
              <Play size={14} />
              <span>{t("comms.telegram.startPolling")}</span>
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

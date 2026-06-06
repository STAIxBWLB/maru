import { AlertTriangle, LogIn, Play, Square } from "lucide-react";
import type {
  InboxGmailConfig,
  ProjectPickerEntry,
  ProviderAuthStatus,
  TelegramMonitorConfigView,
} from "../../lib/types";
import {
  COMMS_PROVIDER_RESULTS_MAX,
  COMMS_PROVIDER_RESULTS_MIN,
  TELEGRAM_POLL_INTERVAL_MAX_SECONDS,
  TELEGRAM_POLL_INTERVAL_MIN_SECONDS,
  type CommsSettings,
} from "../../lib/settings";
import { isTelegramMonitorConfigOutsideAnchor } from "../../lib/telegram";
import type { TelegramPollingStatus } from "../../lib/types";
import { useTranslation } from "../../lib/i18n";
import { AuthStatusBadge } from "./AuthStatusBadge";
import { TelegramAuthFields } from "./TelegramAuthFields";
import { TelegramChatMappingEditor } from "./TelegramChatMappingEditor";

interface CommsSettingsTabProps {
  settings: CommsSettings;
  effectiveSettings?: CommsSettings;
  gmailSettings: InboxGmailConfig;
  effectiveGwsPath?: string | null;
  pollingStatus?: TelegramPollingStatus;
  telegramEnvHealthy?: boolean | null;
  authStatuses?: Partial<Record<"gws" | "mso" | "telegram", ProviderAuthStatus | null>>;
  monitorConfig?: TelegramMonitorConfigView | null;
  projects?: ProjectPickerEntry[];
  onSettingsChange: (settings: CommsSettings) => void;
  onGmailSettingsChange: (settings: InboxGmailConfig) => void;
  onMonitorConfigChange?: (config: TelegramMonitorConfigView) => void;
  onGwsReauth?: () => void;
  onMsoReauth?: () => void;
  onStartPolling?: () => void;
  onStopPolling?: () => void;
  onTelegramLogin?: () => void;
  onOpenSkillsEnvSettings?: () => void;
}

export function CommsSettingsTab({
  settings,
  effectiveSettings,
  gmailSettings,
  effectiveGwsPath = null,
  pollingStatus = {
    running: false,
    intervalSeconds: settings.telegram.intervalSeconds,
    lastStartedAt: null,
    lastFetchedAt: null,
    lastMessageCount: 0,
    lastError: null,
  },
  telegramEnvHealthy,
  authStatuses = {},
  monitorConfig,
  projects = [],
  onSettingsChange,
  onGmailSettingsChange,
  onMonitorConfigChange,
  onGwsReauth,
  onMsoReauth,
  onStartPolling,
  onStopPolling,
  onTelegramLogin,
  onOpenSkillsEnvSettings,
}: CommsSettingsTabProps) {
  const { t } = useTranslation();
  const updateGmail = (patch: Partial<InboxGmailConfig>) =>
    onGmailSettingsChange({ ...gmailSettings, ...patch });
  const updateOutlook = (patch: Partial<CommsSettings["outlook"]>) =>
    onSettingsChange({ ...settings, outlook: { ...settings.outlook, ...patch } });
  const updateTelegram = (patch: Partial<CommsSettings["telegram"]>) =>
    onSettingsChange({ ...settings, telegram: { ...settings.telegram, ...patch } });
  const gwsValue = gmailSettings.gws_path ?? "";
  const effectiveM365Path = effectiveSettings?.outlook.m365Path ?? null;
  const effectiveTelegramMonitorConfigPath =
    effectiveSettings?.telegram.monitorConfigPath ?? settings.telegram.monitorConfigPath ?? null;
  const showTelegramMonitorConfigWarning = isTelegramMonitorConfigOutsideAnchor(
    effectiveTelegramMonitorConfigPath,
  );

  return (
    <div className="settings-form comms-settings-form">
      <section className="settings-section-panel">
        <div className="settings-section-heading">
          <div>
            <strong>{t("comms.gmail.title")}</strong>
            <span>{t("comms.gmail.settings.description")}</span>
          </div>
          <AuthStatusBadge status={authStatuses.gws} />
          {onGwsReauth ? (
            <button type="button" className="secondary-button" onClick={onGwsReauth}>
              <LogIn size={14} />
              <span>{t("comms.gws.reauth")}</span>
            </button>
          ) : null}
        </div>
        <label className="field checkbox-field">
          <input
            type="checkbox"
            checked={gmailSettings.enabled}
            onChange={(event) => updateGmail({ enabled: event.target.checked })}
          />
          <span>{t("comms.enabled")}</span>
        </label>
        <div className="settings-grid two">
          <label className="field">
            <span>{t("comms.gmail.scanWindowDays")}</span>
            <input
              type="number"
              min={0}
              max={3650}
              value={gmailSettings.scan_window_days}
              onChange={(event) =>
                updateGmail({
                  scan_window_days: boundedInteger(
                    event.target.value,
                    gmailSettings.scan_window_days,
                    0,
                    3650,
                  ),
                })
              }
            />
          </label>
          <label className="field">
            <span>{t("comms.maxResults")}</span>
            <input
              type="number"
              min={COMMS_PROVIDER_RESULTS_MIN}
              max={COMMS_PROVIDER_RESULTS_MAX}
              value={gmailSettings.max_results}
              onChange={(event) =>
                updateGmail({
                  max_results: boundedInteger(
                    event.target.value,
                    gmailSettings.max_results,
                    COMMS_PROVIDER_RESULTS_MIN,
                    COMMS_PROVIDER_RESULTS_MAX,
                  ),
                })
              }
            />
          </label>
          <label className="field">
            <span>{t("comms.gmail.autoRefreshTtl")}</span>
            <input
              type="number"
              min={0}
              max={TELEGRAM_POLL_INTERVAL_MAX_SECONDS}
              value={gmailSettings.auto_refresh_ttl_seconds}
              onChange={(event) =>
                updateGmail({
                  auto_refresh_ttl_seconds: boundedInteger(
                    event.target.value,
                    gmailSettings.auto_refresh_ttl_seconds,
                    0,
                    TELEGRAM_POLL_INTERVAL_MAX_SECONDS,
                  ),
                })
              }
            />
          </label>
          <label className="field checkbox-field">
            <input
              type="checkbox"
              checked={gmailSettings.unread_only}
              onChange={(event) => updateGmail({ unread_only: event.target.checked })}
            />
            <span>{t("comms.gmail.unreadOnly")}</span>
          </label>
          <label className="field">
            <span>{t("comms.gmail.gwsPath")}</span>
            <input
              className="path-input"
              value={gwsValue}
              onChange={(event) => {
                const value = event.target.value.trim();
                updateGmail({ gws_path: value || null });
              }}
              placeholder={effectiveGwsPath ?? "/opt/homebrew/bin/gws"}
              title={gwsValue || effectiveGwsPath || "/opt/homebrew/bin/gws"}
              spellCheck={false}
            />
            {!gmailSettings.gws_path && effectiveGwsPath ? (
              <small>{t("comms.settings.usingWorkspaceConfig", { path: effectiveGwsPath })}</small>
            ) : null}
          </label>
        </div>
        <label className="field">
          <span>{t("comms.gmail.queryOverride")}</span>
          <input
            value={gmailSettings.query}
            onChange={(event) => updateGmail({ query: event.target.value })}
            placeholder="is:unread newer_than:14d"
            spellCheck={false}
          />
          <small>{t("comms.gmail.queryHelp")}</small>
        </label>
      </section>

      <section className="settings-section-panel">
        <div className="settings-section-heading">
          <div>
            <strong>{t("comms.outlook.title")}</strong>
            <span>{t("comms.outlook.settings.description")}</span>
          </div>
          <AuthStatusBadge status={authStatuses.mso} />
          {onMsoReauth ? (
            <button type="button" className="secondary-button" onClick={onMsoReauth}>
              <LogIn size={14} />
              <span>{t("comms.outlook.reauth")}</span>
            </button>
          ) : null}
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
            className="path-input"
            value={settings.outlook.m365Path ?? ""}
            onChange={(event) => {
              const value = event.target.value.trim();
              updateOutlook({ m365Path: value || null });
            }}
            placeholder={effectiveM365Path ?? "/opt/homebrew/bin/m365"}
            title={settings.outlook.m365Path ?? effectiveM365Path ?? "/opt/homebrew/bin/m365"}
            spellCheck={false}
          />
          {!settings.outlook.m365Path && effectiveM365Path ? (
            <small>{t("comms.settings.usingWorkspaceConfig", { path: effectiveM365Path })}</small>
          ) : null}
        </label>
        <label className="field">
          <span>{t("comms.maxResults")}</span>
          <input
            type="number"
            min={1}
            max={200}
            value={settings.outlook.maxResults}
            onChange={(event) =>
              updateOutlook({
                maxResults: boundedInteger(
                  event.target.value,
                  settings.outlook.maxResults,
                  COMMS_PROVIDER_RESULTS_MIN,
                  COMMS_PROVIDER_RESULTS_MAX,
                ),
              })
            }
          />
        </label>
      </section>

      <section className="settings-section-panel">
        <div className="settings-section-heading">
          <div>
            <strong>{t("comms.telegram.title")}</strong>
            <span>{t("comms.telegram.settings.description")}</span>
          </div>
        </div>
        {telegramEnvHealthy === false ? (
          <div className="comms-setup-banner">
            <div>
              <strong>{t("comms.telegram.setupRequired")}</strong>
              <p>{t("comms.telegram.setupRequiredDetail")}</p>
            </div>
            {onOpenSkillsEnvSettings ? (
              <button type="button" className="secondary-button" onClick={onOpenSkillsEnvSettings}>
                {t("comms.telegram.openEnvSetup")}
              </button>
            ) : null}
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
            className="path-input"
            value={settings.telegram.sessionFile ?? ""}
            onChange={(event) => updateTelegram({ sessionFile: event.target.value || null })}
            placeholder="~/.anchor/telegram/monitor.session"
            title={settings.telegram.sessionFile ?? "~/.anchor/telegram/monitor.session"}
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span>{t("comms.telegram.monitorConfigPath")}</span>
          <input
            className="path-input"
            value={settings.telegram.monitorConfigPath ?? ""}
            onChange={(event) => updateTelegram({ monitorConfigPath: event.target.value || null })}
            placeholder={
              effectiveSettings?.telegram.monitorConfigPath ??
              "~/workspace/work/.secrets/services/telegram-monitor.config.yaml"
            }
            title={
              settings.telegram.monitorConfigPath ??
              effectiveSettings?.telegram.monitorConfigPath ??
              "~/workspace/work/.secrets/services/telegram-monitor.config.yaml"
            }
            spellCheck={false}
          />
          {!settings.telegram.monitorConfigPath && effectiveSettings?.telegram.monitorConfigPath ? (
            <small>Using workspace config: {effectiveSettings.telegram.monitorConfigPath}</small>
          ) : null}
        </label>
        {showTelegramMonitorConfigWarning ? (
          <div className="comms-setup-banner warn">
            <AlertTriangle size={14} />
            <div>
              <strong>{t("comms.telegram.monitorConfigOutsideAnchor")}</strong>
              <p>
                {t("comms.telegram.monitorConfigOutsideAnchorDetail", {
                  path: effectiveTelegramMonitorConfigPath ?? "",
                })}
              </p>
            </div>
          </div>
        ) : null}
        {monitorConfig && onMonitorConfigChange ? (
          <>
            <TelegramAuthFields
              config={monitorConfig}
              status={authStatuses.telegram}
              onChange={onMonitorConfigChange}
              onLogin={onTelegramLogin}
            />
            <TelegramChatMappingEditor
              config={monitorConfig}
              projects={projects}
              onChange={onMonitorConfigChange}
            />
          </>
        ) : null}
        <label className="field">
          <span>{t("comms.telegram.pythonPath")}</span>
          <input
            className="path-input"
            value={settings.telegram.pythonPath ?? ""}
            onChange={(event) => updateTelegram({ pythonPath: event.target.value || null })}
            placeholder="~/.anchor/env/.venv/bin/python"
            title={settings.telegram.pythonPath ?? "~/.anchor/env/.venv/bin/python"}
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span>{t("comms.telegram.scriptPath")}</span>
          <input
            className="path-input"
            value={settings.telegram.scriptPath ?? ""}
            onChange={(event) => updateTelegram({ scriptPath: event.target.value || null })}
            placeholder="~/.anchor/skills/_builtin/skills/io-telegram/scripts/telegram_monitor.py"
            title={
              settings.telegram.scriptPath ??
              "~/.anchor/skills/_builtin/skills/io-telegram/scripts/telegram_monitor.py"
            }
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span>{t("comms.telegram.interval")}</span>
          <input
            type="number"
            min={30}
            value={settings.telegram.intervalSeconds}
            onChange={(event) =>
              updateTelegram({
                intervalSeconds: boundedInteger(
                  event.target.value,
                  settings.telegram.intervalSeconds,
                  TELEGRAM_POLL_INTERVAL_MIN_SECONDS,
                  TELEGRAM_POLL_INTERVAL_MAX_SECONDS,
                ),
              })
            }
          />
        </label>
        <label className="field">
          <span>{t("comms.maxResults")}</span>
          <input
            type="number"
            min={1}
            max={200}
            value={settings.telegram.maxResults}
            onChange={(event) =>
              updateTelegram({
                maxResults: boundedInteger(
                  event.target.value,
                  settings.telegram.maxResults,
                  COMMS_PROVIDER_RESULTS_MIN,
                  COMMS_PROVIDER_RESULTS_MAX,
                ),
              })
            }
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
        {onStartPolling && onStopPolling ? (
          <div className="comms-settings-actions">
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
        ) : null}
      </section>
    </div>
  );
}

function boundedInteger(value: string, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

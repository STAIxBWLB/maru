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
import { isTelegramMonitorConfigOutsideMaru } from "../../lib/telegram";
import type { TelegramPollingStatus } from "../../lib/types";
import { useTranslation } from "../../lib/i18n";
import { SettingsSection } from "../settings/SettingsSection";
import { SettingsRow } from "../settings/SettingsRow";
import { Toggle } from "../ui/Toggle";
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
  msoReauthDisabled?: boolean;
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
  msoReauthDisabled = false,
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
  const showTelegramMonitorConfigWarning = isTelegramMonitorConfigOutsideMaru(
    effectiveTelegramMonitorConfigPath,
  );

  return (
    <div className="settings-form comms-settings-form">
      <SettingsSection
        title={t("comms.gmail.title")}
        description={t("comms.gmail.settings.description")}
        actions={
          <>
            <AuthStatusBadge status={authStatuses.gws} />
            {onGwsReauth ? (
              <button type="button" className="secondary-button" onClick={onGwsReauth}>
                <LogIn size={14} />
                <span>{t("comms.gws.reauth")}</span>
              </button>
            ) : null}
          </>
        }
      >
        <SettingsRow
          label={t("comms.enabled")}
          control={
            <Toggle
              checked={gmailSettings.enabled}
              onChange={(enabled) => updateGmail({ enabled })}
              aria-label={t("comms.enabled")}
            />
          }
        />
        <SettingsRow
          label={t("comms.gmail.scanWindowDays")}
          htmlFor="comms-gmail-scan-window-days"
          control={
            <input
              id="comms-gmail-scan-window-days"
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
          }
        />
        <SettingsRow
          label={t("comms.maxResults")}
          htmlFor="comms-gmail-max-results"
          control={
            <input
              id="comms-gmail-max-results"
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
          }
        />
        <SettingsRow
          label={t("comms.gmail.autoRefreshTtl")}
          htmlFor="comms-gmail-auto-refresh-ttl"
          control={
            <input
              id="comms-gmail-auto-refresh-ttl"
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
          }
        />
        <SettingsRow
          label={t("comms.gmail.unreadOnly")}
          control={
            <Toggle
              checked={gmailSettings.unread_only}
              onChange={(unread_only) => updateGmail({ unread_only })}
              aria-label={t("comms.gmail.unreadOnly")}
            />
          }
        />
        <SettingsRow
          label={t("comms.gmail.gwsPath")}
          description={
            !gmailSettings.gws_path && effectiveGwsPath
              ? t("comms.settings.usingWorkspaceConfig", { path: effectiveGwsPath })
              : undefined
          }
          htmlFor="comms-gmail-gws-path"
          wide
          control={
            <input
              id="comms-gmail-gws-path"
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
          }
        />
        <SettingsRow
          label={t("comms.gmail.queryOverride")}
          description={t("comms.gmail.queryHelp")}
          htmlFor="comms-gmail-query-override"
          wide
          control={
            <input
              id="comms-gmail-query-override"
              value={gmailSettings.query}
              onChange={(event) => updateGmail({ query: event.target.value })}
              placeholder="is:unread newer_than:14d"
              spellCheck={false}
            />
          }
        />
      </SettingsSection>

      <SettingsSection
        title={t("comms.outlook.title")}
        description={t("comms.outlook.settings.description")}
        actions={
          <>
            <AuthStatusBadge status={authStatuses.mso} />
            {onMsoReauth ? (
              <button
                type="button"
                className="secondary-button"
                disabled={msoReauthDisabled}
                onClick={onMsoReauth}
              >
                <LogIn size={14} />
                <span>{t("comms.outlook.reauth")}</span>
              </button>
            ) : null}
          </>
        }
      >
        <SettingsRow
          label={t("comms.enabled")}
          control={
            <Toggle
              checked={settings.outlook.enabled}
              onChange={(enabled) => updateOutlook({ enabled })}
              aria-label={t("comms.enabled")}
            />
          }
        />
        <SettingsRow
          label={t("comms.outlook.m365Path")}
          description={
            !settings.outlook.m365Path && effectiveM365Path
              ? t("comms.settings.usingWorkspaceConfig", { path: effectiveM365Path })
              : undefined
          }
          htmlFor="comms-outlook-m365-path"
          wide
          control={
            <input
              id="comms-outlook-m365-path"
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
          }
        />
        <SettingsRow
          label={t("comms.maxResults")}
          htmlFor="comms-outlook-max-results"
          control={
            <input
              id="comms-outlook-max-results"
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
          }
        />
      </SettingsSection>

      <SettingsSection
        title={t("comms.telegram.title")}
        description={t("comms.telegram.settings.description")}
        padded
      >
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
        <SettingsRow
          label={t("comms.enabled")}
          control={
            <Toggle
              checked={settings.telegram.enabled}
              onChange={(enabled) => updateTelegram({ enabled })}
              aria-label={t("comms.enabled")}
            />
          }
        />
        <SettingsRow
          label={t("comms.telegram.sessionFile")}
          htmlFor="comms-telegram-session-file"
          wide
          control={
            <input
              id="comms-telegram-session-file"
              className="path-input"
              value={settings.telegram.sessionFile ?? ""}
              onChange={(event) => updateTelegram({ sessionFile: event.target.value || null })}
              placeholder="~/.maru/telegram/monitor.session"
              title={settings.telegram.sessionFile ?? "~/.maru/telegram/monitor.session"}
              spellCheck={false}
            />
          }
        />
        <SettingsRow
          label={t("comms.telegram.monitorConfigPath")}
          description={
            !settings.telegram.monitorConfigPath && effectiveSettings?.telegram.monitorConfigPath
              ? `Using workspace config: ${effectiveSettings.telegram.monitorConfigPath}`
              : undefined
          }
          htmlFor="comms-telegram-monitor-config-path"
          wide
          control={
            <input
              id="comms-telegram-monitor-config-path"
              className="path-input"
              value={settings.telegram.monitorConfigPath ?? ""}
              onChange={(event) => updateTelegram({ monitorConfigPath: event.target.value || null })}
              placeholder={
                effectiveSettings?.telegram.monitorConfigPath ??
                "~/workspace/work/.maru/secrets/services/telegram-monitor.config.yaml"
              }
              title={
                settings.telegram.monitorConfigPath ??
                effectiveSettings?.telegram.monitorConfigPath ??
                "~/workspace/work/.maru/secrets/services/telegram-monitor.config.yaml"
              }
              spellCheck={false}
            />
          }
        />
        {showTelegramMonitorConfigWarning ? (
          <div className="comms-setup-banner warn">
            <AlertTriangle size={14} />
            <div>
              <strong>{t("comms.telegram.monitorConfigOutsideMaru")}</strong>
              <p>
                {t("comms.telegram.monitorConfigOutsideMaruDetail", {
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
        <SettingsRow
          label={t("comms.telegram.pythonPath")}
          htmlFor="comms-telegram-python-path"
          wide
          control={
            <input
              id="comms-telegram-python-path"
              className="path-input"
              value={settings.telegram.pythonPath ?? ""}
              onChange={(event) => updateTelegram({ pythonPath: event.target.value || null })}
              placeholder="~/.maru/env/.venv/bin/python"
              title={settings.telegram.pythonPath ?? "~/.maru/env/.venv/bin/python"}
              spellCheck={false}
            />
          }
        />
        <SettingsRow
          label={t("comms.telegram.scriptPath")}
          htmlFor="comms-telegram-script-path"
          wide
          control={
            <input
              id="comms-telegram-script-path"
              className="path-input"
              value={settings.telegram.scriptPath ?? ""}
              onChange={(event) => updateTelegram({ scriptPath: event.target.value || null })}
              placeholder="~/.maru/skills/_builtin/skills/io-telegram/scripts/telegram_monitor.py"
              title={
                settings.telegram.scriptPath ??
                "~/.maru/skills/_builtin/skills/io-telegram/scripts/telegram_monitor.py"
              }
              spellCheck={false}
            />
          }
        />
        <SettingsRow
          label={t("comms.telegram.interval")}
          htmlFor="comms-telegram-interval"
          control={
            <input
              id="comms-telegram-interval"
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
          }
        />
        <SettingsRow
          label={t("comms.maxResults")}
          htmlFor="comms-telegram-max-results"
          control={
            <input
              id="comms-telegram-max-results"
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
          }
        />
        <SettingsRow
          label={t("comms.telegram.legacyAutoDrop")}
          control={
            <Toggle
              checked={settings.telegram.legacyAutoDrop}
              onChange={(legacyAutoDrop) => updateTelegram({ legacyAutoDrop })}
              aria-label={t("comms.telegram.legacyAutoDrop")}
            />
          }
        />
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
      </SettingsSection>
    </div>
  );
}

function boundedInteger(value: string, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

import { RefreshCcw, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_INBOX_RUNTIME_CONFIG,
  checkGwsAuth,
  checkMsoAuth,
  checkTelegramAuth,
  readInboxRuntimeConfig,
  readTelegramMonitorConfig,
  saveTelegramMonitorConfig,
  saveInboxRuntimeConfig,
} from "../../../lib/api";
import { listWorkspaceProjects } from "../../../lib/maruDir";
import { useTranslation } from "../../../lib/i18n";
import type { MaruSettings } from "../../../lib/settings";
import { useWorkspaceConfigLoad } from "../../../lib/useWorkspaceConfigLoad";
import {
  applyWorkspaceCommsOverrides,
  normalizeMaruSettings,
  readWorkspaceM365AuthConfig,
  validateWorkspaceM365ProviderConfig,
} from "../../../lib/settings";
import { emitSettingsTerminalLaunch } from "../../../lib/settingsEvents";
import type {
  InboxRuntimeConfig,
  ProjectPickerEntry,
  ProviderAuthStatus,
  TelegramMonitorConfigView,
  WorkspaceConfig,
} from "../../../lib/types";
import { skillsEnvStatus } from "../../../lib/skills";
import { gwsAuthCommand, m365LoginCommand, telegramLoginCommand } from "../../../lib/telegram";
import {
  normalizeTelegramMonitorConfig,
  telegramMonitorConfigToSave,
} from "../../../lib/telegramMonitor";
import { CommsSettingsTab } from "../../comms/CommsSettingsTab";
import { Button } from "../../ui/Button";
import { ModeHeader } from "../../ui/ModeChrome";
import { cloneInboxConfig } from "./shared";

export function CommsSettingsSystemTab({
  workPath,
  settings,
  onSettingsChange,
  onSaved,
  onOpenSkills,
}: {
  workPath: string;
  settings: MaruSettings;
  onSettingsChange: (settings: MaruSettings) => void;
  onSaved?: (config: InboxRuntimeConfig) => void;
  onOpenSkills: () => void;
}) {
  const { t } = useTranslation();
  const [telegramEnvHealthy, setTelegramEnvHealthy] = useState<boolean | null>(null);
  const {
    state: workspaceConfigLoad,
    reload: reloadWorkspaceConfig,
  } = useWorkspaceConfigLoad(workPath, {
    validator: validateWorkspaceM365ProviderConfig,
  });
  const workspaceConfigReady =
    workspaceConfigLoad.workPath === workPath &&
    workspaceConfigLoad.status === "ready";
  const workspaceConfig =
    workspaceConfigReady ? workspaceConfigLoad.config : null;
  const [monitorConfig, setMonitorConfig] = useState<TelegramMonitorConfigView | null>(null);
  const [pristineMonitorConfig, setPristineMonitorConfig] =
    useState<TelegramMonitorConfigView | null>(null);
  const [projects, setProjects] = useState<ProjectPickerEntry[]>([]);
  const [authStatuses, setAuthStatuses] = useState<
    Partial<Record<"gws" | "mso" | "telegram", ProviderAuthStatus | null>>
  >({});
  const effectiveComms = useMemo(
    () => applyWorkspaceCommsOverrides(settings.comms, workspaceConfig),
    [settings.comms, workspaceConfig],
  );
  const [draftComms, setDraftComms] = useState(settings.comms);
  const effectiveDraftComms = useMemo(
    () => applyWorkspaceCommsOverrides(draftComms, workspaceConfig),
    [draftComms, workspaceConfig],
  );
  const workspaceM365AuthConfig = useMemo(
    () => readWorkspaceM365AuthConfig(workspaceConfig),
    [workspaceConfig],
  );
  const [config, setConfig] = useState<InboxRuntimeConfig>(() =>
    cloneInboxConfig(DEFAULT_INBOX_RUNTIME_CONFIG),
  );
  const [pristine, setPristine] = useState<InboxRuntimeConfig>(() =>
    cloneInboxConfig(DEFAULT_INBOX_RUNTIME_CONFIG),
  );
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const effectiveGwsPath = useMemo(
    () =>
      readWorkspaceProviderString(workspaceConfig, ["gws", "gmail"], [
        "gws_binary",
        "gwsBinary",
        "gws_path",
        "gwsPath",
        "command",
        "commandPath",
        "command_path",
      ]),
    [workspaceConfig],
  );
  const gmail = config.gmail ?? DEFAULT_INBOX_RUNTIME_CONFIG.gmail;
  const dirty =
    JSON.stringify(draftComms) !== JSON.stringify(settings.comms) ||
    JSON.stringify(gmail) !==
      JSON.stringify(pristine.gmail ?? DEFAULT_INBOX_RUNTIME_CONFIG.gmail) ||
    JSON.stringify(monitorConfig) !== JSON.stringify(pristineMonitorConfig);

  useEffect(() => {
    setDraftComms(settings.comms);
  }, [settings.comms]);

  useEffect(() => {
    let cancelled = false;
    void skillsEnvStatus(workPath)
      .then((status) => {
        if (!cancelled) setTelegramEnvHealthy(status?.healthy ?? null);
      })
      .catch(() => {
        if (!cancelled) setTelegramEnvHealthy(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workPath]);

  useEffect(() => {
    setError(null);
    setAuthStatuses((current) => ({ ...current, mso: null }));
  }, [workPath]);

  const dirtyRef = useRef(dirty);
  const forceLoadAfterConfigRef = useRef(false);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  useEffect(() => {
    forceLoadAfterConfigRef.current = false;
  }, [workPath]);

  const load = useCallback(
    async (options?: { force?: boolean; isCancelled?: () => boolean }) => {
    const force = options?.force ?? false;
    const isCancelled = options?.isCancelled ?? (() => false);
    setError(null);
    setStatus(null);
    try {
      const [runtime, monitor, projectEntries, gwsStatus, msoStatus, telegramStatus] =
        await Promise.all([
          readInboxRuntimeConfig(workPath),
          readTelegramMonitorConfig(
            workPath,
            effectiveComms.telegram.monitorConfigPath ?? null,
          ).then(normalizeTelegramMonitorConfig),
          listWorkspaceProjects(workPath).catch(() => []),
          checkGwsAuth(workPath).catch((err) => ({
            provider: "gws",
            state: "error",
            detail: err instanceof Error ? err.message : String(err),
            cliPath: null,
            account: null,
          })),
          workspaceConfigReady
            ? checkMsoAuth(workPath, effectiveComms.outlook.m365Path).catch((err) => ({
                provider: "mso",
                state: "error",
                detail: err instanceof Error ? err.message : String(err),
                cliPath: null,
                account: null,
              }))
            : Promise.resolve(null),
          checkTelegramAuth({
            workPath,
            max: 1,
            pythonPath: effectiveComms.telegram.pythonPath,
            scriptPath: effectiveComms.telegram.scriptPath,
            sessionFile: effectiveComms.telegram.sessionFile,
            monitorConfigPath: effectiveComms.telegram.monitorConfigPath,
            legacyAutoDrop: false,
          }).catch((err) => ({
            provider: "telegram",
            state: "error",
            detail: err instanceof Error ? err.message : String(err),
            cliPath: null,
            account: null,
          })),
        ]);
      if (isCancelled()) return;
      // A dependency-driven reload must not clobber unsaved edits: only the
      // initial load and the explicit refresh button (force) may overwrite
      // the editable config and reset the pristine baselines.
      if (force || !dirtyRef.current) {
        setConfig(runtime);
        setPristine(runtime);
        setMonitorConfig(monitor);
        setPristineMonitorConfig(monitor);
      }
      setProjects(projectEntries);
      setAuthStatuses({
        gws: gwsStatus,
        mso: msoStatus,
        telegram: telegramStatus,
      });
    } catch (err) {
      if (isCancelled()) return;
      setError(err instanceof Error ? err.message : String(err));
    }
    },
    [effectiveComms, workPath, workspaceConfigReady],
  );

  useEffect(() => {
    if (
      workspaceConfigLoad.status !== "ready" &&
      workspaceConfigLoad.status !== "error"
    ) {
      return;
    }
    let cancelled = false;
    const force = forceLoadAfterConfigRef.current;
    forceLoadAfterConfigRef.current = false;
    void load({ force, isCancelled: () => cancelled });
    return () => {
      cancelled = true;
    };
  }, [load, workspaceConfigLoad.status]);

  const refresh = useCallback(async () => {
    forceLoadAfterConfigRef.current = true;
    await reloadWorkspaceConfig();
  }, [reloadWorkspaceConfig]);

  const save = async () => {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const saved = await saveInboxRuntimeConfig(workPath, {
        ...config,
        gmail,
      });
      setConfig(saved);
      setPristine(saved);
      if (monitorConfig) {
        const savedMonitor = await saveTelegramMonitorConfig(
          workPath,
          effectiveDraftComms.telegram.monitorConfigPath ??
            monitorConfig.path,
          telegramMonitorConfigToSave(monitorConfig),
        ).then(normalizeTelegramMonitorConfig);
        setMonitorConfig(savedMonitor);
        setPristineMonitorConfig(savedMonitor);
      }
      onSaved?.(saved);
      onSettingsChange(
        normalizeMaruSettings({
          ...settings,
          comms: draftComms,
        }),
      );
      setStatus(t("system.rules.saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const launchTerminalCommand = useCallback(
    async (command: { command: string | null; args: string[] }) => {
      const delivered = await emitSettingsTerminalLaunch({
        command: command.command,
        args: command.args,
        cwd: workPath,
      });
      if (!delivered) setError(t("comms.auth.mainWindowRequired"));
    },
    [t, workPath],
  );
  const visibleError =
    workspaceConfigLoad.status === "error"
      ? workspaceConfigLoad.error
      : error;

  return (
    <div className="settings-tab">
      <ModeHeader
        title={t("system.tab.comms")}
        actions={
          <>
            <span className={dirty ? "save-state dirty" : "save-state saved"}>
              {dirty ? t("system.rules.dirty") : t("system.rules.saved")}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void refresh()}
              icon={<RefreshCcw size={14} />}
            >
              Refresh
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!dirty || saving}
              onClick={() => void save()}
              icon={<Save size={14} />}
            >
              {t("system.rules.save")}
            </Button>
          </>
        }
      />
      {visibleError ? <div className="inbox-error">{visibleError}</div> : null}
      {status ? <div className="save-state saved">{status}</div> : null}
      <CommsSettingsTab
        settings={draftComms}
        effectiveSettings={effectiveComms}
        gmailSettings={gmail}
        effectiveGwsPath={effectiveGwsPath}
        telegramEnvHealthy={telegramEnvHealthy}
        authStatuses={authStatuses}
        monitorConfig={monitorConfig}
        projects={projects}
        onSettingsChange={(comms) => {
          setDraftComms(comms);
          setStatus(null);
        }}
        onGmailSettingsChange={(nextGmail) => {
          setConfig((current) => ({
            ...current,
            gmail: nextGmail,
          }));
          setStatus(null);
        }}
        onMonitorConfigChange={(nextMonitorConfig) => {
          setMonitorConfig(normalizeTelegramMonitorConfig(nextMonitorConfig));
          setStatus(null);
        }}
        onGwsReauth={() => {
          void launchTerminalCommand(gwsAuthCommand(gmail.gws_path ?? effectiveGwsPath));
        }}
        msoReauthDisabled={!workspaceConfigReady}
        onMsoReauth={() => {
          if (!workspaceConfigReady) return;
          void launchTerminalCommand(
            m365LoginCommand(
              effectiveDraftComms.outlook.m365Path,
              workspaceM365AuthConfig,
            ),
          );
        }}
        onTelegramLogin={() => {
          void launchTerminalCommand(telegramLoginCommand(effectiveDraftComms.telegram));
        }}
        onOpenSkillsEnvSettings={onOpenSkills}
      />
    </div>
  );
}

function readWorkspaceProviderString(
  config: WorkspaceConfig | null,
  providerNames: string[],
  keys: string[],
): string | null {
  const io = isUnknownRecord(config?.io) ? config.io : null;
  const providers = isUnknownRecord(io?.providers) ? io.providers : null;
  if (!providers) return null;
  for (const providerName of providerNames) {
    const provider = isUnknownRecord(providers[providerName])
      ? providers[providerName]
      : null;
    if (!provider) continue;
    for (const key of keys) {
      const value = provider[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
  }
  return null;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

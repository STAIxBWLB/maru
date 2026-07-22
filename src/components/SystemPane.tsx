// SystemPane — maru's `.maru/` operations surface.
//
// One pane for workspace settings and `.maru/` operations. Workspace-local
// JSON stays under `<work>/.maru/`; skill management also talks to the
// global `~/.maru/skills` registry.

import {
  AlertTriangle,
  Check,
  Code2,
  Eye,
  FilePenLine,
  PackageCheck,
  Plus,
  RefreshCcw,
  Save,
  Search,
  ShieldCheck,
  SquareTerminal,
  Trash2,
  Wrench,
} from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
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
} from "../lib/api";
import {
  applySysImport,
  deleteMaruRule,
  deleteMaruTemplate,
  listMaruRules,
  listMaruTemplates,
  listWorkspaceProjects,
  deleteSecretText,
  doctorSecrets,
  migrateSecrets,
  planSysImport,
  readSecretText,
  readMaruMcp,
  readMaruProjects,
  readMaruRule,
  readMaruTemplate,
  readWorkspaceConfig,
  scanSecrets,
  saveMaruMcp,
  saveMaruRule,
  saveMaruTemplate,
  writeSecretText,
} from "../lib/maruDir";
import { useTranslation } from "../lib/i18n";
import type {
  AiClassifierRuntime,
  AiPermissionMode,
  AiRuntime,
  MaruSettings,
  DocumentBrowserMode,
  DocumentLabelMode,
  ExplorerPaneMode,
  FileQueueDefaultOperation,
  FilesBrowserMode,
  FilesListAttribute,
  FilesSortKey,
  TerminalDock,
  TerminalLauncherId,
  ThemeMode,
  WorkspaceFileFilter,
} from "../lib/settings";
import {
  ALL_FILES_LIST_ATTRIBUTES,
  applyWorkspaceCommsOverrides,
  applyWorkspaceMeetingsOverrides,
  applyWorkspaceTasksOverrides,
  formatBinaryFileIncludePatterns,
  normalizeMaruSettings,
  normalizeDotFolderIncludes,
  parseBinaryFileIncludePatternsText,
} from "../lib/settings";
import {
  DEFAULT_TERMINAL_SHORTCUTS,
  TERMINAL_SHORTCUT_ACTIONS,
  type TerminalShortcutAction,
} from "../lib/terminalShortcuts";
import { normalizeAccentInput } from "../lib/theme";
import {
  SKILLS_UPDATED_EVENT,
  type SkillsUpdatedPayload,
} from "../lib/skillEditorEvents";
import {
  SETTINGS_WINDOW_OPEN_TAB_EVENT,
  SETTINGS_WINDOW_TERMINAL_LAUNCH_EVENT,
  type SettingsWindowTerminalLaunchPayload,
  type SettingsWindowOpenTabPayload,
} from "../lib/settingsWindowEvents";
import { DIAGRAM_ENABLE_STORAGE_KEY } from "../lib/diagramFlag";
import type {
  ImportItem,
  ImportPlan,
  InboxChannelConfig,
  InboxRuntimeConfig,
  ProjectPickerEntry,
  ProviderAuthStatus,
  RuleEntry,
  SecretInventoryItem,
  SecretsMigrationAction,
  SecretsMigrationReport,
  SecretsScanReport,
  TemplateEntry,
  TelegramMonitorConfigView,
  WorkspaceConfig,
} from "../lib/types";
import {
  skillsAddSource,
  skillsAdoptExternalLinks,
  skillsApplyBundleUpdate,
  skillsBundleStatus,
  skillsCheckBundleUpdate,
  skillsCreateSkill,
  skillsEnvBootstrap,
  skillsEnvStatus,
  skillsInstallSkill,
  skillsListInstalls,
  skillsListSkills,
  skillsListSources,
  skillsRemoveSource,
  skillsRescanSource,
  skillsResetRegistry,
  skillsSyncAllSources,
  skillsSyncSource,
  skillsUninstallSkill,
  type SkillBundleStatus,
  type SkillInstall,
  type SkillInstallMode,
  type SkillInstallTarget,
  type SkillProgressEvent,
  type SkillRecord,
  type SkillSource,
  type SkillsEnvStatus,
} from "../lib/skills";
import { readDefaultInstallMode, writeDefaultInstallMode } from "../lib/skillsInstallMode";
import { formatRelativeDate } from "../lib/document";
import { gwsAuthCommand, m365LoginCommand, telegramLoginCommand } from "../lib/telegram";
import {
  normalizeTelegramMonitorConfig,
  telegramMonitorConfigToSave,
} from "../lib/telegramMonitor";
import { openSkillEditorWindow } from "../lib/windowLayout";
import { CommsSettingsTab } from "./comms/CommsSettingsTab";
import { JobsTab } from "./jobs/JobsTab";
import { MeetingsSettingsTab } from "./meetings/MeetingsSettingsTab";
import { TasksSettingsTab } from "./tasks/TasksSettingsTab";
import { Button } from "./ui/Button";

type SystemTab =
  | "preferences"
  | "ai"
  | "terminal"
  | "comms"
  | "meetings"
  | "tasks"
  | "inbox-channels"
  | "secrets"
  | "connectors"
  | "rules"
  | "templates"
  | "mcp"
  | "projects"
  | "skills"
  | "jobs"
  | "import";

function isSystemTab(value: string | null | undefined): value is SystemTab {
  return (
    value === "preferences" ||
    value === "ai" ||
    value === "terminal" ||
    value === "comms" ||
    value === "meetings" ||
    value === "tasks" ||
    value === "inbox-channels" ||
    value === "secrets" ||
    value === "connectors" ||
    value === "rules" ||
    value === "templates" ||
    value === "mcp" ||
    value === "projects" ||
    value === "skills" ||
    value === "jobs" ||
    value === "import"
  );
}

/** Emit a terminal launch request for the main window. The only listener (and
 *  the terminal itself) lives in the main window, so bring it forward first —
 *  emitting with no listener would silently drop the re-auth launch. Returns
 *  false when the main window is gone and the launch cannot be delivered. */
async function emitSettingsTerminalLaunch(
  payload: SettingsWindowTerminalLaunchPayload,
): Promise<boolean> {
  try {
    const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
    const mainWindow = await WebviewWindow.getByLabel("main");
    if (!mainWindow) return false;
    try {
      await mainWindow.show();
      await mainWindow.unminimize();
      await mainWindow.setFocus();
    } catch {
      // Focusing is best-effort; the emit below still reaches the listener.
    }
    const { emit } = await import("@tauri-apps/api/event");
    await emit(SETTINGS_WINDOW_TERMINAL_LAUNCH_EVENT, payload);
    return true;
  } catch {
    // Browser dev shell: no Tauri event bus.
    return true;
  }
}

interface SystemPaneProps {
  workPath: string | null;
  settings: MaruSettings;
  onSettingsChange: (settings: MaruSettings) => void;
  onInboxRuntimeConfigChange?: (config: InboxRuntimeConfig) => void;
  initialTab?: string | null;
}

export function SystemPane({
  workPath,
  settings,
  onSettingsChange,
  onInboxRuntimeConfigChange,
  initialTab,
}: SystemPaneProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<SystemTab>(
    isSystemTab(initialTab) ? initialTab : "preferences",
  );

  useEffect(() => {
    let dispose: (() => void) | null = null;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen(SETTINGS_WINDOW_OPEN_TAB_EVENT, (event) => {
          const payload = event.payload as SettingsWindowOpenTabPayload | null;
          if (isSystemTab(payload?.tab)) setTab(payload.tab);
        }),
      )
      .then((off) => {
        dispose = off;
      })
      .catch(() => {
        // Browser dev shell without Tauri event bridge.
      });
    return () => dispose?.();
  }, []);

  if (!workPath) {
    return (
      <main className="system-pane system-empty">
        <div className="empty-document-plate">
          <h2>{t("system.title")}</h2>
          <p>{t("system.empty")}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="system-pane">
      <header className="system-header">
        <div>
          <h2>{t("system.title")}</h2>
          <p className="muted">{t("system.subtitle")}</p>
        </div>
      </header>
      <nav className="system-tabs" role="tablist">
        {(
          [
            ["preferences", "system.tab.preferences"],
            ["ai", "system.tab.ai"],
            ["terminal", "system.tab.terminal"],
            ["comms", "system.tab.comms"],
            ["meetings", "system.tab.meetings"],
            ["tasks", "system.tab.tasks"],
            ["inbox-channels", "system.tab.inboxChannels"],
            ["secrets", "system.tab.secrets"],
            ["connectors", "system.tab.connectors"],
            ["rules", "system.tab.rules"],
            ["templates", "system.tab.templates"],
            ["mcp", "system.tab.mcp"],
            ["projects", "system.tab.projects"],
            ["skills", "system.tab.skills"],
            ["jobs", "system.tab.jobs"],
            ["import", "system.tab.import"],
          ] as Array<[SystemTab, string]>
        ).map(([id, key]) => (
          <button
            key={id}
            type="button"
            className={tab === id ? "system-tab active" : "system-tab"}
            onClick={() => setTab(id)}
            role="tab"
            aria-selected={tab === id}
          >
            {t(key)}
          </button>
        ))}
      </nav>
      <section className="system-body">
        {tab === "preferences" ? (
          <PreferencesTab settings={settings} onSettingsChange={onSettingsChange} />
        ) : null}
        {tab === "ai" ? (
          <AiSettingsTab settings={settings} onSettingsChange={onSettingsChange} />
        ) : null}
        {tab === "terminal" ? (
          <SettingsJsonTab
            title={t("system.terminal.title")}
            value={settings.terminal}
            onSave={(value) =>
              onSettingsChange(
                normalizeMaruSettings({
                  ...settings,
                  terminal: value,
                }),
              )
            }
          />
        ) : null}
        {tab === "comms" ? (
          <CommsSettingsSystemTab
            workPath={workPath}
            settings={settings}
            onSettingsChange={onSettingsChange}
            onSaved={onInboxRuntimeConfigChange}
            onOpenSkills={() => setTab("skills")}
          />
        ) : null}
        {tab === "meetings" ? (
          <MeetingsSettingsSystemTab
            workPath={workPath}
            settings={settings}
            onSettingsChange={onSettingsChange}
          />
        ) : null}
        {tab === "tasks" ? (
          <TasksSettingsSystemTab
            workPath={workPath}
            settings={settings}
            onSettingsChange={onSettingsChange}
          />
        ) : null}
        {tab === "inbox-channels" ? (
          <InboxRuntimeConfigTab
            workPath={workPath}
            settings={settings}
            onSettingsChange={onSettingsChange}
            onSaved={onInboxRuntimeConfigChange}
          />
        ) : null}
        {tab === "secrets" ? <SecretsTab workPath={workPath} /> : null}
        {tab === "connectors" ? (
          <SettingsJsonTab
            title={t("system.connectors.title")}
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
        ) : null}
        {tab === "rules" ? <RulesTab workPath={workPath} /> : null}
        {tab === "templates" ? <TemplatesTab workPath={workPath} /> : null}
        {tab === "mcp" ? <McpTab workPath={workPath} /> : null}
        {tab === "projects" ? <ProjectsTab workPath={workPath} /> : null}
        {tab === "skills" ? <SkillsTab workPath={workPath} /> : null}
        {tab === "jobs" ? <JobsTab workPath={workPath} /> : null}
        {tab === "import" ? <ImportTab workPath={workPath} /> : null}
      </section>
    </main>
  );
}

function SecretsTab({ workPath }: { workPath: string }) {
  const { t } = useTranslation();
  const [report, setReport] = useState<SecretsScanReport | null>(null);
  const [migration, setMigration] = useState<SecretsMigrationReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedMigrationActions, setSelectedMigrationActions] = useState<Set<string>>(
    () => new Set(),
  );
  const [editor, setEditor] = useState<SecretEditorState | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await scanSecrets(workPath));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [workPath]);

  const selectableMigrationActions = useMemo(
    () => migration?.actions.filter(isSelectableMigrationAction) ?? [],
    [migration],
  );

  const selectedRelPaths = useMemo(
    () =>
      (migration?.actions ?? [])
        .filter((action, index) => {
          if (!isSelectableMigrationAction(action)) {
            return false;
          }
          return selectedMigrationActions.has(migrationActionKey(action, index));
        })
        .map((action) => action.relPath)
        .filter((relPath): relPath is string => Boolean(relPath)),
    [migration, selectedMigrationActions],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runDoctor = async () => {
    setBusy(true);
    setError(null);
    try {
      setReport(await doctorSecrets(workPath));
      setMigration(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const runMigration = async (dryRun: boolean, selected?: string[]) => {
    setBusy(true);
    setError(null);
    try {
      const next = await migrateSecrets(workPath, dryRun, selected);
      setMigration(next);
      setReport(next.scan);
      setSelectedMigrationActions(
        new Set(
          next.actions
            .map((action, index) =>
              isSelectableMigrationAction(action) ? migrationActionKey(action, index) : null,
            )
            .filter((key): key is string => Boolean(key)),
        ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const applySelectedMigration = () => {
    if (!migration || migration.applied || selectedRelPaths.length === 0) return;
    void runMigration(false, selectedRelPaths);
  };

  const toggleMigrationAction = (action: SecretsMigrationAction, index: number) => {
    if (!isSelectableMigrationAction(action)) return;
    const key = migrationActionKey(action, index);
    setSelectedMigrationActions((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const openCreateEditor = () => {
    setEditor({
      mode: "create",
      relPath: "",
      contents: "",
      revealed: true,
      busy: false,
      error: null,
    });
  };

  const openEditEditor = (item: SecretInventoryItem) => {
    setEditor({
      mode: "edit",
      relPath: item.relPath,
      contents: "",
      revealed: false,
      busy: false,
      error: null,
    });
  };

  const revealEditorSecret = async () => {
    if (!editor) return;
    setEditor({ ...editor, busy: true, error: null });
    try {
      const doc = await readSecretText(workPath, editor.relPath);
      setEditor((current) =>
        current
          ? {
              ...current,
              relPath: doc.relPath,
              contents: doc.contents,
              revealed: true,
              busy: false,
              error: null,
            }
          : current,
      );
    } catch (err) {
      setEditor((current) =>
        current
          ? {
              ...current,
              busy: false,
              error: err instanceof Error ? err.message : String(err),
            }
          : current,
      );
    }
  };

  const saveEditorSecret = async () => {
    if (!editor || !editor.revealed || !editor.relPath.trim()) return;
    setEditor({ ...editor, busy: true, error: null });
    try {
      await writeSecretText(workPath, editor.relPath.trim(), editor.contents);
      setEditor(null);
      await refresh();
    } catch (err) {
      setEditor((current) =>
        current
          ? {
              ...current,
              busy: false,
              error: err instanceof Error ? err.message : String(err),
            }
          : current,
      );
    }
  };

  const deleteEditorSecret = async () => {
    if (!editor || editor.mode !== "edit") return;
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        t("system.secrets.delete.confirm", { path: editor.relPath }),
      )
    ) {
      return;
    }
    setEditor({ ...editor, busy: true, error: null });
    try {
      const next = await deleteSecretText(workPath, editor.relPath);
      setReport(next);
      setEditor(null);
    } catch (err) {
      setEditor((current) =>
        current
          ? {
              ...current,
              busy: false,
              error: err instanceof Error ? err.message : String(err),
            }
          : current,
      );
    }
  };

  const issueCounts = useMemo(() => {
    const errors = report?.issues.filter((issue) => issue.severity === "error").length ?? 0;
    const warnings = report?.issues.filter((issue) => issue.severity !== "error").length ?? 0;
    return { errors, warnings };
  }, [report]);

  const visibleManagedSecrets = useMemo(
    () => report?.managed.filter((item) => !isGeneratedSecretLeafPath(item.relPath)) ?? [],
    [report],
  );

  return (
    <div className="settings-form secrets-settings-form">
      <section className="settings-section-panel secrets-overview-panel">
        <div className="settings-section-heading">
          <div>
            <strong>{t("system.secrets.title")}</strong>
            <span>{t("system.secrets.subtitle")}</span>
          </div>
          <div className="system-detail-actions compact">
            <Button size="sm" variant="ghost" icon={<RefreshCcw size={14} />} onClick={refresh} disabled={busy}>
              {t("system.secrets.scan")}
            </Button>
            <Button size="sm" variant="ghost" icon={<ShieldCheck size={14} />} onClick={runDoctor} disabled={busy}>
              {t("system.secrets.doctor")}
            </Button>
            <Button size="sm" variant="ghost" icon={<FilePenLine size={14} />} onClick={openCreateEditor} disabled={busy}>
              {t("system.secrets.new")}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => runMigration(true)} disabled={busy}>
              {t("system.secrets.dryRun")}
            </Button>
            <Button
              size="sm"
              onClick={applySelectedMigration}
              disabled={busy || !migration || migration.applied || selectedRelPaths.length === 0}
            >
              {t("system.secrets.applySelected")}
            </Button>
          </div>
        </div>
        {error ? (
          <div className="comms-setup-banner warn">
            <AlertTriangle size={14} />
            <div>{error}</div>
          </div>
        ) : null}
        {report ? (
          <div className="secrets-dashboard-grid">
            <SecretStat label={t("system.secrets.stat.managed")} value={String(visibleManagedSecrets.length)} />
            <SecretStat label={t("system.secrets.stat.candidates")} value={String(report.candidates.length)} />
            <SecretStat label={t("system.secrets.stat.legacyLinks")} value={String(report.legacySymlinks.length)} />
            <SecretStat
              label={t("system.secrets.stat.issues")}
              value={t("system.secrets.stat.issuesValue", { errors: issueCounts.errors, warnings: issueCounts.warnings })}
              tone={issueCounts.errors ? "danger" : issueCounts.warnings ? "warn" : "ok"}
            />
            <div className="secrets-root-card">
              <span>{t("system.secrets.primaryRoot")}</span>
              <code>{report.root.primaryRoot}</code>
            </div>
            <div className="secrets-root-card">
              <span>{t("system.secrets.legacyRoot")}</span>
              <code>{report.root.legacyKind}{report.root.legacyTarget ? ` -> ${report.root.legacyTarget}` : ""}</code>
            </div>
          </div>
        ) : busy ? (
          <div className="secrets-empty-state">{t("system.secrets.scanning")}</div>
        ) : (
          <div className="secrets-empty-state">{t("system.secrets.empty")}</div>
        )}
      </section>

      {report?.issues.length ? (
        <section className="settings-section-panel">
          <div className="settings-section-heading">
            <div>
              <strong>{t("system.secrets.issues.title")}</strong>
              <span>{t("system.secrets.issues.subtitle")}</span>
            </div>
          </div>
          <div className="secrets-table-wrap">
            <table className="secrets-table">
              <thead>
                <tr>
                  <th>{t("system.secrets.table.severity")}</th>
                  <th>{t("system.secrets.table.code")}</th>
                  <th>{t("system.secrets.table.message")}</th>
                  <th>{t("system.secrets.table.path")}</th>
                </tr>
              </thead>
              <tbody>
                {report.issues.map((issue, index) => (
                  <tr key={`${issue.code}-${index}`}>
                    <td><span className={`secrets-pill ${issue.severity === "error" ? "danger" : "warn"}`}>{issue.severity}</span></td>
                    <td><code>{issue.code}</code></td>
                    <td>{issue.message}</td>
                    <td>{issue.path ? <code>{issue.path}</code> : <span className="muted">-</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {report?.candidates.length ? (
        <section className="settings-section-panel">
          <div className="settings-section-heading">
            <div>
              <strong>{t("system.secrets.candidates.title")}</strong>
              <span>{t("system.secrets.candidates.subtitle")}</span>
            </div>
          </div>
          <div className="secrets-table-wrap">
            <table className="secrets-table">
              <thead>
                <tr>
                  <th>{t("system.secrets.table.path")}</th>
                  <th>{t("system.secrets.table.reason")}</th>
                  <th>{t("system.secrets.table.recommendedTarget")}</th>
                </tr>
              </thead>
              <tbody>
                {report.candidates.map((candidate) => (
                  <tr key={candidate.relPath}>
                    <td><strong>{candidate.relPath}</strong></td>
                    <td>{candidate.reason}</td>
                    <td><code>{candidate.recommendedRelPath}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {report?.legacySymlinks.length ? (
        <section className="settings-section-panel">
          <div className="settings-section-heading">
            <div>
              <strong>{t("system.secrets.legacy.title")}</strong>
              <span>{t("system.secrets.legacy.subtitle")}</span>
            </div>
          </div>
          <div className="secrets-table-wrap">
            <table className="secrets-table">
              <thead>
                <tr>
                  <th>{t("system.secrets.table.link")}</th>
                  <th>{t("system.secrets.table.reason")}</th>
                  <th>{t("system.secrets.table.retargetTo")}</th>
                </tr>
              </thead>
              <tbody>
                {report.legacySymlinks.map((candidate) => (
                  <tr key={candidate.relPath}>
                    <td><strong>{candidate.relPath}</strong></td>
                    <td>{candidate.reason}</td>
                    <td><code>{candidate.recommendedRelPath}</code></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {visibleManagedSecrets.length ? (
        <section className="settings-section-panel">
          <div className="settings-section-heading">
            <div>
              <strong>{t("system.secrets.managed.title")}</strong>
              <span>{t("system.secrets.managed.subtitle")}</span>
            </div>
          </div>
          <div className="secrets-table-wrap managed">
            <table className="secrets-table secrets-inventory-table">
              <thead>
                <tr>
                  <th>{t("system.secrets.table.path")}</th>
                  <th>{t("system.secrets.table.root")}</th>
                  <th>{t("system.secrets.table.kind")}</th>
                  <th>{t("system.secrets.table.size")}</th>
                  <th>{t("system.secrets.table.mode")}</th>
                  <th>{t("system.secrets.table.status")}</th>
                  <th>{t("system.secrets.table.textEdit")}</th>
                </tr>
              </thead>
              <tbody>
                {visibleManagedSecrets.map((item) => {
                  const editable = isTextSecretEditable(item);
                  return (
                    <tr key={`${item.root}-${item.relPath}`}>
                      <td><strong>{item.relPath}</strong></td>
                      <td>{item.root}</td>
                      <td>{item.kind}</td>
                      <td>{formatBytes(item.sizeBytes)}</td>
                      <td>{item.mode ?? "-"}</td>
                      <td>
                        <span className={`secrets-pill ${item.permissionsOk ? "ok" : "warn"}`}>
                          {item.permissionsOk ? t("system.secrets.permissions.ok") : t("system.secrets.permissions.warn")}
                        </span>
                      </td>
                      <td>
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={<Eye size={14} />}
                          onClick={() => openEditEditor(item)}
                          disabled={!editable}
                          aria-label={t("system.secrets.revealEdit", { path: item.relPath })}
                        >
                          {t("system.skills.edit")}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {migration ? (
        <section className="settings-section-panel">
          <div className="settings-section-heading">
            <div>
              <strong>{migration.applied ? t("system.secrets.migration.appliedTitle") : t("system.secrets.migration.dryRunTitle")}</strong>
              <span>
                {t("system.secrets.migration.actions", { count: migration.actions.length })}
                {!migration.applied && selectableMigrationActions.length
                  ? ` · ${t("system.secrets.migration.selected", { count: selectedRelPaths.length })}`
                  : ""}
              </span>
            </div>
            {!migration.applied ? (
              <Button
                size="sm"
                onClick={applySelectedMigration}
                disabled={busy || selectedRelPaths.length === 0}
              >
                {t("system.secrets.applySelected")}
              </Button>
            ) : null}
          </div>
          <div className="secrets-table-wrap">
            <table className="secrets-table">
              <thead>
                <tr>
                  {!migration.applied ? <th>{t("system.secrets.table.select")}</th> : null}
                  <th>{t("system.secrets.table.action")}</th>
                  <th>{t("system.secrets.table.status")}</th>
                  <th>{t("system.secrets.table.path")}</th>
                  <th>{t("system.secrets.table.target")}</th>
                </tr>
              </thead>
              <tbody>
                {migration.actions.map((action, index) => {
                  const key = migrationActionKey(action, index);
                  const selectable = isSelectableMigrationAction(action);
                  return (
                    <tr key={`${action.action}-${index}`}>
                      {!migration.applied ? (
                        <td>
                          <input
                            type="checkbox"
                            checked={selectable && selectedMigrationActions.has(key)}
                            disabled={!selectable}
                            onChange={() => toggleMigrationAction(action, index)}
                            aria-label={t("system.secrets.migration.selectAction", { action: action.action, path: action.relPath ?? index })}
                          />
                        </td>
                      ) : null}
                      <td><strong>{action.action}</strong></td>
                      <td><span className={`secrets-pill ${action.status === "applied" || action.status === "ok" ? "ok" : action.status.startsWith("blocked") ? "danger" : "warn"}`}>{action.status}</span></td>
                      <td>{action.relPath ? <code>{action.relPath}</code> : <span className="muted">-</span>}</td>
                      <td>{action.targetPath ? <code>{shortenSecretPath(action.targetPath)}</code> : <span className="muted">-</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
      <SecretTextEditorDialog
        editor={editor}
        onEditorChange={setEditor}
        onReveal={revealEditorSecret}
        onSave={saveEditorSecret}
        onDelete={deleteEditorSecret}
      />
    </div>
  );
}

interface SecretEditorState {
  mode: "create" | "edit";
  relPath: string;
  contents: string;
  revealed: boolean;
  busy: boolean;
  error: string | null;
}

function SecretTextEditorDialog({
  editor,
  onEditorChange,
  onReveal,
  onSave,
  onDelete,
}: {
  editor: SecretEditorState | null;
  onEditorChange: (editor: SecretEditorState | null) => void;
  onReveal: () => void;
  onSave: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const open = Boolean(editor);
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onEditorChange(null); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content dialog-content--wide secret-editor-dialog">
          <div className="dialog-header">
            <div>
              <Dialog.Title>{editor?.mode === "create" ? t("system.secrets.new") : t("system.secrets.editor.editTitle")}</Dialog.Title>
              <Dialog.Description>
                {t("system.secrets.editor.description")}
              </Dialog.Description>
            </div>
          </div>
          {editor ? (
            <div className="settings-form secret-editor-form">
              {editor.error ? (
                <div className="comms-setup-banner warn">
                  <AlertTriangle size={14} />
                  <div>{editor.error}</div>
                </div>
              ) : null}
              <label className="field">
                <span>{t("system.secrets.editor.path")}</span>
                <input
                  value={editor.relPath}
                  readOnly={editor.mode === "edit"}
                  spellCheck={false}
                  placeholder="services/example.env"
                  onChange={(event) =>
                    onEditorChange({ ...editor, relPath: event.target.value })
                  }
                />
                <small>{t("system.secrets.editor.pathHelp")}</small>
              </label>
              <label className="field">
                <span>{t("system.secrets.editor.value")}</span>
                <textarea
                  className="settings-textarea secret-editor-textarea"
                  value={editor.revealed ? editor.contents : ""}
                  disabled={!editor.revealed || editor.busy}
                  spellCheck={false}
                  placeholder={t("system.secrets.editor.valuePlaceholder")}
                  onChange={(event) =>
                    onEditorChange({ ...editor, contents: event.target.value })
                  }
                />
              </label>
              <div className="system-detail-actions compact">
                {editor.mode === "edit" && !editor.revealed ? (
                  <Button
                    size="sm"
                    icon={<Eye size={14} />}
                    onClick={onReveal}
                    disabled={editor.busy}
                  >
                    {t("system.secrets.editor.reveal")}
                  </Button>
                ) : null}
                {editor.mode === "edit" ? (
                  <Button
                    size="sm"
                    variant="danger"
                    icon={<Trash2 size={14} />}
                    onClick={onDelete}
                    disabled={editor.busy}
                  >
                    {t("system.rules.delete")}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  onClick={onSave}
                  disabled={editor.busy || !editor.revealed || !editor.relPath.trim()}
                  icon={<Save size={14} />}
                >
                  {t("system.rules.save")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onEditorChange(null)}
                  disabled={editor.busy}
                >
                  {t("dialog.cancel")}
                </Button>
              </div>
            </div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function SecretStat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: string;
  tone?: "neutral" | "ok" | "warn" | "danger";
}) {
  return (
    <div className={`secrets-stat ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function migrationActionKey(action: SecretsMigrationAction, index: number): string {
  return `${action.action}:${action.relPath ?? index}:${action.targetPath ?? ""}`;
}

function isSelectableMigrationAction(action: SecretsMigrationAction): boolean {
  return (
    Boolean(action.relPath) &&
    (action.action === "move-secret-file" || action.action === "retarget-legacy-symlink")
  );
}

function isTextSecretEditable(item: SecretInventoryItem): boolean {
  if (item.root !== "primary" || item.kind !== "file" || item.symlinkTarget) return false;
  if (isGeneratedSecretLeafPath(item.relPath)) return false;
  const name = item.relPath.split("/").pop()?.toLowerCase() ?? "";
  const ext = name.includes(".") ? name.split(".").pop() ?? "" : "";
  const blocked = new Set([
    "age",
    "bin",
    "cer",
    "crt",
    "db",
    "der",
    "gz",
    "key",
    "p12",
    "p8",
    "pdf",
    "pem",
    "sqlite",
    "tar",
    "zip",
  ]);
  return !blocked.has(ext);
}

function isGeneratedSecretLeafPath(relPath: string): boolean {
  const name = relPath.split("/").pop()?.toLowerCase() ?? "";
  return (
    name.startsWith("._") ||
    name === ".ds_store" ||
    name === ".localized" ||
    name === "thumbs.db" ||
    name === "desktop.ini"
  );
}

function shortenSecretPath(path: string): string {
  const marker = ".maru/secrets/";
  const index = path.indexOf(marker);
  return index >= 0 ? path.slice(index + marker.length) : path;
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function CommsSettingsSystemTab({
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
  const [workspaceConfig, setWorkspaceConfig] = useState<WorkspaceConfig | null>(null);
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
    let cancelled = false;
    void readWorkspaceConfig(workPath)
      .then((next) => {
        if (!cancelled) setWorkspaceConfig(next);
      })
      .catch(() => {
        if (!cancelled) setWorkspaceConfig(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workPath]);

  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);

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
          checkMsoAuth(workPath, effectiveComms.outlook.m365Path).catch((err) => ({
            provider: "mso",
            state: "error",
            detail: err instanceof Error ? err.message : String(err),
            cliPath: null,
            account: null,
          })),
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
    [effectiveComms, workPath],
  );

  useEffect(() => {
    let cancelled = false;
    void load({ isCancelled: () => cancelled });
    return () => {
      cancelled = true;
    };
  }, [load]);

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

  return (
    <div className="system-detail" style={{ width: "100%" }}>
      <div className="system-detail-actions">
        <strong>{t("system.tab.comms")}</strong>
        <span style={{ flex: 1 }} />
        <span className={dirty ? "save-state dirty" : "save-state saved"}>
          {dirty ? t("system.rules.dirty") : t("system.rules.saved")}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void load({ force: true })}
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
      </div>
      {error ? <div className="inbox-error">{error}</div> : null}
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
        onMsoReauth={() => {
          void launchTerminalCommand(m365LoginCommand(effectiveDraftComms.outlook.m365Path));
        }}
        onTelegramLogin={() => {
          void launchTerminalCommand(telegramLoginCommand(effectiveDraftComms.telegram));
        }}
        onOpenSkillsEnvSettings={onOpenSkills}
      />
    </div>
  );
}

function MeetingsSettingsSystemTab({
  workPath,
  settings,
  onSettingsChange,
}: {
  workPath: string;
  settings: MaruSettings;
  onSettingsChange: (settings: MaruSettings) => void;
}) {
  const { t } = useTranslation();
  const [workspaceConfig, setWorkspaceConfig] = useState<WorkspaceConfig | null>(null);
  const [draftMeetings, setDraftMeetings] = useState(settings.meetings);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const effectiveMeetings = useMemo(
    () => applyWorkspaceMeetingsOverrides(settings.meetings, workspaceConfig),
    [settings.meetings, workspaceConfig],
  );
  const dirty = JSON.stringify(draftMeetings) !== JSON.stringify(settings.meetings);

  useEffect(() => {
    setDraftMeetings(settings.meetings);
  }, [settings.meetings]);

  useEffect(() => {
    let cancelled = false;
    void readWorkspaceConfig(workPath)
      .then((next) => {
        if (!cancelled) setWorkspaceConfig(next);
      })
      .catch(() => {
        if (!cancelled) setWorkspaceConfig(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workPath]);

  const save = () => {
    setError(null);
    setStatus(null);
    try {
      onSettingsChange(
        normalizeMaruSettings({
          ...settings,
          meetings: draftMeetings,
        }),
      );
      setStatus(t("system.rules.saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="system-detail" style={{ width: "100%" }}>
      <div className="system-detail-actions">
        <strong>{t("system.tab.meetings")}</strong>
        <span style={{ flex: 1 }} />
        <span className={dirty ? "save-state dirty" : "save-state saved"}>
          {dirty ? t("system.rules.dirty") : t("system.rules.saved")}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setDraftMeetings(settings.meetings);
            setStatus(null);
            setError(null);
          }}
          icon={<RefreshCcw size={14} />}
        >
          Refresh
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!dirty}
          onClick={save}
          icon={<Save size={14} />}
        >
          {t("system.rules.save")}
        </Button>
      </div>
      {error ? <div className="inbox-error">{error}</div> : null}
      {status ? <div className="save-state saved">{status}</div> : null}
      <MeetingsSettingsTab
        settings={draftMeetings}
        effectiveSettings={effectiveMeetings}
        onSettingsChange={(meetings) => {
          setDraftMeetings(meetings);
          setStatus(null);
        }}
      />
    </div>
  );
}

function TasksSettingsSystemTab({
  workPath,
  settings,
  onSettingsChange,
}: {
  workPath: string;
  settings: MaruSettings;
  onSettingsChange: (settings: MaruSettings) => void;
}) {
  const { t } = useTranslation();
  const [workspaceConfig, setWorkspaceConfig] = useState<WorkspaceConfig | null>(null);
  const [draftTasks, setDraftTasks] = useState(settings.tasks);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const effectiveTasks = useMemo(
    () => applyWorkspaceTasksOverrides(settings.tasks, workspaceConfig),
    [settings.tasks, workspaceConfig],
  );
  const dirty = JSON.stringify(draftTasks) !== JSON.stringify(settings.tasks);

  useEffect(() => {
    setDraftTasks(settings.tasks);
  }, [settings.tasks]);

  useEffect(() => {
    let cancelled = false;
    void readWorkspaceConfig(workPath)
      .then((next) => {
        if (!cancelled) setWorkspaceConfig(next);
      })
      .catch(() => {
        if (!cancelled) setWorkspaceConfig(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workPath]);

  const save = () => {
    setError(null);
    setStatus(null);
    try {
      onSettingsChange(
        normalizeMaruSettings({
          ...settings,
          tasks: draftTasks,
        }),
      );
      setStatus(t("system.rules.saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="system-detail" style={{ width: "100%" }}>
      <div className="system-detail-actions">
        <strong>{t("system.tab.tasks")}</strong>
        <span style={{ flex: 1 }} />
        <span className={dirty ? "save-state dirty" : "save-state saved"}>
          {dirty ? t("system.rules.dirty") : t("system.rules.saved")}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setDraftTasks(settings.tasks);
            setStatus(null);
            setError(null);
          }}
          icon={<RefreshCcw size={14} />}
        >
          Refresh
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!dirty}
          onClick={save}
          icon={<Save size={14} />}
        >
          {t("system.rules.save")}
        </Button>
      </div>
      {error ? <div className="inbox-error">{error}</div> : null}
      {status ? <div className="save-state saved">{status}</div> : null}
      <TasksSettingsTab
        settings={draftTasks}
        effectiveSettings={effectiveTasks}
        onSettingsChange={(tasks) => {
          setDraftTasks(tasks);
          setStatus(null);
        }}
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

// ============================ Preferences ============================

function AiSettingsTab({
  settings,
  onSettingsChange,
}: {
  settings: MaruSettings;
  onSettingsChange: (settings: MaruSettings) => void;
}) {
  const { t } = useTranslation();
  const ai = settings.ai;
  const [claudeOverride, setClaudeOverride] = useState(() => ai.commandOverrides.claude ?? "");
  const [codexOverride, setCodexOverride] = useState(() => ai.commandOverrides.codex ?? "");

  useEffect(() => {
    setClaudeOverride(ai.commandOverrides.claude ?? "");
    setCodexOverride(ai.commandOverrides.codex ?? "");
  }, [ai.commandOverrides.claude, ai.commandOverrides.codex]);

  const commitAi = (patch: Partial<MaruSettings["ai"]>) => {
    onSettingsChange(
      normalizeMaruSettings({
        ...settings,
        ai: { ...settings.ai, ...patch },
      }),
    );
  };

  const commitOverride = (runtime: AiRuntime, value: string) => {
    const trimmed = value.trim();
    commitAi({
      commandOverrides: {
        ...ai.commandOverrides,
        [runtime]: trimmed ? trimmed : null,
      },
    });
  };

  const permissionModes: AiPermissionMode[] = [
    "plan",
    "acceptEdits",
    "default",
    "bypassPermissions",
  ];

  return (
    <div className="system-detail" style={{ width: "100%" }}>
      <div className="settings-form">
        <label className="field">
          <span>{t("system.ai.defaultRuntime")}</span>
          <select
            value={ai.defaultRuntime}
            onChange={(event) => commitAi({ defaultRuntime: event.target.value as AiRuntime })}
          >
            <option value="claude">{t("system.ai.runtime.claude")}</option>
            <option value="codex">{t("system.ai.runtime.codex")}</option>
          </select>
        </label>
        <label className="field">
          <span>{t("system.ai.classifierRuntime")}</span>
          <select
            value={ai.classifierRuntime}
            onChange={(event) =>
              commitAi({ classifierRuntime: event.target.value as AiClassifierRuntime })
            }
          >
            <option value="inherit">{t("system.ai.classifierRuntime.inherit")}</option>
            <option value="claude">{t("system.ai.runtime.claude")}</option>
            <option value="codex">{t("system.ai.runtime.codex")}</option>
          </select>
        </label>
        <label className="field">
          <span>{t("system.ai.permissionMode")}</span>
          <select
            value={ai.permissionMode}
            onChange={(event) =>
              commitAi({ permissionMode: event.target.value as AiPermissionMode })
            }
          >
            {permissionModes.map((mode) => (
              <option key={mode} value={mode}>
                {t(`system.ai.permissionMode.${mode}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>{t("system.ai.commandClaude")}</span>
          <input
            type="text"
            value={claudeOverride}
            placeholder={t("system.ai.commandOverride.help")}
            onChange={(event) => setClaudeOverride(event.target.value)}
            onBlur={(event) => commitOverride("claude", event.target.value)}
          />
        </label>
        <label className="field">
          <span>{t("system.ai.commandCodex")}</span>
          <input
            type="text"
            value={codexOverride}
            placeholder={t("system.ai.commandOverride.help")}
            onChange={(event) => setCodexOverride(event.target.value)}
            onBlur={(event) => commitOverride("codex", event.target.value)}
          />
        </label>
        <p className="settings-hint">{t("system.ai.commandOverride.help")}</p>
      </div>
    </div>
  );
}

function PreferencesTab({
  settings,
  onSettingsChange,
}: {
  settings: MaruSettings;
  onSettingsChange: (settings: MaruSettings) => void;
}) {
  const { t } = useTranslation();
  const [binaryPatternsText, setBinaryPatternsText] = useState(() =>
    formatBinaryFileIncludePatterns(settings.ui.binaryFileIncludePatterns),
  );

  useEffect(() => {
    setBinaryPatternsText(formatBinaryFileIncludePatterns(settings.ui.binaryFileIncludePatterns));
  }, [settings.ui.binaryFileIncludePatterns]);

  const updateBrowserMode = (mode: DocumentBrowserMode) => {
    onSettingsChange(
      normalizeMaruSettings({
        ...settings,
        ui: {
          ...settings.ui,
          documentBrowserMode: mode,
        },
      }),
    );
  };

  const updateExplorerPaneMode = (explorerPaneMode: ExplorerPaneMode) => {
    onSettingsChange(
      normalizeMaruSettings({
        ...settings,
        ui: {
          ...settings.ui,
          explorerPaneMode,
        },
      }),
    );
  };

  const updateWorkspaceFileFilter = (workspaceFileFilter: WorkspaceFileFilter) => {
    onSettingsChange(
      normalizeMaruSettings({
        ...settings,
        ui: {
          ...settings.ui,
          workspaceFileFilter,
        },
      }),
    );
  };

  const updateFilesBrowserMode = (filesBrowserMode: FilesBrowserMode) => {
    onSettingsChange(
      normalizeMaruSettings({
        ...settings,
        ui: {
          ...settings.ui,
          filesBrowserMode,
        },
      }),
    );
  };

  const updateFilesSortKey = (filesSortKey: FilesSortKey) => {
    onSettingsChange(
      normalizeMaruSettings({
        ...settings,
        ui: {
          ...settings.ui,
          filesSortKey,
        },
      }),
    );
  };

  const updateFilesListAttributes = (filesListAttributes: FilesListAttribute[]) => {
    onSettingsChange(
      normalizeMaruSettings({
        ...settings,
        ui: {
          ...settings.ui,
          filesListAttributes,
        },
      }),
    );
  };

  const toggleFilesListAttribute = (attribute: FilesListAttribute) => {
    const current = settings.ui.filesListAttributes;
    const next = current.includes(attribute)
      ? current.filter((value) => value !== attribute)
      : [...current, attribute];
    updateFilesListAttributes(next);
  };

  const commitBinaryFileIncludePatterns = (text: string) => {
    onSettingsChange(
      normalizeMaruSettings({
        ...settings,
        ui: {
          ...settings.ui,
          binaryFileIncludePatterns: parseBinaryFileIncludePatternsText(text),
        },
      }),
    );
  };

  const updateFileQueueDefaultOperation = (
    fileQueueDefaultOperation: FileQueueDefaultOperation,
  ) => {
    onSettingsChange(
      normalizeMaruSettings({
        ...settings,
        ui: {
          ...settings.ui,
          fileQueueDefaultOperation,
        },
      }),
    );
  };

  const updateDocumentLabelMode = (documentLabelMode: DocumentLabelMode) => {
    onSettingsChange(
      normalizeMaruSettings({
        ...settings,
        ui: {
          ...settings.ui,
          documentLabelMode,
        },
      }),
    );
  };

  const updateThemeMode = (themeMode: ThemeMode) => {
    onSettingsChange(
      normalizeMaruSettings({
        ...settings,
        ui: {
          ...settings.ui,
          themeMode,
        },
      }),
    );
  };

  const updateAccentColor = (accentColor: string) => {
    onSettingsChange(
      normalizeMaruSettings({
        ...settings,
        ui: {
          ...settings.ui,
          accentColor: normalizeAccentInput(accentColor, settings.ui.accentColor),
        },
      }),
    );
  };

  const updateAutoLaunch = (autoLaunch: TerminalLauncherId | null) => {
    onSettingsChange(
      normalizeMaruSettings({
        ...settings,
        terminal: {
          ...settings.terminal,
          autoLaunch,
        },
      }),
    );
  };

  const updateTerminalDock = (terminalDock: TerminalDock) => {
    onSettingsChange(
      normalizeMaruSettings({
        ...settings,
        ui: {
          ...settings.ui,
          layout: {
            ...settings.ui.layout,
            terminalDock,
          },
        },
      }),
    );
  };

  const updateTerminalCopyOnSelect = (copyOnSelect: boolean) => {
    onSettingsChange(
      normalizeMaruSettings({
        ...settings,
        terminal: {
          ...settings.terminal,
          copyOnSelect,
        },
      }),
    );
  };

  const updateTerminalShortcut = (action: TerminalShortcutAction, value: string) => {
    onSettingsChange(
      normalizeMaruSettings({
        ...settings,
        terminal: {
          ...settings.terminal,
          shortcuts: {
            ...settings.terminal.shortcuts,
            [action]: value.trim() ? value.trim() : null,
          },
        },
      }),
    );
  };

  const resetTerminalShortcut = (action: TerminalShortcutAction) => {
    updateTerminalShortcut(action, DEFAULT_TERMINAL_SHORTCUTS[action] ?? "");
  };

  return (
    <div className="system-detail" style={{ width: "100%" }}>
      <div className="settings-form">
        <label className="field">
          <span>{t("system.preferences.explorerPane")}</span>
          <select
            value={settings.ui.explorerPaneMode}
            onChange={(event) => updateExplorerPaneMode(event.target.value as ExplorerPaneMode)}
          >
            <option value="documents">{t("explorer.mode.documents")}</option>
            <option value="files">{t("explorer.mode.files")}</option>
          </select>
        </label>
        <label className="field">
          <span>{t("system.preferences.documentBrowser")}</span>
          <select
            value={settings.ui.documentBrowserMode}
            onChange={(event) => updateBrowserMode(event.target.value as DocumentBrowserMode)}
          >
            <option value="list">{t("list.view.list")}</option>
            <option value="tree">{t("list.view.tree")}</option>
          </select>
        </label>
        <label className="field">
          <span>{t("system.preferences.filesFilter")}</span>
          <select
            value={settings.ui.workspaceFileFilter}
            onChange={(event) =>
              updateWorkspaceFileFilter(event.target.value as WorkspaceFileFilter)
            }
          >
            <option value="all">{t("files.filter.all")}</option>
            <option value="tracked">{t("files.filter.tracked")}</option>
            <option value="binary">{t("files.filter.binary")}</option>
          </select>
        </label>
        <label className="field">
          <span>{t("system.preferences.filesBrowser")}</span>
          <select
            value={settings.ui.filesBrowserMode}
            onChange={(event) => updateFilesBrowserMode(event.target.value as FilesBrowserMode)}
          >
            <option value="list">{t("files.view.list")}</option>
            <option value="tree">{t("files.view.tree")}</option>
          </select>
        </label>
        <label className="field">
          <span>{t("system.preferences.filesSort")}</span>
          <select
            value={settings.ui.filesSortKey}
            onChange={(event) => updateFilesSortKey(event.target.value as FilesSortKey)}
          >
            <option value="name">{t("files.sort.name")}</option>
            <option value="modifiedDesc">{t("files.sort.modifiedDesc")}</option>
            <option value="modifiedAsc">{t("files.sort.modifiedAsc")}</option>
          </select>
        </label>
        <div className="field">
          <span>{t("system.preferences.filesListAttributes")}</span>
          <div className="settings-checkbox-grid">
            {ALL_FILES_LIST_ATTRIBUTES.map((attribute) => (
              <label key={attribute} className="checkbox-field">
                <input
                  type="checkbox"
                  checked={settings.ui.filesListAttributes.includes(attribute)}
                  onChange={() => toggleFilesListAttribute(attribute)}
                />
                <span>{t(`files.attributes.${attribute}`)}</span>
              </label>
            ))}
          </div>
          <small>{t("system.preferences.filesListAttributes.help")}</small>
        </div>
        <label className="field">
          <span>{t("system.preferences.binaryIncludePatterns")}</span>
          <textarea
            className="settings-textarea"
            value={binaryPatternsText}
            onChange={(event) => setBinaryPatternsText(event.target.value)}
            onBlur={() => commitBinaryFileIncludePatterns(binaryPatternsText)}
            spellCheck={false}
            rows={8}
          />
          <small>{t("system.preferences.binaryIncludePatterns.help")}</small>
        </label>
        <label className="field">
          <span>{t("system.preferences.fileQueueOperation")}</span>
          <select
            value={settings.ui.fileQueueDefaultOperation}
            onChange={(event) =>
              updateFileQueueDefaultOperation(
                event.target.value as FileQueueDefaultOperation,
              )
            }
          >
            <option value="copy">{t("rightPane.files.copy")}</option>
            <option value="move">{t("rightPane.files.move")}</option>
          </select>
        </label>
        <label className="field">
          <span>{t("system.preferences.documentLabel")}</span>
          <select
            value={settings.ui.documentLabelMode}
            onChange={(event) =>
              updateDocumentLabelMode(event.target.value as DocumentLabelMode)
            }
          >
            <option value="title">{t("system.preferences.documentLabel.title")}</option>
            <option value="filename">{t("system.preferences.documentLabel.filename")}</option>
            <option value="both">{t("system.preferences.documentLabel.both")}</option>
          </select>
        </label>
        <label className="field">
          <span>{t("system.preferences.themeMode")}</span>
          <select
            value={settings.ui.themeMode}
            onChange={(event) => updateThemeMode(event.target.value as ThemeMode)}
          >
            <option value="system">{t("system.preferences.theme.system")}</option>
            <option value="light">{t("system.preferences.theme.light")}</option>
            <option value="dark">{t("system.preferences.theme.dark")}</option>
          </select>
        </label>
        <label className="field">
          <span>{t("system.preferences.accentColor")}</span>
          <input
            type="color"
            value={settings.ui.accentColor}
            onChange={(event) => updateAccentColor(event.target.value)}
          />
        </label>
        <label className="field">
          <span>{t("system.preferences.terminalAutoLaunch")}</span>
          <select
            value={settings.terminal.autoLaunch ?? "none"}
            onChange={(event) =>
              updateAutoLaunch(
                event.target.value === "none"
                  ? null
                  : (event.target.value as TerminalLauncherId),
              )
            }
          >
            <option value="shell">{t("terminal.launcher.shell")}</option>
            <option value="claude">{t("terminal.launcher.claude")}</option>
            <option value="codex">{t("terminal.launcher.codex")}</option>
            <option value="none">{t("system.preferences.terminalAutoLaunch.none")}</option>
          </select>
        </label>
        <label className="field">
          <span>{t("system.preferences.terminalDock")}</span>
          <select
            value={settings.ui.layout.terminalDock}
            onChange={(event) => updateTerminalDock(event.target.value as TerminalDock)}
          >
            <option value="bottom">{t("terminal.dock.bottom")}</option>
            <option value="right">{t("terminal.dock.right")}</option>
          </select>
        </label>
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={settings.terminal.copyOnSelect}
            onChange={(event) => updateTerminalCopyOnSelect(event.target.checked)}
          />
          <span>{t("system.preferences.terminalCopyOnSelect")}</span>
        </label>
        <div className="field">
          <span>{t("system.preferences.terminalShortcuts")}</span>
          <div className="terminal-shortcut-grid">
            {TERMINAL_SHORTCUT_ACTIONS.map((action) => {
              const value = settings.terminal.shortcuts[action] ?? "";
              return (
                <div key={action} className="terminal-shortcut-row">
                  <label htmlFor={`terminal-shortcut-${action}`}>
                    {t(`system.preferences.terminalShortcut.${action}`)}
                  </label>
                  <input
                    key={`${action}:${value}`}
                    id={`terminal-shortcut-${action}`}
                    defaultValue={value}
                    placeholder={t("system.preferences.terminalShortcut.unbound")}
                    onBlur={(event) => updateTerminalShortcut(action, event.currentTarget.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                    }}
                    spellCheck={false}
                  />
                  <button
                    type="button"
                    className="terminal-shortcut-reset"
                    onClick={() => resetTerminalShortcut(action)}
                    aria-label={t("system.preferences.terminalShortcut.reset")}
                    title={t("system.preferences.terminalShortcut.reset")}
                  >
                    <RefreshCcw size={12} />
                  </button>
                </div>
              );
            })}
          </div>
          <small>{t("system.preferences.terminalShortcuts.help")}</small>
        </div>
        <DiagramPreviewToggle />
      </div>
    </div>
  );
}

function DiagramPreviewToggle() {
  const { t } = useTranslation();
  const isOptOut = (value: string | null) => value === "0" || value === "false";
  const [enabled, setEnabled] = useState<boolean>(() => {
    try {
      return !isOptOut(window.localStorage.getItem(DIAGRAM_ENABLE_STORAGE_KEY));
    } catch {
      return true;
    }
  });
  const toggle = (next: boolean) => {
    setEnabled(next);
    try {
      if (next) window.localStorage.removeItem(DIAGRAM_ENABLE_STORAGE_KEY);
      else window.localStorage.setItem(DIAGRAM_ENABLE_STORAGE_KEY, "0");
    } catch {
      /* ignore */
    }
  };
  return (
    <label className="field">
      <span>{t("diagram.system.preview.label")}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => toggle(event.target.checked)}
        />
        <small style={{ color: "var(--muted)" }}>
          {t("diagram.system.preview.hint")}
        </small>
      </div>
    </label>
  );
}

// ============================ Inbox Runtime ============================

function InboxRuntimeConfigTab({
  workPath,
  settings,
  onSettingsChange,
  onSaved,
}: {
  workPath: string;
  settings: MaruSettings;
  onSettingsChange: (settings: MaruSettings) => void;
  onSaved?: (config: InboxRuntimeConfig) => void;
}) {
  const { t } = useTranslation();
  const [config, setConfig] = useState<InboxRuntimeConfig>(() =>
    cloneInboxConfig(DEFAULT_INBOX_RUNTIME_CONFIG),
  );
  const [pristine, setPristine] = useState<InboxRuntimeConfig>(() =>
    cloneInboxConfig(DEFAULT_INBOX_RUNTIME_CONFIG),
  );
  const [selectedKey, setSelectedKey] = useState<string>("incoming");
  const [channelKeyDraft, setChannelKeyDraft] = useState<string>("incoming");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [dotIncludesText, setDotIncludesText] = useState(() =>
    settings.scan.includeDotFolders.join("\n"),
  );

  const channelKeys = useMemo(() => Object.keys(config.channels).sort(), [config.channels]);
  const selectedChannel = config.channels[selectedKey] ?? null;
  const fileDrop = config.file_drop ?? DEFAULT_INBOX_RUNTIME_CONFIG.file_drop;
  const fileDropChannel = config.channels[fileDrop.channel] ?? null;
  const dirty = JSON.stringify(config) !== JSON.stringify(pristine);

  useEffect(() => {
    setChannelKeyDraft(selectedKey);
  }, [selectedKey]);

  useEffect(() => {
    setDotIncludesText(settings.scan.includeDotFolders.join("\n"));
  }, [settings.scan.includeDotFolders]);

  const load = useCallback(async () => {
    setError(null);
    setStatus(null);
    try {
      const runtime = await readInboxRuntimeConfig(workPath);
      setConfig(runtime);
      setPristine(runtime);
      setSelectedKey((current) => runtime.channels[current] ? current : Object.keys(runtime.channels).sort()[0] ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workPath]);

  useEffect(() => {
    void load();
  }, [load]);

  const updateConfig = (patch: Partial<InboxRuntimeConfig>) => {
    setConfig((current) => ({ ...current, ...patch }));
    setStatus(null);
  };

  const updatePath = (key: keyof InboxRuntimeConfig["paths"], value: string) => {
    setConfig((current) => ({
      ...current,
      paths: {
        ...current.paths,
        [key]: value,
      },
    }));
    setStatus(null);
  };

  const updateNaming = (key: keyof InboxRuntimeConfig["naming"], value: string) => {
    setConfig((current) => ({
      ...current,
      naming: {
        ...current.naming,
        [key]: value,
      },
    }));
    setStatus(null);
  };

  const updateFileDrop = (patch: Partial<InboxRuntimeConfig["file_drop"]>) => {
    setConfig((current) => ({
      ...current,
      file_drop: {
        ...(current.file_drop ?? DEFAULT_INBOX_RUNTIME_CONFIG.file_drop),
        ...patch,
        operation: "copy",
      },
    }));
    setStatus(null);
  };

  const updateDotFolderIncludes = (text: string) => {
    const includeDotFolders = normalizeDotFolderIncludes(text.split(/\r?\n/));
    onSettingsChange(
      normalizeMaruSettings({
        ...settings,
        scan: {
          ...settings.scan,
          includeDotFolders,
        },
      }),
    );
  };

  const updateChannel = (key: string, patch: Partial<InboxChannelConfig>) => {
    setConfig((current) => {
      const channel = current.channels[key];
      if (!channel) return current;
      return {
        ...current,
        channels: {
          ...current.channels,
          [key]: {
            ...channel,
            ...patch,
          },
        },
      };
    });
    setStatus(null);
  };

  const renameChannel = (from: string, toRaw: string) => {
    const to = toRaw.trim();
    if (!to || to === from) return;
    if (!/^[a-z0-9_-]+$/.test(to)) {
      setError(t("system.inboxChannels.channel.keyInvalid"));
      return;
    }
    if (config.channels[to]) {
      setError(t("system.inboxChannels.channel.exists", { key: to }));
      return;
    }
    setConfig((current) => {
      const { [from]: channel, ...rest } = current.channels;
      if (!channel) return current;
      return {
        ...current,
        channels: {
          ...rest,
          [to]: channel,
        },
      };
    });
    setSelectedKey(to);
    setError(null);
    setStatus(null);
  };

  const addChannel = () => {
    const key = uniqueChannelKey(config, "incoming");
    setConfig((current) => ({
      ...current,
      channels: {
        ...current.channels,
        [key]: {
          provider: "local",
          skill: null,
          kind: "file",
          drop_paths: [`${current.paths.drop}/${key}`],
          source_kinds: {},
          dedupe: "sha256",
        },
      },
    }));
    setSelectedKey(key);
    setStatus(null);
  };

  const duplicateChannel = () => {
    if (!selectedChannel) return;
    const key = uniqueChannelKey(config, `${selectedKey}-copy`);
    setConfig((current) => ({
      ...current,
      channels: {
        ...current.channels,
        [key]: cloneChannel(selectedChannel),
      },
    }));
    setSelectedKey(key);
    setStatus(null);
  };

  const deleteChannel = () => {
    if (!selectedKey) return;
    setConfig((current) => {
      const { [selectedKey]: _deleted, ...channels } = current.channels;
      return { ...current, channels };
    });
    const nextKey = channelKeys.filter((key) => key !== selectedKey)[0] ?? "";
    setSelectedKey(nextKey);
    setStatus(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    setStatus(null);
    try {
      const saved = await saveInboxRuntimeConfig(workPath, config);
      setConfig(saved);
      setPristine(saved);
      setSelectedKey((current) => saved.channels[current] ? current : Object.keys(saved.channels).sort()[0] ?? "");
      onSaved?.(saved);
      setStatus(t("system.rules.saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="system-detail" style={{ width: "100%" }}>
      <div className="system-detail-actions">
        <strong>{t("system.inboxChannels.title")}</strong>
        <span style={{ flex: 1 }} />
        <span className={dirty ? "save-state dirty" : "save-state saved"}>
          {dirty ? t("system.rules.dirty") : t("system.rules.saved")}
        </span>
        <Button size="sm" variant="ghost" onClick={() => void load()} icon={<RefreshCcw size={14} />}>
          {t("system.skills.refresh")}
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
      </div>

      <div className="settings-form inbox-runtime-editor">
        <section className="settings-section-panel">
          <div className="settings-section-heading">
            <div>
              <strong>{t("system.inboxChannels.overview.title")}</strong>
              <span>{t("system.inboxChannels.overview.subtitle")}</span>
            </div>
          </div>
          <label className="field">
            <span>{t("system.inboxChannels.inboxRoot")}</span>
            <input
              value={config.root}
              onChange={(event) => updateConfig({ root: event.target.value })}
              spellCheck={false}
            />
          </label>
          <div className="settings-grid two">
            <label className="field">
              <span>{t("system.inboxChannels.fileDropChannel")}</span>
              <select
                value={fileDrop.channel}
                onChange={(event) => {
                  const channel = event.target.value;
                  const dropPath =
                    config.channels[channel]?.drop_paths[0] ?? `${config.paths.drop}/${channel}`;
                  updateFileDrop({ channel, drop_path: dropPath });
                }}
              >
                {channelKeys.map((key) => (
                  <option key={key} value={key}>{key}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>{t("system.inboxChannels.fileDropPath")}</span>
              <select
                value={fileDrop.drop_path}
                onChange={(event) => updateFileDrop({ drop_path: event.target.value })}
              >
                {(fileDropChannel?.drop_paths ?? [fileDrop.drop_path]).map((path) => (
                  <option key={path} value={path}>{path}</option>
                ))}
              </select>
            </label>
          </div>
          {!fileDropChannel ? (
            <small className="settings-warning">{t("system.inboxChannels.fileDropMissing")}</small>
          ) : null}
        </section>

        <section className="settings-section-panel">
          <div className="settings-section-heading">
            <div>
              <strong>{t("system.inboxChannels.paths.title")}</strong>
              <span>{t("system.inboxChannels.paths.subtitle")}</span>
            </div>
          </div>
          <div className="settings-grid two">
            {Object.entries(config.paths).map(([key, value]) => (
              <label className="field" key={key}>
                <span>{key}</span>
                <input
                  value={String(value)}
                  onChange={(event) =>
                    updatePath(key as keyof InboxRuntimeConfig["paths"], event.target.value)
                  }
                  spellCheck={false}
                />
              </label>
            ))}
          </div>
        </section>

        <section className="settings-section-panel">
          <div className="settings-section-heading">
            <div>
              <strong>{t("system.inboxChannels.artifacts.title")}</strong>
              <span>{t("system.inboxChannels.artifacts.subtitle")}</span>
            </div>
          </div>
          <div className="settings-grid two">
            {Object.entries(config.naming).map(([key, value]) => (
              <label className="field" key={key}>
                <span>{key}</span>
                <input
                  value={String(value)}
                  onChange={(event) =>
                    updateNaming(key as keyof InboxRuntimeConfig["naming"], event.target.value)
                  }
                  spellCheck={false}
                />
              </label>
            ))}
          </div>
        </section>

        <section className="settings-section-panel">
          <div className="settings-section-heading">
            <div>
              <strong>{t("system.inboxChannels.channels.title")}</strong>
              <span>{t("system.inboxChannels.channels.subtitle")}</span>
            </div>
          </div>
          <div className="inbox-channel-editor">
            <div className="inbox-channel-list" role="listbox" aria-label={t("system.inboxChannels.channels.listLabel")}>
              <div className="inbox-channel-list-actions">
                <Button size="sm" variant="ghost" onClick={addChannel} icon={<Plus size={14} />}>
                  {t("system.inboxChannels.channel.add")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!selectedChannel}
                  onClick={duplicateChannel}
                >
                  {t("system.inboxChannels.channel.duplicate")}
                </Button>
              </div>
              {channelKeys.map((key) => (
                <button
                  type="button"
                  key={key}
                  className={selectedKey === key ? "system-list-item active" : "system-list-item"}
                  onClick={() => setSelectedKey(key)}
                >
                  <strong>{key}</strong>
                  <span>{config.channels[key]?.provider ?? "local"}</span>
                </button>
              ))}
            </div>

            {selectedChannel ? (
              <div className="inbox-channel-fields">
                <div className="system-detail-actions compact">
                  <strong>{selectedKey}</strong>
                  <span style={{ flex: 1 }} />
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={deleteChannel}
                    icon={<Trash2 size={14} />}
                  >
                    {t("system.rules.delete")}
                  </Button>
                </div>
                <label className="field">
                  <span>{t("system.inboxChannels.field.channelKey")}</span>
                  <input
                    value={channelKeyDraft}
                    onChange={(event) => setChannelKeyDraft(event.target.value)}
                    onBlur={() => renameChannel(selectedKey, channelKeyDraft)}
                    spellCheck={false}
                  />
                </label>
                <div className="settings-grid two">
                  <label className="field">
                    <span>{t("system.inboxChannels.field.provider")}</span>
                    <input
                      value={selectedChannel.provider}
                      onChange={(event) =>
                        updateChannel(selectedKey, { provider: event.target.value })
                      }
                      spellCheck={false}
                    />
                  </label>
                  <label className="field">
                    <span>{t("system.inboxChannels.field.skill")}</span>
                    <input
                      value={selectedChannel.skill ?? ""}
                      onChange={(event) =>
                        updateChannel(selectedKey, { skill: event.target.value.trim() || null })
                      }
                      spellCheck={false}
                    />
                  </label>
                  <label className="field">
                    <span>{t("system.inboxChannels.field.kind")}</span>
                    <input
                      value={selectedChannel.kind}
                      onChange={(event) =>
                        updateChannel(selectedKey, { kind: event.target.value })
                      }
                      spellCheck={false}
                    />
                  </label>
                  <label className="field">
                    <span>{t("system.inboxChannels.field.dedupe")}</span>
                    <input
                      value={selectedChannel.dedupe}
                      onChange={(event) =>
                        updateChannel(selectedKey, { dedupe: event.target.value })
                      }
                      spellCheck={false}
                    />
                  </label>
                </div>
                <label className="field">
                  <span>{t("system.inboxChannels.field.dropPaths")}</span>
                  <textarea
                    className="settings-textarea"
                    value={formatStringList(selectedChannel.drop_paths)}
                    onChange={(event) =>
                      updateChannel(selectedKey, {
                        drop_paths: parseStringList(event.target.value),
                      })
                    }
                    spellCheck={false}
                    rows={4}
                  />
                </label>
                <label className="field">
                  <span>{t("system.inboxChannels.field.sourceKindMapping")}</span>
                  <textarea
                    className="settings-textarea"
                    value={formatStringMap(selectedChannel.source_kinds)}
                    onChange={(event) =>
                      updateChannel(selectedKey, {
                        source_kinds: parseStringMap(event.target.value),
                      })
                    }
                    spellCheck={false}
                    rows={5}
                  />
                </label>
              </div>
            ) : (
              <div className="inbox-empty">{t("system.inboxChannels.channel.none")}</div>
            )}
          </div>
        </section>

        <section className="settings-section-panel">
          <div className="settings-section-heading">
            <div>
              <strong>{t("system.inboxChannels.scan.title")}</strong>
              <span>{t("system.inboxChannels.scan.subtitle")}</span>
            </div>
          </div>
          <label className="field">
            <span>{t("system.inboxChannels.scan.includeDotFolders")}</span>
            <textarea
              className="settings-textarea"
              value={dotIncludesText}
              onChange={(event) => setDotIncludesText(event.target.value)}
              onBlur={() => updateDotFolderIncludes(dotIncludesText)}
              spellCheck={false}
              rows={4}
              placeholder={"inbox/drop/kakao/.omc\n.github"}
            />
            <small>{t("system.inboxChannels.scan.help")}</small>
          </label>
        </section>
      </div>

      {status ? <div className="toast">{status}</div> : null}
      {error ? (
        <div className="toast" title={error}>
          <AlertTriangle size={13} />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}

function cloneInboxConfig(config: InboxRuntimeConfig): InboxRuntimeConfig {
  return JSON.parse(JSON.stringify(config)) as InboxRuntimeConfig;
}

function cloneChannel(channel: InboxChannelConfig): InboxChannelConfig {
  return JSON.parse(JSON.stringify(channel)) as InboxChannelConfig;
}

function uniqueChannelKey(config: InboxRuntimeConfig, base: string): string {
  let key = base.replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  if (!key) key = "channel";
  if (!config.channels[key]) return key;
  let index = 2;
  while (config.channels[`${key}-${index}`]) index += 1;
  return `${key}-${index}`;
}

function formatStringList(values: string[]): string {
  return values.join("\n");
}

function parseStringList(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function formatStringMap(value: Record<string, string> = {}): string {
  return Object.entries(value)
    .map(([key, item]) => `${key}=${item}`)
    .join("\n");
}

function parseStringMap(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of value.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.includes("=") ? "=" : ":";
    const [rawKey, ...rest] = line.split(separator);
    const key = rawKey.trim();
    const item = rest.join(separator).trim();
    if (key && item) out[key] = item;
  }
  return out;
}

function SettingsJsonTab({
  title,
  value,
  onSave,
}: {
  title: string;
  value: unknown;
  onSave: (value: unknown) => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [pristine, setPristine] = useState(text);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const next = JSON.stringify(value ?? {}, null, 2);
    setText(next);
    setPristine(next);
    setError(null);
  }, [value]);

  const dirty = text !== pristine;

  return (
    <div className="system-detail" style={{ width: "100%" }}>
      <div className="system-detail-actions">
        <strong>{title}</strong>
        <span style={{ flex: 1 }} />
        <span className={dirty ? "save-state dirty" : "save-state saved"}>
          {dirty ? t("system.rules.dirty") : t("system.rules.saved")}
        </span>
        <Button
          variant="primary"
          size="sm"
          disabled={!dirty}
          onClick={() => {
            setError(null);
            try {
              const parsed = JSON.parse(text);
              onSave(parsed);
              setPristine(text);
            } catch {
              setError(t("system.mcp.invalidJson"));
            }
          }}
          icon={<Save size={14} />}
        >
          {t("system.rules.save")}
        </Button>
      </div>
      <textarea
        className="source-editor"
        value={text}
        onChange={(event) => setText(event.target.value)}
        spellCheck={false}
      />
      {error ? (
        <div className="toast" title={error}>
          <AlertTriangle size={13} />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}

// =============================== Rules ===============================

function RulesTab({ workPath }: { workPath: string }) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<RuleEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [pristine, setPristine] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await listMaruRules(workPath);
      setEntries(list);
      if (selected && !list.some((e) => e.name === selected)) {
        setSelected(null);
        setContent("");
        setPristine("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workPath, selected]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSelect = useCallback(
    async (name: string) => {
      setError(null);
      try {
        const doc = await readMaruRule(workPath, name);
        setSelected(name);
        setContent(doc.content);
        setPristine(doc.content);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [workPath],
  );

  const onSave = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    setError(null);
    try {
      await saveMaruRule(workPath, selected, content);
      setPristine(content);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [workPath, selected, content, refresh]);

  const onDelete = useCallback(async () => {
    if (!selected) return;
    if (!window.confirm(t("system.rules.delete.confirm"))) return;
    try {
      await deleteMaruRule(workPath, selected);
      setSelected(null);
      setContent("");
      setPristine("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workPath, selected, t, refresh]);

  const onNew = useCallback(async () => {
    const raw = window.prompt("Rule name (lowercase-with-dashes):", "new-rule");
    if (!raw) return;
    const name = raw.trim();
    if (!name) return;
    const stub = `---\nenabled: true\n---\n# ${name}\n\n`;
    try {
      await saveMaruRule(workPath, name, stub);
      await refresh();
      await onSelect(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workPath, refresh, onSelect]);

  const dirty = content !== pristine;

  return (
    <div className="system-split">
      <aside className="system-list">
        <div className="system-list-actions">
          <Button variant="secondary" size="sm" onClick={onNew} icon={<Plus size={13} />}>
            {t("system.rules.new")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void refresh()} icon={<RefreshCcw size={13} />} aria-label={t("app.refresh")} />
        </div>
        {entries.length === 0 ? (
          <p className="muted system-list-empty">{t("system.rules.empty")}</p>
        ) : (
          <ul>
            {entries.map((entry) => (
              <li key={entry.name}>
                <button
                  type="button"
                  className={selected === entry.name ? "system-list-item active" : "system-list-item"}
                  onClick={() => void onSelect(entry.name)}
                >
                  <span className="system-list-item-title">{entry.title}</span>
                  <span className="system-list-item-name muted">{entry.name}</span>
                  {!entry.enabled ? <span className="chip chip-warn">off</span> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
      <section className="system-detail">
        {selected ? (
          <>
            <div className="system-detail-actions">
              <span className={dirty ? "save-state dirty" : "save-state saved"}>
                {dirty ? t("system.rules.dirty") : t("system.rules.saved")}
              </span>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void onSave()}
                disabled={saving || !dirty}
                icon={<Save size={14} />}
              >
                {saving ? t("editor.saving") : t("system.rules.save")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void onDelete()}
                icon={<Trash2 size={14} />}
              >
                {t("system.rules.delete")}
              </Button>
            </div>
            <textarea
              className="source-editor"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              spellCheck={false}
            />
          </>
        ) : (
          <p className="muted">{t("system.rules.empty")}</p>
        )}
        {error ? (
          <div className="toast" title={error}>
            <AlertTriangle size={13} />
            <span>{error}</span>
          </div>
        ) : null}
      </section>
    </div>
  );
}

// ============================ Templates ============================

function TemplatesTab({ workPath }: { workPath: string }) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<TemplateEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [pristine, setPristine] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await listMaruTemplates(workPath);
      setEntries(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSelect = useCallback(
    async (name: string) => {
      try {
        const c = await readMaruTemplate(workPath, name);
        setSelected(name);
        setContent(c);
        setPristine(c);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [workPath],
  );

  const onSave = useCallback(async () => {
    if (!selected) return;
    try {
      await saveMaruTemplate(workPath, selected, content);
      setPristine(content);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workPath, selected, content, refresh]);

  const onDelete = useCallback(async () => {
    if (!selected) return;
    if (!window.confirm(t("system.rules.delete.confirm"))) return;
    try {
      await deleteMaruTemplate(workPath, selected);
      setSelected(null);
      setContent("");
      setPristine("");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workPath, selected, t, refresh]);

  const onNew = useCallback(async () => {
    const raw = window.prompt("Template name (lowercase-with-dashes):", "new-template");
    if (!raw) return;
    const name = raw.trim();
    if (!name) return;
    const stub = `---\ntype: note\n---\n# ${name}\n\n`;
    try {
      await saveMaruTemplate(workPath, name, stub);
      await refresh();
      await onSelect(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workPath, refresh, onSelect]);

  const dirty = content !== pristine;

  return (
    <div className="system-split">
      <aside className="system-list">
        <div className="system-list-actions">
          <Button variant="secondary" size="sm" onClick={onNew} icon={<Plus size={13} />}>
            {t("system.templates.new")}
          </Button>
          <Button variant="ghost" size="sm" onClick={() => void refresh()} icon={<RefreshCcw size={13} />} aria-label={t("app.refresh")} />
        </div>
        {entries.length === 0 ? (
          <p className="muted system-list-empty">{t("system.templates.empty")}</p>
        ) : (
          <ul>
            {entries.map((entry) => (
              <li key={entry.name}>
                <button
                  type="button"
                  className={selected === entry.name ? "system-list-item active" : "system-list-item"}
                  onClick={() => void onSelect(entry.name)}
                >
                  <span className="system-list-item-title">{entry.title}</span>
                  <span className="system-list-item-name muted">{entry.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
      <section className="system-detail">
        {selected ? (
          <>
            <div className="system-detail-actions">
              <span className={dirty ? "save-state dirty" : "save-state saved"}>
                {dirty ? t("system.rules.dirty") : t("system.rules.saved")}
              </span>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void onSave()}
                disabled={!dirty}
                icon={<Save size={14} />}
              >
                {t("system.rules.save")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void onDelete()}
                icon={<Trash2 size={14} />}
              >
                {t("system.rules.delete")}
              </Button>
            </div>
            <textarea
              className="source-editor"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              spellCheck={false}
            />
          </>
        ) : (
          <p className="muted">{t("system.templates.empty")}</p>
        )}
        {error ? (
          <div className="toast" title={error}>
            <AlertTriangle size={13} />
            <span>{error}</span>
          </div>
        ) : null}
      </section>
    </div>
  );
}

// ================================ MCP ================================

function McpTab({ workPath }: { workPath: string }) {
  const { t } = useTranslation();
  const [text, setText] = useState<string>("");
  const [pristine, setPristine] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const value = await readMaruMcp(workPath);
      const json = JSON.stringify(value ?? {}, null, 2);
      setText(json);
      setPristine(json);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSave = useCallback(async () => {
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError(t("system.mcp.invalidJson"));
      return;
    }
    try {
      await saveMaruMcp(workPath, parsed);
      setPristine(text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workPath, text, t]);

  const dirty = text !== pristine;

  return (
    <div className="system-detail" style={{ width: "100%" }}>
      <div className="system-detail-actions">
        <span className={dirty ? "save-state dirty" : "save-state saved"}>
          {dirty ? t("system.rules.dirty") : t("system.rules.saved")}
        </span>
        <Button
          variant="primary"
          size="sm"
          onClick={() => void onSave()}
          disabled={!dirty}
          icon={<Save size={14} />}
        >
          {t("system.mcp.save")}
        </Button>
      </div>
      <textarea
        className="source-editor"
        value={text}
        onChange={(event) => setText(event.target.value)}
        spellCheck={false}
      />
      {error ? (
        <div className="toast" title={error}>
          <AlertTriangle size={13} />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}

// ============================== Projects ==============================

function ProjectsTab({ workPath }: { workPath: string }) {
  const { t } = useTranslation();
  const [value, setValue] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setValue(await readMaruProjects(workPath));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, [workPath]);

  const json = useMemo(() => JSON.stringify(value ?? {}, null, 2), [value]);
  const isEmpty = useMemo(() => {
    if (!value || typeof value !== "object") return true;
    const obj = value as Record<string, unknown>;
    const registry = obj.registry as Record<string, unknown> | undefined;
    if (!registry) return Object.keys(obj).length <= 1; // only "version"
    const cats = (registry as { categories?: unknown[] }).categories;
    return !Array.isArray(cats) || cats.length === 0;
  }, [value]);

  return (
    <div className="system-detail" style={{ width: "100%" }}>
      {isEmpty ? (
        <p className="muted">{t("system.projects.empty")}</p>
      ) : (
        <pre className="system-json-view">{json}</pre>
      )}
      {error ? (
        <div className="toast" title={error}>
          <AlertTriangle size={13} />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}

// =============================== Skills ===============================

type SkillBulkTarget = SkillInstallTarget | "both";

interface SkillOperationState {
  active: boolean;
  label: string;
  total: number;
  completed: number;
  message: string | null;
  errors: string[];
  log: string[];
}

interface SkillConfirmState {
  title: string;
  message: string;
  confirmLabel: string;
  variant: "primary" | "danger";
}

const EMPTY_SKILL_OPERATION: SkillOperationState = {
  active: false,
  label: "",
  total: 0,
  completed: 0,
  message: null,
  errors: [],
  log: [],
};

function skillTargetLabel(
  target: SkillBulkTarget,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (target === "both") return t("system.skills.targetBoth");
  return target === "claude" ? t("system.skills.targetClaude") : t("system.skills.targetCodex");
}

function skillTargetsFor(target: SkillBulkTarget): SkillInstallTarget[] {
  return target === "both" ? ["claude", "codex"] : [target];
}

function makeSkillProgressId(): string {
  return `skills-op-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function progressLogLine(event: SkillProgressEvent): string {
  return `[${event.level}] ${event.message}`;
}

function SkillsTab({ workPath }: { workPath: string }) {
  const { t, locale } = useTranslation();
  const [sources, setSources] = useState<SkillSource[]>([]);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [installs, setInstalls] = useState<SkillInstall[]>([]);
  const [envStatus, setEnvStatus] = useState<SkillsEnvStatus | null>(null);
  const [bundleStatus, setBundleStatus] = useState<SkillBundleStatus | null>(null);
  const [newSkillName, setNewSkillName] = useState("");
  const [newSourceId, setNewSourceId] = useState("");
  const [newSourcePath, setNewSourcePath] = useState("");
  const [newSourceKind, setNewSourceKind] = useState<"linked" | "cloned">("linked");
  const [skillQuery, setSkillQuery] = useState("");
  const [installFilter, setInstallFilter] = useState<"all" | "installed" | "uninstalled" | "dirty">("all");
  const [selectedSkillIds, setSelectedSkillIds] = useState<Set<string>>(() => new Set());
  const [defaultInstallMode, setDefaultInstallMode] = useState<SkillInstallMode>(() =>
    readDefaultInstallMode(),
  );
  const [installModeOverride, setInstallModeOverride] = useState<SkillInstallMode | "default">(
    "default",
  );
  const effectiveInstallMode: SkillInstallMode =
    installModeOverride === "default" ? defaultInstallMode : installModeOverride;
  useEffect(() => {
    writeDefaultInstallMode(defaultInstallMode);
  }, [defaultInstallMode]);
  const [operation, setOperation] = useState<SkillOperationState>(EMPTY_SKILL_OPERATION);
  const [confirmState, setConfirmState] = useState<SkillConfirmState | null>(null);
  const confirmResolverRef = useRef<((confirmed: boolean) => void) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const nextSources = await skillsListSources(workPath);
      const nextSkills = await skillsListSkills(workPath, { refresh: true });
      const nextInstalls = await skillsListInstalls(workPath);
      const nextEnv = await skillsEnvStatus(workPath);
      setSources(nextSources);
      setSkills(nextSkills);
      setInstalls(nextInstalls);
      setEnvStatus(nextEnv);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<SkillsUpdatedPayload>(SKILLS_UPDATED_EVENT, (event) => {
          if (event.payload.workPath === workPath) void refresh();
        }),
      )
      .then((off) => {
        if (disposed) off();
        else unlisten = off;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refresh, workPath]);

  const installKey = useMemo(() => {
    const set = new Set<string>();
    installs.forEach((install) => set.add(`${install.skillId}:${install.target}`));
    return set;
  }, [installs]);
  const installedSkillIds = useMemo(() => {
    const set = new Set<string>();
    installs.forEach((install) => set.add(install.skillId));
    return set;
  }, [installs]);
  const installTargetsBySkill = useMemo(() => {
    const map = new Map<string, Set<SkillInstallTarget>>();
    installs.forEach((install) => {
      const targets = map.get(install.skillId) ?? new Set<SkillInstallTarget>();
      targets.add(install.target);
      map.set(install.skillId, targets);
    });
    return map;
  }, [installs]);
  const installedSkillCount = useMemo(
    () => skills.filter((skill) => installTargetsBySkill.has(skill.id)).length,
    [installTargetsBySkill, skills],
  );
  const claudeInstallCount = useMemo(
    () => installs.filter((install) => install.target === "claude").length,
    [installs],
  );
  const codexInstallCount = useMemo(
    () => installs.filter((install) => install.target === "codex").length,
    [installs],
  );
  const filteredSkills = useMemo(() => {
    const q = skillQuery.trim().toLowerCase();
    return skills.filter((skill) => {
      const targets = installTargetsBySkill.get(skill.id);
      const installed = Boolean(targets?.size);
      if (installFilter === "installed" && !installed) return false;
      if (installFilter === "uninstalled" && installed) return false;
      if (installFilter === "dirty" && !skill.dirty) return false;
      if (!q) return true;
      return [skill.name, skill.title, skill.description ?? "", skill.sourceId, skill.relPath]
        .join(" ")
        .toLowerCase()
        .includes(q);
    });
  }, [installFilter, installTargetsBySkill, skillQuery, skills]);
  const skillFilterOptions: Array<[
    typeof installFilter,
    string,
    number,
  ]> = [
    ["all", t("system.skills.filter.all"), skills.length],
    ["installed", t("system.skills.filter.installed"), installedSkillCount],
    ["uninstalled", t("system.skills.filter.open"), Math.max(skills.length - installedSkillCount, 0)],
    ["dirty", t("system.skills.filter.dirty"), skills.filter((skill) => skill.dirty).length],
  ];
  const selectedSkills = useMemo(
    () => skills.filter((skill) => selectedSkillIds.has(skill.id)),
    [selectedSkillIds, skills],
  );
  const selectedInstalledTaskCount = useMemo(
    () =>
      selectedSkills.reduce(
        (count, skill) => count + (installTargetsBySkill.get(skill.id)?.size ?? 0),
        0,
      ),
    [installTargetsBySkill, selectedSkills],
  );

  useEffect(() => {
    setSelectedSkillIds((prev) => {
      const liveIds = new Set(skills.map((skill) => skill.id));
      const next = new Set([...prev].filter((id) => liveIds.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [skills]);

  const startOperation = useCallback((label: string, total = 0) => {
    setOperation({
      active: true,
      label,
      total,
      completed: 0,
      message: null,
      errors: [],
      log: [],
    });
  }, []);

  const finishOperation = useCallback((message: string, errors: string[] = []) => {
    setOperation((prev) => ({
      ...prev,
      active: false,
      completed: prev.total,
      message,
      errors,
    }));
  }, []);

  const appendOperationLog = useCallback((message: string) => {
    setOperation((prev) => ({
      ...prev,
      log: [...prev.log.slice(-79), message],
    }));
  }, []);

  const updateOperationProgress = useCallback((completed: number, total: number) => {
    setOperation((prev) => ({
      ...prev,
      completed: Math.min(completed, total),
      total,
    }));
  }, []);

  const recordOperationError = useCallback((message: string) => {
    setOperation((prev) => ({
      ...prev,
      errors: [...prev.errors, message],
    }));
  }, []);

  const stepOperation = useCallback(() => {
    setOperation((prev) => ({
      ...prev,
      completed: Math.min(prev.completed + 1, prev.total),
    }));
  }, []);

  const runOperation = useCallback(
    async <T,>(
      label: string,
      total: number,
      task: () => Promise<T>,
      completeMessage: (result: T) => string,
    ): Promise<T | null> => {
      setBusy(true);
      setError(null);
      startOperation(label, total);
      try {
        const result = await task();
        finishOperation(completeMessage(result));
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        finishOperation(message, [message]);
        return null;
      } finally {
        setBusy(false);
      }
    },
    [finishOperation, startOperation],
  );

  const runBackendProgressOperation = useCallback(
    async <T,>(
      label: string,
      total: number,
      task: (progressId: string) => Promise<T>,
      completeMessage: (result: T) => string,
    ): Promise<T | null> => {
      setBusy(true);
      setError(null);
      startOperation(label, total);
      const progressId = makeSkillProgressId();
      let unlisten: (() => void) | null = null;
      try {
        const { listen } = await import("@tauri-apps/api/event");
        unlisten = await listen<SkillProgressEvent>("skills-op://progress", (event) => {
          if (event.payload.progressId !== progressId) return;
          appendOperationLog(progressLogLine(event.payload));
          if (
            typeof event.payload.completed === "number" &&
            typeof event.payload.total === "number"
          ) {
            updateOperationProgress(event.payload.completed, event.payload.total);
          }
          if (event.payload.level === "error") recordOperationError(event.payload.message);
        });
        const result = await task(progressId);
        finishOperation(completeMessage(result));
        return result;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        finishOperation(message, [message]);
        return null;
      } finally {
        unlisten?.();
        setBusy(false);
      }
    },
    [
      appendOperationLog,
      finishOperation,
      recordOperationError,
      startOperation,
      updateOperationProgress,
    ],
  );

  const refreshWithProgress = useCallback(async () => {
    setBusy(true);
    setError(null);
    startOperation(t("system.skills.refreshing"), 4);
    try {
      appendOperationLog(t("system.skills.log.refreshSources"));
      const nextSources = await skillsListSources(workPath);
      setSources(nextSources);
      stepOperation();

      appendOperationLog(t("system.skills.log.refreshSkills"));
      const nextSkills = await skillsListSkills(workPath, { refresh: true });
      setSkills(nextSkills);
      stepOperation();

      appendOperationLog(t("system.skills.log.refreshInstalls"));
      const nextInstalls = await skillsListInstalls(workPath);
      setInstalls(nextInstalls);
      stepOperation();

      appendOperationLog(t("system.skills.log.refreshEnv"));
      const nextEnv = await skillsEnvStatus(workPath);
      setEnvStatus(nextEnv);
      stepOperation();

      finishOperation(t("system.skills.refreshComplete"));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      finishOperation(message, [message]);
    } finally {
      setBusy(false);
    }
  }, [appendOperationLog, finishOperation, startOperation, stepOperation, t, workPath]);

  const toggleSkillSelection = useCallback((skillId: string) => {
    setSelectedSkillIds((prev) => {
      const next = new Set(prev);
      if (next.has(skillId)) next.delete(skillId);
      else next.add(skillId);
      return next;
    });
  }, []);

  const selectFilteredSkills = useCallback(() => {
    setSelectedSkillIds(new Set(filteredSkills.map((skill) => skill.id)));
  }, [filteredSkills]);

  const clearSkillSelection = useCallback(() => {
    setSelectedSkillIds(new Set());
  }, []);

  const sourceHasInstalledSkills = useCallback(
    (sourceId: string) =>
      skills.some((skill) => skill.sourceId === sourceId && installedSkillIds.has(skill.id)),
    [installedSkillIds, skills],
  );

  const closeConfirmation = useCallback((confirmed: boolean) => {
    const resolve = confirmResolverRef.current;
    confirmResolverRef.current = null;
    setConfirmState(null);
    resolve?.(confirmed);
  }, []);

  const confirmAction = useCallback(
    (
      message: string,
      options: {
        confirmLabel?: string;
        title?: string;
        variant?: "primary" | "danger";
      } = {},
    ) =>
      new Promise<boolean>((resolve) => {
        if (confirmResolverRef.current) {
          resolve(false);
          return;
        }
        confirmResolverRef.current = resolve;
        setConfirmState({
          title: options.title ?? t("system.skills.confirmTitle"),
          message,
          confirmLabel: options.confirmLabel ?? t("system.skills.confirmProceed"),
          variant: options.variant ?? "primary",
        });
      }),
    [t],
  );

  const openSkillEditor = useCallback(async (skill: SkillRecord) => {
    setError(null);
    try {
      await openSkillEditorWindow(workPath, skill.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workPath]);

  const addSource = useCallback(async () => {
    const id = newSourceId.trim();
    const path = newSourcePath.trim();
    if (!id || !path) return;
    if (!(await confirmAction(t("system.skills.addSourceConfirm", { id })))) return;
    await runOperation(
      t("system.skills.addingSource", { id }),
      3,
      async () => {
        appendOperationLog(t("system.skills.log.addSource", { id }));
        await skillsAddSource({
          id,
          kind: newSourceKind,
          path: newSourceKind === "linked" ? path : null,
          repoUrl: newSourceKind === "cloned" ? path : null,
          skillsSubdir: "skills",
        });
        stepOperation();
        setNewSourceId("");
        setNewSourcePath("");
        appendOperationLog(t("system.skills.log.sourceAdded", { id }));
        stepOperation();
        appendOperationLog(t("system.skills.log.refreshSkills"));
        await refresh();
        stepOperation();
        return id;
      },
      (sourceId) => t("system.skills.addSourceComplete", { id: sourceId }),
    );
  }, [
    appendOperationLog,
    confirmAction,
    newSourceId,
    newSourceKind,
    newSourcePath,
    refresh,
    runOperation,
    stepOperation,
    t,
  ]);

  const rescanSource = useCallback(
    async (source: SkillSource) => {
      if (!(await confirmAction(t("system.skills.rescanConfirm", { id: source.id })))) return;
      await runBackendProgressOperation(
        t("system.skills.rescanningSource", { id: source.id }),
        1,
        async (progressId) => {
          const records = await skillsRescanSource(source.id, progressId);
          appendOperationLog(t("system.skills.log.refreshSkills"));
          await refresh();
          return records;
        },
        (records) =>
          t("system.skills.rescanComplete", { id: source.id, count: records.length }),
      );
    },
    [appendOperationLog, confirmAction, refresh, runBackendProgressOperation, t],
  );

  const syncSource = useCallback(
    async (source: SkillSource) => {
      if (!(await confirmAction(t("system.skills.syncConfirm", { id: source.id })))) return;
      await runBackendProgressOperation(
        t("system.skills.syncingSource", { id: source.id }),
        1,
        async (progressId) => {
          const records = await skillsSyncSource(source.id, progressId);
          appendOperationLog(t("system.skills.log.refreshSkills"));
          await refresh();
          return records;
        },
        (records) => t("system.skills.syncComplete", { id: source.id, count: records.length }),
      );
    },
    [appendOperationLog, confirmAction, refresh, runBackendProgressOperation, t],
  );

  const syncAllSources = useCallback(async () => {
    if (sources.length === 0) return;
    if (!(await confirmAction(t("system.skills.syncAllConfirm", { count: sources.length })))) {
      return;
    }
    await runBackendProgressOperation(
      t("system.skills.syncingAll"),
      sources.length,
      async (progressId) => {
        const outcome = await skillsSyncAllSources(workPath, progressId);
        appendOperationLog(t("system.skills.log.refreshSkills"));
        await refresh();
        return outcome;
      },
      (outcome) =>
        t("system.skills.syncAllComplete", {
          succeeded: outcome.succeeded,
          failed: outcome.failed,
        }),
    );
  }, [appendOperationLog, confirmAction, refresh, runBackendProgressOperation, sources.length, t, workPath]);

  const loadBundleStatus = useCallback(async () => {
    try {
      setBundleStatus(await skillsBundleStatus());
    } catch {
      // Best-effort: the pane works without bundle status.
    }
  }, []);

  useEffect(() => {
    void loadBundleStatus();
  }, [loadBundleStatus]);

  // A bundle applied elsewhere (launch auto-update, CLI) invalidates the
  // skill list and bundle status without any local action.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen("skills://updated", () => {
          void refresh();
          void loadBundleStatus();
        }),
      )
      .then((off) => {
        if (disposed) {
          off();
        } else {
          unlisten = off;
        }
      })
      .catch(() => {
        // Non-Tauri shells have no event bus.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [loadBundleStatus, refresh]);

  const checkBundleUpdate = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setBundleStatus(await skillsCheckBundleUpdate());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  const applyBundleUpdate = useCallback(async () => {
    const repairEnv = Boolean(bundleStatus?.envUpdateRequired);
    const version = bundleStatus?.available?.displayVersion ?? "";
    if (
      !(await confirmAction(
        repairEnv
          ? t("system.skills.bundleApplyEnvConfirm", { version })
          : t("system.skills.bundleApplyConfirm", { version }),
      ))
    ) {
      return;
    }
    await runBackendProgressOperation(
      t("system.skills.bundleApplying", { version }),
      1,
      async (progressId) => {
        const outcome = await skillsApplyBundleUpdate({ repairEnv, progressId });
        appendOperationLog(t("system.skills.log.refreshSkills"));
        await refresh();
        await loadBundleStatus();
        return outcome;
      },
      (outcome) =>
        outcome
          ? t("system.skills.bundleApplied", {
              version: outcome.current.displayVersion,
              added: outcome.addedSkills.length,
              updated: outcome.updatedSkills.length,
              removed: outcome.removedSkills.length,
            })
          : t("system.skills.bundleApplyFailed"),
    );
  }, [
    appendOperationLog,
    bundleStatus,
    confirmAction,
    loadBundleStatus,
    refresh,
    runBackendProgressOperation,
    t,
  ]);

  const removeSource = useCallback(
    async (source: SkillSource) => {
      if (source.kind === "managed" || source.id === "maru-managed") {
        setError(t("system.skills.removeManagedSourceBlocked"));
        return;
      }
      if (sourceHasInstalledSkills(source.id)) {
        setError(t("system.skills.removeSourceInstalledBlocked", { id: source.id }));
        return;
      }
      if (
        !(await confirmAction(t("system.skills.removeSourceConfirm", { id: source.id }), {
          variant: "danger",
        }))
      ) {
        return;
      }
      const removedSkillIds = new Set(
        skills.filter((skill) => skill.sourceId === source.id).map((skill) => skill.id),
      );
      setBusy(true);
      setError(null);
      startOperation(t("system.skills.removingSource", { id: source.id }), 3);
      appendOperationLog(
        t("system.skills.log.removeSourceStart", {
          id: source.id,
          count: removedSkillIds.size,
        }),
      );
      try {
        await skillsRemoveSource(source.id);
        stepOperation();
        appendOperationLog(t("system.skills.log.optimisticRemove", { id: source.id }));
        setSources((prev) => prev.filter((item) => item.id !== source.id));
        setSkills((prev) => prev.filter((skill) => skill.sourceId !== source.id));
        setSelectedSkillIds((prev) => {
          const next = new Set([...prev].filter((skillId) => !removedSkillIds.has(skillId)));
          return next.size === prev.size ? prev : next;
        });
        stepOperation();
        appendOperationLog(t("system.skills.log.refreshSkills"));
        await refresh();
        stepOperation();
        finishOperation(t("system.skills.removeSourceComplete", { id: source.id }));
      } catch (err) {
        const rawMessage = err instanceof Error ? err.message : String(err);
        const message =
          rawMessage === "source_has_installed_skills"
            ? t("system.skills.removeSourceInstalledBlocked", { id: source.id })
            : rawMessage === "source_not_removable"
              ? t("system.skills.removeManagedSourceBlocked")
            : rawMessage;
        setError(message);
        finishOperation(message, [message]);
      } finally {
        setBusy(false);
      }
    },
    [
      appendOperationLog,
      confirmAction,
      finishOperation,
      refresh,
      skills,
      sourceHasInstalledSkills,
      startOperation,
      stepOperation,
      t,
    ],
  );

  const createManagedSkill = useCallback(async () => {
    const name = newSkillName.trim();
    if (!name) return;
    if (!(await confirmAction(t("system.skills.createSkillConfirm", { name })))) return;
    await runOperation(
      t("system.skills.creatingSkill", { name }),
      3,
      async () => {
        appendOperationLog(t("system.skills.log.createSkill", { name }));
        const skill = await skillsCreateSkill(name, null);
        setNewSkillName("");
        stepOperation();
        appendOperationLog(t("system.skills.log.refreshSkills"));
        await refresh();
        stepOperation();
        appendOperationLog(t("system.skills.log.openSkill", { name: skill.name }));
        await openSkillEditor(skill);
        stepOperation();
        return skill;
      },
      (skill) => t("system.skills.createSkillComplete", { name: skill.name }),
    );
  }, [
    appendOperationLog,
    confirmAction,
    newSkillName,
    openSkillEditor,
    refresh,
    runOperation,
    stepOperation,
    t,
  ]);

  const installSkills = useCallback(
    async (
      skillList: SkillRecord[],
      target: SkillBulkTarget,
      mode: SkillInstallMode = effectiveInstallMode,
    ) => {
      const targets = skillTargetsFor(target);
      const tasks = skillList.flatMap((skill) =>
        targets
          .filter((nextTarget) => !installKey.has(`${skill.id}:${nextTarget}`))
          .map((nextTarget) => ({ skill, target: nextTarget })),
      );
      const targetLabel = skillTargetLabel(target, t);
      if (tasks.length === 0) {
        setOperation({
          ...EMPTY_SKILL_OPERATION,
          label: t("system.skills.installing", { target: targetLabel }),
          message: t("system.skills.installComplete", {
            claude: 0,
            codex: 0,
            failed: 0,
          }),
          log: [t("system.skills.log.noInstallTasks")],
        });
        return;
      }
      if (
        !(await confirmAction(
          t("system.skills.installConfirm", {
            count: tasks.length,
            target: targetLabel,
            mode: t(`system.skills.installMode.${mode}`),
          }),
        ))
      ) {
        return;
      }
      setBusy(true);
      setError(null);
      startOperation(t("system.skills.installing", { target: targetLabel }), tasks.length);
      const failures: string[] = [];
      const installed = { claude: 0, codex: 0 };
      try {
        for (const task of tasks) {
          appendOperationLog(
            t("system.skills.log.installStart", {
              name: task.skill.name,
              target: skillTargetLabel(task.target, t),
            }),
          );
          try {
            await skillsInstallSkill(task.skill.id, task.target, task.skill.name, mode);
            installed[task.target] += 1;
            appendOperationLog(
              t("system.skills.log.installDone", {
                name: task.skill.name,
                target: skillTargetLabel(task.target, t),
              }),
            );
          } catch (err) {
            const message = `${task.skill.name} / ${task.target}: ${
              err instanceof Error ? err.message : String(err)
            }`;
            failures.push(message);
            recordOperationError(message);
            appendOperationLog(
              t("system.skills.log.installFailed", {
                name: task.skill.name,
                target: skillTargetLabel(task.target, t),
              }),
            );
          } finally {
            stepOperation();
          }
        }
        appendOperationLog(t("system.skills.log.refreshSkills"));
        await refresh();
        finishOperation(
          t("system.skills.installComplete", {
            claude: installed.claude,
            codex: installed.codex,
            failed: failures.length,
          }),
          failures,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        finishOperation(err instanceof Error ? err.message : String(err), failures);
      } finally {
        setBusy(false);
      }
    },
    [
      appendOperationLog,
      confirmAction,
      effectiveInstallMode,
      finishOperation,
      installKey,
      recordOperationError,
      refresh,
      startOperation,
      stepOperation,
      t,
    ],
  );

  const uninstallInstalls = useCallback(
    async (items: SkillInstall[]) => {
      if (items.length === 0) {
        setOperation({
          ...EMPTY_SKILL_OPERATION,
          label: t("system.skills.uninstalling"),
          message: t("system.skills.uninstallComplete", { count: 0, failed: 0 }),
          log: [t("system.skills.log.noUninstallTasks")],
        });
        return;
      }
      if (
        !(await confirmAction(t("system.skills.uninstallConfirm", { count: items.length }), {
          variant: "danger",
        }))
      ) {
        return;
      }
      setBusy(true);
      setError(null);
      startOperation(t("system.skills.uninstalling"), items.length);
      const failures: string[] = [];
      let removed = 0;
      try {
        for (const item of items) {
          appendOperationLog(
            t("system.skills.log.uninstallStart", {
              name: item.installedAs,
              target: skillTargetLabel(item.target, t),
            }),
          );
          try {
            await skillsUninstallSkill(item.target, item.installedAs);
            removed += 1;
            appendOperationLog(
              t("system.skills.log.uninstallDone", {
                name: item.installedAs,
                target: skillTargetLabel(item.target, t),
              }),
            );
          } catch (err) {
            const message = `${item.installedAs} / ${item.target}: ${
              err instanceof Error ? err.message : String(err)
            }`;
            failures.push(message);
            recordOperationError(message);
            appendOperationLog(
              t("system.skills.log.uninstallFailed", {
                name: item.installedAs,
                target: skillTargetLabel(item.target, t),
              }),
            );
          } finally {
            stepOperation();
          }
        }
        appendOperationLog(t("system.skills.log.refreshSkills"));
        await refresh();
        finishOperation(
          t("system.skills.uninstallComplete", { count: removed, failed: failures.length }),
          failures,
        );
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        finishOperation(err instanceof Error ? err.message : String(err), failures);
      } finally {
        setBusy(false);
      }
    },
    [
      appendOperationLog,
      confirmAction,
      finishOperation,
      recordOperationError,
      refresh,
      startOperation,
      stepOperation,
      t,
    ],
  );

  const install = useCallback(
    async (skill: SkillRecord, target: SkillInstallTarget) => {
      await installSkills([skill], target);
    },
    [installSkills],
  );

  const uninstall = useCallback(
    async (skill: SkillRecord, target: SkillInstallTarget) => {
      const existing = installs.find(
        (item) => item.skillId === skill.id && item.target === target,
      );
      if (!existing) return;
      await uninstallInstalls([existing]);
    },
    [installs, uninstallInstalls],
  );

  const uninstallSelected = useCallback(async () => {
    const selected = new Set(selectedSkillIds);
    await uninstallInstalls(installs.filter((installItem) => selected.has(installItem.skillId)));
  }, [installs, selectedSkillIds, uninstallInstalls]);

  const adoptExternalLinks = useCallback(async () => {
    if (!(await confirmAction(t("system.skills.adoptConfirm")))) return;
    await runBackendProgressOperation(
      t("system.skills.adopting"),
      1,
      async (progressId) => {
        const outcome = await skillsAdoptExternalLinks(progressId);
        appendOperationLog(t("system.skills.log.refreshSkills"));
        await refresh();
        return outcome;
      },
      (outcome) =>
        t("system.skills.adoptComplete", {
          adopted: outcome.adopted,
          skipped: outcome.skipped,
        }),
    );
  }, [appendOperationLog, confirmAction, refresh, runBackendProgressOperation, t]);

  const bootstrapEnv = useCallback(async () => {
    if (!(await confirmAction(t("system.skills.bootstrapConfirm")))) return;
    setBusy(true);
    setError(null);
    startOperation(t("system.skills.bootstrapping"), 1);
    let unlistenOutput: (() => void) | null = null;
    let unlistenDone: (() => void) | null = null;
    let invocationId: string | null = null;
    try {
      const { listen } = await import("@tauri-apps/api/event");
      type SkillsEnvDonePayload = {
        invocationId: string;
        success: boolean;
        exitCode: number | null;
      };
      type SkillsEnvOutputPayload = {
        invocationId: string;
        stream: string;
        line: string;
      };
      const pendingDone: SkillsEnvDonePayload[] = [];
      const pendingOutput: SkillsEnvOutputPayload[] = [];
      const handleOutput = (payload: SkillsEnvOutputPayload) => {
        setOperation((prev) => ({
          ...prev,
          log: [...prev.log.slice(-11), `[${payload.stream}] ${payload.line}`],
        }));
      };
      unlistenOutput = await listen<SkillsEnvOutputPayload>("skills-env://output", (event) => {
        if (invocationId === null) {
          pendingOutput.push(event.payload);
          return;
        }
        if (event.payload.invocationId !== invocationId) return;
        handleOutput(event.payload);
      });
      let resolveDone: () => void = () => {};
      const donePromise = new Promise<void>((resolve) => {
        resolveDone = resolve;
      });
      const handleDone = (payload: SkillsEnvDonePayload) => {
        if (payload.success) {
          stepOperation();
          finishOperation(t("system.skills.bootstrapComplete"));
        } else {
          const message = t("system.skills.bootstrapFailed", {
            code: payload.exitCode ?? "unknown",
          });
          setError(message);
          finishOperation(message, [message]);
        }
        resolveDone();
      };
      unlistenDone = await listen<SkillsEnvDonePayload>("skills-env://done", (event) => {
        if (invocationId === null) {
          pendingDone.push(event.payload);
          return;
        }
        if (event.payload.invocationId !== invocationId) return;
        handleDone(event.payload);
      });
      invocationId = await skillsEnvBootstrap(workPath);
      pendingOutput
        .filter((payload) => payload.invocationId === invocationId)
        .forEach(handleOutput);
      const earlyDone = pendingDone.find((payload) => payload.invocationId === invocationId);
      if (earlyDone) {
        handleDone(earlyDone);
      }
      await donePromise;
      await refresh();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      finishOperation(message, [message]);
    } finally {
      unlistenOutput?.();
      unlistenDone?.();
      setBusy(false);
    }
  }, [confirmAction, finishOperation, refresh, startOperation, stepOperation, t, workPath]);

  const resetRegistry = useCallback(async () => {
    if (
      !(await confirmAction(t("system.skills.resetConfirm"), {
        variant: "danger",
      }))
    ) {
      return;
    }
    await runBackendProgressOperation(
      t("system.skills.resetting"),
      1,
      async (progressId) => {
        const outcome = await skillsResetRegistry(workPath, progressId);
        appendOperationLog(t("system.skills.log.refreshSkills"));
        await refresh();
        return outcome;
      },
      (outcome) =>
        t("system.skills.resetComplete", {
          sources: outcome.sources,
          skills: outcome.skills,
        }),
    );
  }, [appendOperationLog, confirmAction, refresh, runBackendProgressOperation, t, workPath]);

  return (
    <div className="system-detail skills-system-detail" style={{ width: "100%" }}>
      <div className="skills-overview">
        <div className="skills-overview-title">
          <PackageCheck size={18} />
          <div>
            <h3>{t("system.skills.catalogTitle")}</h3>
            <p>{t("system.skills.globalStore")}</p>
          </div>
        </div>
        <div className="skills-metrics" aria-label={t("system.skills.summary")}>
          <span className="skills-metric">
            <strong>{sources.length}</strong>
            <span>{t("system.skills.sources")}</span>
          </span>
          <span className="skills-metric">
            <strong>{skills.length}</strong>
            <span>{t("system.skills.skills")}</span>
          </span>
          <span className="skills-metric">
            <strong>{claudeInstallCount}</strong>
            <span>Claude</span>
          </span>
          <span className="skills-metric">
            <strong>{codexInstallCount}</strong>
            <span>Codex</span>
          </span>
        </div>
        <div className="skills-overview-actions">
          <span className={envStatus?.healthy ? "skill-status-pill installed" : "skill-status-pill warn"}>
            <ShieldCheck size={12} />
            {envStatus?.healthy ? t("system.skills.envReady") : t("system.skills.envSetup")}
          </span>
          <span
            className={
              bundleStatus?.updateAvailable
                ? "skill-status-pill warn"
                : "skill-status-pill installed"
            }
            title={
              bundleStatus?.dirtySkills.length
                ? t("system.skills.bundleDirtyHint", {
                    skills: bundleStatus.dirtySkills.join(", "),
                  })
                : undefined
            }
          >
            {t("system.skills.bundleActive", {
              version: bundleStatus?.active?.displayVersion ?? "-",
            })}
          </span>
          {bundleStatus?.updateAvailable ? (
            <Button
              variant="primary"
              size="sm"
              onClick={() => void applyBundleUpdate()}
              disabled={
                busy ||
                bundleStatus.dirtySkills.length > 0 ||
                !bundleStatus.minAppOk
              }
              title={
                bundleStatus.dirtySkills.length > 0
                  ? t("system.skills.bundleDirtyHint", {
                      skills: bundleStatus.dirtySkills.join(", "),
                    })
                  : !bundleStatus.minAppOk
                    ? t("system.skills.bundleAppTooOld", {
                        version: bundleStatus.available?.minAppVersion ?? "",
                      })
                    : undefined
              }
            >
              {t("system.skills.bundleApply", {
                version: bundleStatus.available?.displayVersion ?? "",
              })}
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void checkBundleUpdate()}
              disabled={busy}
            >
              {t("system.skills.bundleCheck")}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void refreshWithProgress()}
            disabled={busy}
            icon={<RefreshCcw size={14} className={busy ? "spin" : ""} />}
          >
            {t("system.skills.refresh")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void syncAllSources()}
            disabled={busy || sources.length === 0}
            icon={<RefreshCcw size={14} />}
          >
            {t("system.skills.syncAll")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void adoptExternalLinks()}
            disabled={busy}
          >
            {t("system.skills.adopt")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void bootstrapEnv()}
            disabled={busy}
            icon={<Wrench size={14} />}
          >
            {t("system.skills.bootstrap")}
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={() => void resetRegistry()}
            disabled={busy}
          >
            {t("system.skills.reset")}
          </Button>
        </div>
        <div className="skills-install-mode">
          <span className="skills-install-mode-label">
            {t("system.skills.installMode.label")}
          </span>
          <div
            className="skills-source-kind skills-install-mode-toggle"
            role="group"
            aria-label={t("system.skills.installMode.label")}
          >
            <button
              type="button"
              aria-pressed={defaultInstallMode === "symlink"}
              className={defaultInstallMode === "symlink" ? "active" : ""}
              onClick={() => setDefaultInstallMode("symlink")}
            >
              {t("system.skills.installMode.symlink")}
            </button>
            <button
              type="button"
              aria-pressed={defaultInstallMode === "copy"}
              className={defaultInstallMode === "copy" ? "active" : ""}
              onClick={() => setDefaultInstallMode("copy")}
            >
              {t("system.skills.installMode.copy")}
            </button>
          </div>
          {defaultInstallMode === "copy" ? (
            <span className="skills-install-mode-note">
              {t("system.skills.installMode.copyWarning")}
            </span>
          ) : null}
        </div>
      </div>
      {operation.active || operation.message || operation.errors.length > 0 ? (
        <div className={operation.errors.length > 0 ? "skills-operation warn" : "skills-operation"}>
          <div className="skills-operation-head">
            <strong>{operation.label || t("system.skills.operation")}</strong>
            <span>
              {operation.total > 0
                ? t("system.skills.progress", {
                    completed: operation.completed,
                    total: operation.total,
                  })
                : null}
            </span>
          </div>
          {operation.message ? <p>{operation.message}</p> : null}
          {operation.log.length > 0 ? (
            <pre>{operation.log.join("\n")}</pre>
          ) : null}
          {operation.errors.length > 0 ? (
            <ul>
              {operation.errors.slice(0, 6).map((item, index) => (
                <li key={`${index}:${item}`}>{item}</li>
              ))}
              {operation.errors.length > 6 ? (
                <li>{t("system.skills.moreErrors", { count: operation.errors.length - 6 })}</li>
              ) : null}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="skills-manager-grid">
        <section className="skills-manager-section sources">
          <div className="skills-section-heading">
            <h3>{t("system.skills.sources")}</h3>
            <span>{sources.length}</span>
          </div>
          <div className="system-card source-add-card">
            <div className="skills-source-kind">
              <button
                type="button"
                className={newSourceKind === "linked" ? "active" : ""}
                onClick={() => setNewSourceKind("linked")}
              >
                {t("system.skills.sourceKind.linked")}
              </button>
              <button
                type="button"
                className={newSourceKind === "cloned" ? "active" : ""}
                onClick={() => setNewSourceKind("cloned")}
              >
                {t("system.skills.sourceKind.cloned")}
              </button>
            </div>
            <label className="field">
              <span>{t("system.skills.sourceId")}</span>
              <input
                value={newSourceId}
                onChange={(event) => setNewSourceId(event.target.value)}
                placeholder={t("system.skills.sourceIdPlaceholder")}
              />
            </label>
            <label className="field">
              <span>
                {newSourceKind === "linked"
                  ? t("system.skills.path")
                  : t("system.skills.repoUrl")}
              </span>
              <input
                value={newSourcePath}
                onChange={(event) => setNewSourcePath(event.target.value)}
                placeholder={
                  newSourceKind === "linked"
                    ? t("system.skills.linkedPathPlaceholder")
                    : t("system.skills.repoUrlPlaceholder")
                }
              />
            </label>
            <Button
              variant="secondary"
              size="sm"
              disabled={!newSourceId.trim() || !newSourcePath.trim() || busy}
              onClick={() => void addSource()}
            >
              {t("system.skills.addSource")}
            </Button>
          </div>
          <ul className="system-skill-list compact">
            {sources.map((source) => {
              const sourceRemovable =
                source.kind !== "managed" &&
                source.kind !== "builtin" &&
                source.id !== "maru-managed";
              const sourceHasInstalls = sourceHasInstalledSkills(source.id);
              const removeTitle = sourceHasInstalls
                  ? t("system.skills.removeSourceInstalledBlocked", { id: source.id })
                  : t("system.skills.removeSource");
              return (
                <li className="system-skill-card source-card" key={source.id}>
                  <div className="source-card-top">
                    <div>
                      <div className="system-skill-name">{source.id}</div>
                      <div className="system-skill-meta">
                        <span className="skill-status-pill subtle">{source.kind}</span>
                        <span>
                          <code>{source.skillsSubdir}</code>
                        </span>
                        <span title={source.lastSyncedAt ?? ""}>
                          {source.lastSyncedAt
                            ? t("system.skills.lastSynced", {
                                when: formatRelativeDate(source.lastSyncedAt, locale),
                              })
                            : t("system.skills.neverSynced")}
                        </span>
                      </div>
                    </div>
                    <div className="source-card-actions">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void rescanSource(source)}
                        disabled={busy}
                      >
                        {t("system.skills.rescan")}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => void syncSource(source)}
                        disabled={busy}
                      >
                        {t("system.skills.sync")}
                      </Button>
                      {sourceRemovable ? (
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => void removeSource(source)}
                          disabled={busy || sourceHasInstalls}
                          title={removeTitle}
                        >
                          {t("system.skills.removeSource")}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  <div className="skill-path" title={source.path ?? source.repoUrl ?? ""}>
                    {source.path ?? source.repoUrl ?? t("system.skills.managedSource")}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="system-card skill-env-card">
            <div className="skills-section-heading">
              <h3>{t("system.skills.env")}</h3>
              <span className={envStatus?.healthy ? "skill-status-pill installed" : "skill-status-pill warn"}>
                {envStatus?.healthy ? t("system.skills.healthy") : t("system.skills.setup")}
              </span>
            </div>
            {envStatus ? (
              <>
                <div className="skill-path" title={envStatus.root}>{envStatus.root}</div>
                <div className="system-skill-meta">
                  <span>
                    {envStatus.venvExists
                      ? t("system.skills.venvReady")
                      : t("system.skills.venvMissing")}
                  </span>
                  <span>
                    {envStatus.nodeModulesExists
                      ? t("system.skills.nodeReady")
                      : t("system.skills.nodeMissing")}
                  </span>
                </div>
                {envStatus.lastError ? <p className="inline-error">{envStatus.lastError}</p> : null}
              </>
            ) : (
              <p className="muted">{t("system.skills.envUnavailable")}</p>
            )}
          </div>
        </section>

        <section className="skills-manager-section wide">
          <div className="skills-catalog-head">
            <div className="skills-section-heading">
              <h3>{t("system.skills.skills")}</h3>
              <span>{filteredSkills.length}/{skills.length}</span>
            </div>
            <div className="skills-create-row">
              <label className="field">
                <span>{t("system.skills.newManaged")}</span>
                <input
                  value={newSkillName}
                  onChange={(event) => setNewSkillName(event.target.value)}
                  placeholder={t("system.skills.skillNamePlaceholder")}
                />
              </label>
              <Button
                variant="secondary"
                size="sm"
                icon={<Plus size={14} />}
                disabled={!newSkillName.trim() || busy}
                onClick={() => void createManagedSkill()}
              >
                {t("system.skills.create")}
              </Button>
            </div>
            <div className="skills-list-controls">
              <label className="search-box skills-search" title={t("system.skills.search")}>
                <Search size={14} />
                <input
                  value={skillQuery}
                  onChange={(event) => setSkillQuery(event.target.value)}
                  placeholder={t("system.skills.searchPlaceholder")}
                />
              </label>
              <div
                className="segmented-control compact skills-filter"
                role="group"
                aria-label={t("system.skills.installFilter")}
              >
                {skillFilterOptions.map(([id, label, count]) => (
                  <button
                    key={id}
                    type="button"
                    className={installFilter === id ? "active" : ""}
                    onClick={() => setInstallFilter(id)}
                  >
                    <span>{label}</span>
                    <strong>{count}</strong>
                  </button>
                ))}
              </div>
            </div>
            <div className="skills-bulk-toolbar">
              <span>
                {t("system.skills.selected", {
                  count: selectedSkillIds.size,
                })}
              </span>
              <div
                className="skills-source-kind skills-install-mode-toggle"
                role="group"
                aria-label={t("system.skills.installMode.override")}
                title={t("system.skills.installMode.override")}
              >
                <button
                  type="button"
                  aria-pressed={installModeOverride === "default"}
                  className={installModeOverride === "default" ? "active" : ""}
                  onClick={() => setInstallModeOverride("default")}
                >
                  {t("system.skills.installMode.default")}
                </button>
                <button
                  type="button"
                  aria-pressed={installModeOverride === "symlink"}
                  className={installModeOverride === "symlink" ? "active" : ""}
                  onClick={() => setInstallModeOverride("symlink")}
                >
                  {t("system.skills.installMode.symlink")}
                </button>
                <button
                  type="button"
                  aria-pressed={installModeOverride === "copy"}
                  className={installModeOverride === "copy" ? "active" : ""}
                  onClick={() => setInstallModeOverride("copy")}
                >
                  {t("system.skills.installMode.copy")}
                </button>
              </div>
              <Button variant="ghost" size="sm" onClick={selectFilteredSkills} disabled={busy}>
                {t("system.skills.selectVisible")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={clearSkillSelection}
                disabled={busy || selectedSkillIds.size === 0}
              >
                {t("system.skills.clearSelection")}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void installSkills(selectedSkills, "claude")}
                disabled={busy || selectedSkillIds.size === 0}
              >
                {t("system.skills.installSelectedTarget", { target: "Claude" })}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void installSkills(selectedSkills, "codex")}
                disabled={busy || selectedSkillIds.size === 0}
              >
                {t("system.skills.installSelectedTarget", { target: "Codex" })}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void installSkills(selectedSkills, "both")}
                disabled={busy || selectedSkillIds.size === 0}
              >
                {t("system.skills.installSelectedTarget", { target: skillTargetLabel("both", t) })}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void uninstallSelected()}
                disabled={busy || selectedInstalledTaskCount === 0}
              >
                {t("system.skills.removeSelected")}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void installSkills(skills, "claude")}
                disabled={busy || skills.length === 0}
              >
                {t("system.skills.installAllTarget", { target: "Claude" })}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void installSkills(skills, "codex")}
                disabled={busy || skills.length === 0}
              >
                {t("system.skills.installAllTarget", { target: "Codex" })}
              </Button>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void installSkills(skills, "both")}
                disabled={busy || skills.length === 0}
              >
                {t("system.skills.installAllTarget", { target: skillTargetLabel("both", t) })}
              </Button>
            </div>
          </div>

          {skills.length === 0 ? (
            <div className="empty-state compact">
              <strong>{t("system.skills.empty")}</strong>
            </div>
          ) : filteredSkills.length === 0 ? (
            <div className="empty-state compact">
              <strong>{t("system.skills.noMatching")}</strong>
            </div>
          ) : (
            <ul className="system-skill-list">
              {filteredSkills.map((skill) => {
                const claudeInstalled = installKey.has(`${skill.id}:claude`);
                const codexInstalled = installKey.has(`${skill.id}:codex`);
                return (
                  <li
                    className="system-skill-card skill-card"
                    key={skill.id}
                  >
                    <div className="skill-card-top">
                      <label className="skill-select" title={t("system.skills.selectSkill")}>
                        <input
                          type="checkbox"
                          checked={selectedSkillIds.has(skill.id)}
                          onChange={() => toggleSkillSelection(skill.id)}
                        />
                        <span>{t("system.skills.selectSkill")}</span>
                      </label>
                      <button
                        type="button"
                        className="skill-card-title"
                        onClick={() => void openSkillEditor(skill)}
                      >
                        <span>
                          {skill.name}
                          {skill.dirty ? (
                            <span className="dirty-pill">{t("system.skills.dirty")}</span>
                          ) : null}
                        </span>
                        <small>{skill.description || skill.title || skill.sourceId}</small>
                      </button>
                      <div className="skill-card-badges">
                        <span
                          className={claudeInstalled ? "skill-status-pill installed" : "skill-status-pill"}
                        >
                          <SquareTerminal size={12} />
                          Claude
                        </span>
                        <span
                          className={codexInstalled ? "skill-status-pill installed" : "skill-status-pill"}
                        >
                          <Code2 size={12} />
                          Codex
                        </span>
                      </div>
                    </div>
                    <div className="system-skill-meta">
                      <span>
                        {t("system.skills.source")}: <code>{skill.sourceId}</code>
                      </span>
                      <span>
                        {t("system.skills.runtime")}:{" "}
                        <code>{skill.runtime ?? t("system.skills.none")}</code>
                      </span>
                      <span title={skill.absPath}>
                        <code>{skill.relPath}</code>
                      </span>
                    </div>
                    <div className="skill-card-actions">
                      <Button variant="secondary" size="sm" onClick={() => void openSkillEditor(skill)}>
                        {t("system.skills.edit")}
                      </Button>
                      <Button
                        variant={claudeInstalled ? "ghost" : "primary"}
                        size="sm"
                        onClick={() =>
                          claudeInstalled
                            ? void uninstall(skill, "claude")
                            : void install(skill, "claude")
                        }
                        disabled={busy}
                      >
                        {claudeInstalled
                          ? t("system.skills.removeTarget", { target: "Claude" })
                          : t("system.skills.installTarget", { target: "Claude" })}
                      </Button>
                      <Button
                        variant={codexInstalled ? "ghost" : "primary"}
                        size="sm"
                        onClick={() =>
                          codexInstalled
                            ? void uninstall(skill, "codex")
                            : void install(skill, "codex")
                        }
                        disabled={busy}
                      >
                        {codexInstalled
                          ? t("system.skills.removeTarget", { target: "Codex" })
                          : t("system.skills.installTarget", { target: "Codex" })}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </div>
      <Dialog.Root
        open={confirmState !== null}
        onOpenChange={(open) => {
          if (!open) closeConfirmation(false);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="dialog-overlay" />
          <Dialog.Content className="dialog-content skills-confirm-dialog">
            <div className="dialog-header">
              <div>
                <Dialog.Title>{confirmState?.title ?? t("system.skills.confirmTitle")}</Dialog.Title>
                <Dialog.Description>
                  {confirmState?.message ?? t("system.skills.confirmFallback")}
                </Dialog.Description>
              </div>
            </div>
            <div className="dialog-actions">
              <Button variant="ghost" onClick={() => closeConfirmation(false)}>
                {t("dialog.cancel")}
              </Button>
              <Button
                variant={confirmState?.variant ?? "primary"}
                onClick={() => closeConfirmation(true)}
              >
                {confirmState?.confirmLabel ?? t("system.skills.confirmProceed")}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
      {error ? (
        <div className="toast" title={error}>
          <AlertTriangle size={13} />
          <span>{error}</span>
        </div>
      ) : null}
    </div>
  );
}

// ============================== Import ==============================

function ImportTab({ workPath }: { workPath: string }) {
  const { t } = useTranslation();
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [appliedCount, setAppliedCount] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const next = await planSysImport(workPath);
      setPlan(next);
      setSelected(new Set());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const allItems: ImportItem[] = useMemo(() => {
    if (!plan) return [];
    const out: ImportItem[] = [];
    out.push(...plan.rules);
    out.push(...plan.templates);
    if (plan.mcp) out.push(plan.mcp);
    if (plan.projects) out.push(plan.projects);
    if (plan.skills) out.push(plan.skills);
    return out;
  }, [plan]);

  const toggle = useCallback((origin: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(origin)) next.delete(origin);
      else next.add(origin);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelected(new Set(allItems.map((i) => i.originRel)));
  }, [allItems]);

  const selectChanged = useCallback(() => {
    setSelected(
      new Set(
        allItems.filter((i) => i.status !== "unchanged").map((i) => i.originRel),
      ),
    );
  }, [allItems]);

  const apply = useCallback(async () => {
    if (!plan) return;
    setApplying(true);
    setError(null);
    try {
      const receipt = await applySysImport(workPath, plan, Array.from(selected));
      setAppliedCount(receipt.applied.length);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  }, [workPath, plan, selected, refresh]);

  if (!plan) {
    return <p className="muted">{t("inbox.loading")}</p>;
  }
  if (!plan.sysPresent) {
    return <p className="muted">{t("system.import.empty")}</p>;
  }

  return (
    <div className="system-detail" style={{ width: "100%" }}>
      <p className="muted">{t("system.import.subtitle")}</p>
      <div className="system-detail-actions">
        <Button variant="ghost" size="sm" onClick={selectAll}>
          {t("system.import.selectAll")}
        </Button>
        <Button variant="ghost" size="sm" onClick={selectChanged}>
          {t("system.import.selectChanges")}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void refresh()} icon={<RefreshCcw size={13} />}>
          {t("app.refresh")}
        </Button>
        <span style={{ flex: 1 }} />
        <Button
          variant="primary"
          size="sm"
          onClick={() => void apply()}
          disabled={applying || selected.size === 0}
          icon={<Check size={14} />}
        >
          {applying ? t("system.import.applying") : t("system.import.apply")}
        </Button>
      </div>

      {appliedCount !== null ? (
        <div className="toast notice" title={t("system.import.applied", { count: appliedCount })}>
          <Check size={13} />
          <span>{t("system.import.applied", { count: appliedCount })}</span>
        </div>
      ) : null}
      {error ? (
        <div className="toast" title={error}>
          <AlertTriangle size={13} />
          <span>{error}</span>
        </div>
      ) : null}

      <ImportSection title={t("system.import.section.rules")} items={plan.rules} selected={selected} onToggle={toggle} t={t} />
      <ImportSection
        title={t("system.import.section.templates")}
        items={plan.templates}
        selected={selected}
        onToggle={toggle}
        t={t}
      />
      <ImportSection
        title={t("system.import.section.mcp")}
        items={plan.mcp ? [plan.mcp] : []}
        selected={selected}
        onToggle={toggle}
        t={t}
      />
      <ImportSection
        title={t("system.import.section.projects")}
        items={plan.projects ? [plan.projects] : []}
        selected={selected}
        onToggle={toggle}
        t={t}
      />
      <ImportSection
        title={t("system.import.section.skills")}
        items={plan.skills ? [plan.skills] : []}
        selected={selected}
        onToggle={toggle}
        t={t}
      />
    </div>
  );
}

interface ImportSectionProps {
  title: string;
  items: ImportItem[];
  selected: Set<string>;
  onToggle: (origin: string) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

function ImportSection({ title, items, selected, onToggle, t }: ImportSectionProps) {
  if (items.length === 0) return null;
  return (
    <section className="system-import-section">
      <h4>{title}</h4>
      <ul>
        {items.map((item) => (
          <li key={item.originRel} className="system-import-item">
            <label>
              <input
                type="checkbox"
                checked={selected.has(item.originRel)}
                onChange={() => onToggle(item.originRel)}
              />
              <span className="system-import-label">{item.label}</span>
              <span className="muted system-import-rel">{item.originRel}</span>
              <span className={`chip chip-${item.status}`}>
                {t(`system.import.status.${item.status}`)}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  );
}

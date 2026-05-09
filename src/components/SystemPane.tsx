// SystemPane — anchor's `.anchor/` operations surface.
//
// One pane for workspace settings and `.anchor/` operations. Workspace-local
// JSON stays under `<work>/.anchor/`; skill management also talks to the
// global `~/.anchor/skills` registry.

import {
  AlertTriangle,
  Check,
  Code2,
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
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  applySysImport,
  deleteAnchorRule,
  deleteAnchorTemplate,
  listAnchorRules,
  listAnchorTemplates,
  planSysImport,
  readAnchorMcp,
  readAnchorProjects,
  readAnchorRule,
  readAnchorTemplate,
  saveAnchorMcp,
  saveAnchorRule,
  saveAnchorTemplate,
} from "../lib/anchorDir";
import { useTranslation } from "../lib/i18n";
import type {
  AnchorSettings,
  DocumentBrowserMode,
  DocumentLabelMode,
  ExplorerPaneMode,
  FileQueueDefaultOperation,
  TerminalLauncherId,
  ThemeMode,
  WorkspaceFileFilter,
} from "../lib/settings";
import {
  formatBinaryFileIncludePatterns,
  normalizeAnchorSettings,
  parseBinaryFileIncludePatternsText,
} from "../lib/settings";
import { normalizeAccentInput } from "../lib/theme";
import type {
  ImportItem,
  ImportPlan,
  RuleEntry,
  TemplateEntry,
} from "../lib/types";
import {
  skillsAddSource,
  skillsAdoptExternalLinks,
  skillsCreateSkill,
  skillsEnvBootstrap,
  skillsEnvStatus,
  skillsInstallSkill,
  skillsListInstalls,
  skillsListSkills,
  skillsListSources,
  skillsReadSkill,
  skillsRescanSource,
  skillsSaveSkillFile,
  skillsSyncSource,
  skillsUninstallSkill,
  type SkillInstall,
  type SkillInstallTarget,
  type SkillRecord,
  type SkillSource,
  type SkillsEnvStatus,
} from "../lib/skills";
import { Button } from "./ui/Button";

type SystemTab =
  | "preferences"
  | "ai"
  | "terminal"
  | "inbox-channels"
  | "connectors"
  | "rules"
  | "templates"
  | "mcp"
  | "projects"
  | "skills"
  | "import";

interface SystemPaneProps {
  workPath: string | null;
  settings: AnchorSettings;
  onSettingsChange: (settings: AnchorSettings) => void;
}

export function SystemPane({ workPath, settings, onSettingsChange }: SystemPaneProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<SystemTab>("preferences");

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
            ["inbox-channels", "system.tab.inboxChannels"],
            ["connectors", "system.tab.connectors"],
            ["rules", "system.tab.rules"],
            ["templates", "system.tab.templates"],
            ["mcp", "system.tab.mcp"],
            ["projects", "system.tab.projects"],
            ["skills", "system.tab.skills"],
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
          <SettingsJsonTab
            title={t("system.ai.title")}
            value={settings.ai}
            onSave={(value) =>
              onSettingsChange(
                normalizeAnchorSettings({
                  ...settings,
                  ai: value,
                }),
              )
            }
          />
        ) : null}
        {tab === "terminal" ? (
          <SettingsJsonTab
            title={t("system.terminal.title")}
            value={settings.terminal}
            onSave={(value) =>
              onSettingsChange(
                normalizeAnchorSettings({
                  ...settings,
                  terminal: value,
                }),
              )
            }
          />
        ) : null}
        {tab === "inbox-channels" ? (
          <SettingsJsonTab
            title={t("system.inboxChannels.title")}
            value={settings.inboxChannels}
            onSave={(value) =>
              onSettingsChange(
                normalizeAnchorSettings({
                  ...settings,
                  inboxChannels: value,
                }),
              )
            }
          />
        ) : null}
        {tab === "connectors" ? (
          <SettingsJsonTab
            title={t("system.connectors.title")}
            value={settings.connectors}
            onSave={(value) =>
              onSettingsChange(
                normalizeAnchorSettings({
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
        {tab === "import" ? <ImportTab workPath={workPath} /> : null}
      </section>
    </main>
  );
}

// ============================ Preferences ============================

function PreferencesTab({
  settings,
  onSettingsChange,
}: {
  settings: AnchorSettings;
  onSettingsChange: (settings: AnchorSettings) => void;
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
      normalizeAnchorSettings({
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
      normalizeAnchorSettings({
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
      normalizeAnchorSettings({
        ...settings,
        ui: {
          ...settings.ui,
          workspaceFileFilter,
        },
      }),
    );
  };

  const commitBinaryFileIncludePatterns = (text: string) => {
    onSettingsChange(
      normalizeAnchorSettings({
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
      normalizeAnchorSettings({
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
      normalizeAnchorSettings({
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
      normalizeAnchorSettings({
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
      normalizeAnchorSettings({
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
      normalizeAnchorSettings({
        ...settings,
        terminal: {
          ...settings.terminal,
          autoLaunch,
        },
      }),
    );
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
      </div>
    </div>
  );
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
      const list = await listAnchorRules(workPath);
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
        const doc = await readAnchorRule(workPath, name);
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
      await saveAnchorRule(workPath, selected, content);
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
      await deleteAnchorRule(workPath, selected);
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
      await saveAnchorRule(workPath, name, stub);
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
      const list = await listAnchorTemplates(workPath);
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
        const c = await readAnchorTemplate(workPath, name);
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
      await saveAnchorTemplate(workPath, selected, content);
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
      await deleteAnchorTemplate(workPath, selected);
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
      await saveAnchorTemplate(workPath, name, stub);
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
      const value = await readAnchorMcp(workPath);
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
      await saveAnchorMcp(workPath, parsed);
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
        setValue(await readAnchorProjects(workPath));
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

function SkillsTab({ workPath }: { workPath: string }) {
  const { t } = useTranslation();
  const [sources, setSources] = useState<SkillSource[]>([]);
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [installs, setInstalls] = useState<SkillInstall[]>([]);
  const [envStatus, setEnvStatus] = useState<SkillsEnvStatus | null>(null);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [editorText, setEditorText] = useState("");
  const [editorBase, setEditorBase] = useState("");
  const [newSkillName, setNewSkillName] = useState("");
  const [newSourceId, setNewSourceId] = useState("");
  const [newSourcePath, setNewSourcePath] = useState("");
  const [newSourceKind, setNewSourceKind] = useState<"linked" | "cloned">("linked");
  const [skillQuery, setSkillQuery] = useState("");
  const [installFilter, setInstallFilter] = useState<"all" | "installed" | "uninstalled" | "dirty">("all");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const nextSources = await skillsListSources(workPath);
      const nextSkills = await skillsListSkills(workPath);
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

  const selectedSkill = useMemo(
    () => skills.find((skill) => skill.id === selectedSkillId) ?? null,
    [selectedSkillId, skills],
  );
  const installKey = useMemo(() => {
    const set = new Set<string>();
    installs.forEach((install) => set.add(`${install.skillId}:${install.target}`));
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

  const loadEditor = useCallback(async (skill: SkillRecord) => {
    setError(null);
    try {
      const doc = await skillsReadSkill(skill.id);
      setSelectedSkillId(doc.skill.id);
      setEditorText(doc.content);
      setEditorBase(doc.content);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const saveEditor = useCallback(async () => {
    if (!selectedSkill) return;
    setBusy(true);
    setError(null);
    try {
      await skillsSaveSkillFile(selectedSkill.id, "SKILL.md", editorText);
      setEditorBase(editorText);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [editorText, refresh, selectedSkill]);

  const install = useCallback(
    async (skill: SkillRecord, target: "claude" | "codex") => {
      setBusy(true);
      setError(null);
      try {
        await skillsInstallSkill(skill.id, target, skill.name);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const uninstall = useCallback(
    async (skill: SkillRecord, target: "claude" | "codex") => {
      const existing = installs.find(
        (item) => item.skillId === skill.id && item.target === target,
      );
      if (!existing) return;
      setBusy(true);
      setError(null);
      try {
        await skillsUninstallSkill(target, existing.installedAs);
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [installs, refresh],
  );

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
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void refresh()}
            icon={<RefreshCcw size={14} className={busy ? "spin" : ""} />}
          >
            {t("system.skills.refresh")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              void skillsAdoptExternalLinks()
                .then(refresh)
                .catch((err) => setError(err instanceof Error ? err.message : String(err)))
            }
          >
            {t("system.skills.adopt")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              void skillsEnvBootstrap(workPath)
                .then(() => refresh())
                .catch((err) => setError(err instanceof Error ? err.message : String(err)))
            }
            icon={<Wrench size={14} />}
          >
            {t("system.skills.bootstrap")}
          </Button>
        </div>
      </div>

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
              onClick={() => {
                setBusy(true);
                void skillsAddSource({
                  id: newSourceId.trim(),
                  kind: newSourceKind,
                  path: newSourceKind === "linked" ? newSourcePath.trim() : null,
                  repoUrl: newSourceKind === "cloned" ? newSourcePath.trim() : null,
                  skillsSubdir: "skills",
                })
                  .then(() => {
                    setNewSourceId("");
                    setNewSourcePath("");
                    return refresh();
                  })
                  .catch((err) => setError(err instanceof Error ? err.message : String(err)))
                  .finally(() => setBusy(false));
              }}
            >
              {t("system.skills.addSource")}
            </Button>
          </div>
          <ul className="system-skill-list compact">
            {sources.map((source) => (
              <li className="system-skill-card source-card" key={source.id}>
                <div className="source-card-top">
                  <div>
                    <div className="system-skill-name">{source.id}</div>
                    <div className="system-skill-meta">
                      <span className="skill-status-pill subtle">{source.kind}</span>
                      <span>
                        <code>{source.skillsSubdir}</code>
                      </span>
                    </div>
                  </div>
                  <div className="source-card-actions">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void skillsRescanSource(source.id)
                          .then(refresh)
                          .catch((err) =>
                            setError(err instanceof Error ? err.message : String(err)),
                          )
                      }
                    >
                      {t("system.skills.rescan")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void skillsSyncSource(source.id)
                          .then(refresh)
                          .catch((err) =>
                            setError(err instanceof Error ? err.message : String(err)),
                          )
                      }
                    >
                      {t("system.skills.sync")}
                    </Button>
                  </div>
                </div>
                <div className="skill-path" title={source.path ?? source.repoUrl ?? ""}>
                  {source.path ?? source.repoUrl ?? t("system.skills.managedSource")}
                </div>
              </li>
            ))}
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
                onClick={() =>
                  void skillsCreateSkill(newSkillName.trim(), null)
                    .then((skill) => {
                      setNewSkillName("");
                      void refresh().then(() => loadEditor(skill));
                    })
                    .catch((err) => setError(err instanceof Error ? err.message : String(err)))
                }
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
                    className={
                      selectedSkillId === skill.id
                        ? "system-skill-card skill-card selected"
                        : "system-skill-card skill-card"
                    }
                    key={skill.id}
                  >
                    <div className="skill-card-top">
                      <button
                        type="button"
                        className="skill-card-title"
                        onClick={() => void loadEditor(skill)}
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
                      <Button variant="secondary" size="sm" onClick={() => void loadEditor(skill)}>
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

        {selectedSkill ? (
          <section className="skills-manager-section editor">
            <div className="skills-editor-header">
              <div>
                <h3>{selectedSkill.name}</h3>
                <p className="muted" title={selectedSkill.absPath}>{selectedSkill.relPath}</p>
              </div>
              {selectedSkill.dirty ? (
                <span className="dirty-pill">{t("system.skills.linkedSourceDirty")}</span>
              ) : null}
              <span className={editorText !== editorBase ? "save-state dirty" : "save-state saved"}>
                {editorText !== editorBase ? t("system.rules.dirty") : t("system.rules.saved")}
              </span>
              <Button
                variant="primary"
                size="sm"
                onClick={() => void saveEditor()}
                disabled={editorText === editorBase || busy}
                icon={<Save size={14} />}
              >
                {t("system.mcp.save")}
              </Button>
            </div>
            <textarea
              className="source-editor skill-editor"
              value={editorText}
              onChange={(event) => setEditorText(event.target.value)}
              spellCheck={false}
            />
          </section>
        ) : null}
      </div>
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

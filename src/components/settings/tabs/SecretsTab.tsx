import {
  AlertTriangle,
  Eye,
  FilePenLine,
  RefreshCcw,
  Save,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import * as Dialog from "@radix-ui/react-dialog";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deleteSecretText,
  doctorSecrets,
  migrateSecrets,
  readSecretText,
  scanSecrets,
  writeSecretText,
} from "../../../lib/maruDir";
import { useTranslation } from "../../../lib/i18n";
import type {
  SecretInventoryItem,
  SecretsMigrationAction,
  SecretsMigrationReport,
  SecretsScanReport,
} from "../../../lib/types";
import { Button } from "../../ui/Button";
import { ModeHeader } from "../../ui/ModeChrome";

export function SecretsTab({ workPath }: { workPath: string }) {
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
    <div className="settings-tab wide settings-form secrets-settings-form">
      <ModeHeader
        title={t("system.tab.secrets")}
        subtitle={t("system.secrets.subtitle")}
        actions={
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
        }
      />
      <section className="settings-section-panel secrets-overview-panel">
        <div className="settings-section-heading">
          <div>
            <strong>{t("system.secrets.title")}</strong>
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

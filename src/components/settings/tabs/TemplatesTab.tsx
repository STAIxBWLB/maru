import { AlertTriangle, Plus, RefreshCcw, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  deleteMaruTemplate,
  listMaruTemplates,
  readMaruTemplate,
  saveMaruTemplate,
} from "../../../lib/maruDir";
import { useTranslation } from "../../../lib/i18n";
import type { TemplateEntry } from "../../../lib/types";
import { Button } from "../../ui/Button";
import { ModeHeader } from "../../ui/ModeChrome";

// ============================ Templates ============================

export function TemplatesTab({ workPath }: { workPath: string }) {
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
    <div className="settings-tab wide">
      <ModeHeader
        title={t("system.tab.templates")}
        actions={
          selected ? (
            <>
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
            </>
          ) : undefined
        }
      />
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
            <textarea
              className="source-editor"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              spellCheck={false}
            />
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
    </div>
  );
}

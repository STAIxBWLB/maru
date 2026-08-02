import { AlertTriangle, Plus, RefreshCcw, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { deleteMaruRule, listMaruRules, readMaruRule, saveMaruRule } from "../../../lib/maruDir";
import { useTranslation } from "../../../lib/i18n";
import type { RuleEntry } from "../../../lib/types";
import { Button } from "../../ui/Button";
import { ModeHeader } from "../../ui/ModeChrome";

// =============================== Rules ===============================

export function RulesTab({ workPath }: { workPath: string }) {
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
    <div className="settings-tab wide">
      <ModeHeader
        title={t("system.tab.rules")}
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
            </>
          ) : undefined
        }
      />
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
            <textarea
              className="source-editor"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              spellCheck={false}
            />
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
    </div>
  );
}

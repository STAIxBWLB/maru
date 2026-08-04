import { AlertTriangle, Plus, RefreshCcw, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { readMaruIgnore, saveMaruIgnore } from "../../../lib/maruDir";
import { useTranslation } from "../../../lib/i18n";
import { Button } from "../../ui/Button";
import { ModeHeader } from "../../ui/ModeChrome";

// =============================== Ignore ===============================
//
// `.maruignore` is the gitignore-shaped list that keeps files out of the
// document list, search, and graph. The backend already honoured the file;
// this tab is the only place a user can see and edit it.

export function IgnoreTab({ workPath }: { workPath: string }) {
  const { t } = useTranslation();
  const [patterns, setPatterns] = useState<string[]>([]);
  const [pristine, setPristine] = useState<string[]>([]);
  const [builtin, setBuiltin] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const doc = await readMaruIgnore(workPath);
      setPatterns(doc.patterns);
      setPristine(doc.patterns);
      setBuiltin(doc.builtin);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [workPath]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onAdd = useCallback(() => {
    const value = draft.trim();
    if (!value) return;
    if (patterns.includes(value) || builtin.includes(value)) {
      setError(t("system.ignore.duplicate"));
      return;
    }
    setError(null);
    setPatterns([...patterns, value]);
    setDraft("");
  }, [draft, patterns, builtin, t]);

  const onSave = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const doc = await saveMaruIgnore(workPath, patterns);
      setPatterns(doc.patterns);
      setPristine(doc.patterns);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [workPath, patterns]);

  const dirty =
    patterns.length !== pristine.length ||
    patterns.some((pattern, index) => pattern !== pristine[index]);

  return (
    <div className="settings-tab wide">
      <ModeHeader
        title={t("system.tab.ignore")}
        actions={
          <>
            <span className={dirty ? "save-state dirty" : "save-state saved"}>
              {dirty ? t("system.ignore.dirty") : t("system.ignore.saved")}
            </span>
            <Button
              variant="primary"
              size="sm"
              onClick={() => void onSave()}
              disabled={saving || !dirty}
              icon={<Save size={14} />}
            >
              {saving ? t("editor.saving") : t("system.ignore.save")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void refresh()}
              icon={<RefreshCcw size={13} />}
              aria-label={t("app.refresh")}
            />
          </>
        }
      />
      <div className="system-detail ignore-tab" style={{ width: "100%" }}>
        <p className="muted">{t("system.ignore.subtitle")}</p>

        <form
          className="ignore-add"
          onSubmit={(event) => {
            event.preventDefault();
            onAdd();
          }}
        >
          <input
            type="text"
            value={draft}
            spellCheck={false}
            placeholder={t("system.ignore.placeholder")}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button variant="secondary" size="sm" type="submit" icon={<Plus size={13} />}>
            {t("system.ignore.add")}
          </Button>
        </form>

        {patterns.length === 0 ? (
          <p className="muted">{t("system.ignore.empty")}</p>
        ) : (
          <ul className="ignore-list">
            {patterns.map((pattern, index) => (
              <li key={`${pattern}:${index}`}>
                <code>{pattern}</code>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setPatterns(patterns.filter((_, i) => i !== index))}
                  icon={<Trash2 size={13} />}
                  aria-label={t("system.ignore.remove")}
                />
              </li>
            ))}
          </ul>
        )}

        <p className="muted ignore-syntax">{t("system.ignore.syntax")}</p>

        {builtin.length > 0 ? (
          <>
            <h3 className="ignore-builtin-title">{t("system.ignore.builtinTitle")}</h3>
            <ul className="ignore-list builtin">
              {builtin.map((pattern) => (
                <li key={pattern}>
                  <code>{pattern}</code>
                </li>
              ))}
            </ul>
          </>
        ) : null}

        {error ? (
          <div className="toast" title={error}>
            <AlertTriangle size={13} />
            <span>{error}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

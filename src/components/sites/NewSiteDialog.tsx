import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "../../lib/i18n";
import { newSiteId, normalizeSiteUrl, type SiteEntry } from "../../lib/sites";
import { Button } from "../ui/Button";

interface NewSiteDialogProps {
  open: boolean;
  /** null → create mode; SiteEntry → edit mode. */
  initial: SiteEntry | null;
  nextOrder: number;
  onClose: () => void;
  onSave: (entry: SiteEntry) => void;
}

export function NewSiteDialog({ open, initial, nextOrder, onClose, onSave }: NewSiteDialogProps) {
  const { t } = useTranslation();
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const [category, setCategory] = useState("");
  const [devUrl, setDevUrl] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Re-seed fields whenever the dialog (re)opens for a different target.
  useEffect(() => {
    if (!open) return;
    setLabel(initial?.label ?? "");
    setUrl(initial?.url ?? "");
    setCategory(initial?.category ?? "");
    setDevUrl(initial?.devUrl ?? "");
    setLocalPath(initial?.localPath ?? "");
    setNotes(initial?.notes ?? "");
    setError(null);
  }, [open, initial]);

  if (!open) return null;

  const submit = () => {
    if (!label.trim()) {
      setError(t("sites.dialog.labelRequired"));
      return;
    }
    const normalizedUrl = normalizeSiteUrl(url);
    if (!normalizedUrl) {
      setError(t("sites.dialog.urlInvalid"));
      return;
    }
    const normalizedDevUrl = devUrl.trim() ? normalizeSiteUrl(devUrl) : null;
    if (devUrl.trim() && !normalizedDevUrl) {
      setError(t("sites.dialog.urlInvalid"));
      return;
    }
    onSave({
      id: initial?.id ?? newSiteId(),
      label: label.trim(),
      url: normalizedUrl,
      category: category.trim() || null,
      favicon: initial?.favicon ?? null,
      localPath: localPath.trim() || null,
      devUrl: normalizedDevUrl,
      order: initial?.order ?? nextOrder,
      createdAt: initial?.createdAt ?? new Date().toISOString(),
      lastUsedAt: initial?.lastUsedAt ?? null,
      notes: notes.trim() || null,
    });
    onClose();
  };

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="site-dialog task-new-dialog" role="dialog" aria-modal="true">
        <header>
          <div>
            <h2>{initial ? t("sites.dialog.edit.title") : t("sites.dialog.new.title")}</h2>
            <p>
              {initial
                ? t("sites.dialog.edit.description")
                : t("sites.dialog.new.description")}
            </p>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            title={t("app.close")}
            aria-label={t("app.close")}
          >
            <X size={16} />
          </button>
        </header>
        {error ? <div className="inbox-error">{error}</div> : null}
        <div className="settings-form">
          <label className="field">
            <span>{t("sites.dialog.field.label")}</span>
            <input value={label} onChange={(event) => setLabel(event.target.value)} autoFocus />
          </label>
          <label className="field">
            <span>{t("sites.dialog.field.url")}</span>
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://example.com"
              inputMode="url"
            />
          </label>
          <div className="settings-grid two">
            <label className="field">
              <span>{t("sites.dialog.field.category")}</span>
              <input value={category} onChange={(event) => setCategory(event.target.value)} />
            </label>
            <label className="field">
              <span>{t("sites.dialog.field.devUrl")}</span>
              <input
                value={devUrl}
                onChange={(event) => setDevUrl(event.target.value)}
                placeholder="http://localhost:4321"
                inputMode="url"
              />
            </label>
          </div>
          <label className="field">
            <span>{t("sites.dialog.field.localPath")}</span>
            <input value={localPath} onChange={(event) => setLocalPath(event.target.value)} />
          </label>
          <label className="field">
            <span>{t("sites.dialog.field.notes")}</span>
            <input value={notes} onChange={(event) => setNotes(event.target.value)} />
          </label>
        </div>
        <footer>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t("dialog.cancel")}
          </Button>
          <Button size="sm" variant="primary" onClick={submit}>
            {initial ? t("sites.dialog.save") : t("sites.dialog.create")}
          </Button>
        </footer>
      </section>
    </div>
  );
}

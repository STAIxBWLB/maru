import { useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "../../lib/i18n";
import { Button } from "../ui/Button";

interface NaturalScheduleDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (rawText: string) => Promise<void>;
}

export function NaturalScheduleDialog({
  open,
  onClose,
  onSubmit,
}: NaturalScheduleDialogProps) {
  const { t } = useTranslation();
  const [rawText, setRawText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const submit = async () => {
    const trimmed = rawText.trim();
    if (!trimmed) {
      setError(t("tasks.natural.textRequired"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
      setRawText("");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="task-new-dialog task-natural-dialog" role="dialog" aria-modal="true">
        <header>
          <div>
            <h2>{t("tasks.natural.title")}</h2>
            <p>{t("tasks.natural.description")}</p>
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
        <label className="field">
          <span>{t("tasks.natural.field.raw")}</span>
          <textarea
            value={rawText}
            onChange={(event) => setRawText(event.target.value)}
            placeholder={t("tasks.natural.placeholder")}
            autoFocus
          />
        </label>
        <footer>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t("dialog.cancel")}
          </Button>
          <Button size="sm" variant="primary" disabled={busy} onClick={() => void submit()}>
            {t("tasks.natural.submit")}
          </Button>
        </footer>
      </section>
    </div>
  );
}

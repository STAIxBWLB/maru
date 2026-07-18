import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { useTranslation } from "../../lib/i18n";
import { parseKoreanDate } from "../../lib/koreanDate";
import { Button } from "../ui/Button";

interface NaturalScheduleDialogProps {
  open: boolean;
  onClose: () => void;
  onSubmit: (rawText: string, parsedStart: string | null) => Promise<void>;
}

export function NaturalScheduleDialog({
  open,
  onClose,
  onSubmit,
}: NaturalScheduleDialogProps) {
  const { t, locale } = useTranslation();
  const [rawText, setRawText] = useState("");
  const [parsedStart, setParsedStart] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Debounced live preview from the Rust Korean date parser (SSOT for
  // phrases like "내일", "다음 주 금요일"). The parsed datetime travels with
  // the submit so the skill prompt can treat it as authoritative.
  useEffect(() => {
    const trimmed = rawText.trim();
    if (!trimmed) {
      setParsedStart(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void parseKoreanDate(trimmed)
        .then((parsed) => {
          if (!cancelled) setParsedStart(parsed);
        })
        .catch(() => {
          if (!cancelled) setParsedStart(null);
        });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [rawText]);

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
      await onSubmit(trimmed, parsedStart);
      setRawText("");
      setParsedStart(null);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const preview = parsedStart
    ? new Date(parsedStart).toLocaleString(locale === "ko" ? "ko-KR" : "en-US", {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : null;

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
        {preview ? (
          <p className="task-natural-dialog__preview">
            {t("tasks.natural.parsedPreview", { datetime: preview })}
          </p>
        ) : null}
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

import { Play, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type React from "react";
import { useTranslation } from "../../lib/i18n";
import { Button } from "../ui/Button";
import {
  DialogSurface,
  DialogSurfaceClose,
  DialogSurfaceTitle,
} from "../ui/DialogSurface";

interface InboxProcessComposerProps {
  open: boolean;
  /** Number of items staged for this run (for the "N items" label). */
  targetCount: number;
  /** Channels covered by the staged items, for an `inbox-process <channels>` preview. */
  channels: string[];
  busy?: boolean;
  /** Run with the typed context. An empty string is allowed (= run with no context). */
  onRun: (context: string) => void;
  onCancel: () => void;
}

/**
 * A small modal that lets the user type free-text guidance before dispatching an
 * inbox-process run — the GUI equivalent of `inbox-process <channel> <context>`
 * in the terminal. The context is optional: Cmd/Ctrl+Enter (or Run on an empty
 * box) dispatches exactly as the previous one-tap flow did.
 */
export function InboxProcessComposer({
  open,
  targetCount,
  channels,
  busy = false,
  onRun,
  onCancel,
}: InboxProcessComposerProps) {
  const { t } = useTranslation();
  const [context, setContext] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setContext("");
    const frame = window.requestAnimationFrame(() => textareaRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  const run = () => {
    if (busy) return;
    onRun(context);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      run();
    } else if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
    // Plain Enter inserts a newline (default textarea behavior) so multi-line
    // context is possible.
  };

  const channelPreview = channels.filter(Boolean).join(" ");

  return (
    <DialogSurface
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel();
      }}
      className="inbox-process-dialog"
      ariaLabel={t("inbox.process.composer.title")}
    >
        <header>
          <div>
            <DialogSurfaceTitle>{t("inbox.process.composer.title")}</DialogSurfaceTitle>
            <p>
              {t("inbox.process.composer.itemCount", { count: targetCount })}
              {channelPreview ? ` · inbox-process ${channelPreview}` : ""}
            </p>
          </div>
          <DialogSurfaceClose>
            <button
              type="button"
              className="icon-button"
              title={t("inbox.process.composer.cancel")}
              aria-label={t("inbox.process.composer.cancel")}
            >
              <X size={16} />
            </button>
          </DialogSurfaceClose>
        </header>
        <label className="field">
          <span>{t("inbox.process.composer.label")}</span>
          <textarea
            ref={textareaRef}
            value={context}
            onChange={(event) => setContext(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("inbox.process.composer.placeholder")}
            aria-label={t("inbox.process.composer.label")}
          />
        </label>
        <footer>
          <span className="inbox-process-dialog-hint">{t("inbox.process.composer.hint")}</span>
          <div className="inbox-process-dialog-actions">
            <Button size="sm" variant="ghost" onClick={onCancel}>
              {t("inbox.process.composer.cancel")}
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={busy}
              onClick={run}
              icon={<Play size={14} />}
            >
              {t("inbox.process.composer.run")}
            </Button>
          </div>
        </footer>
    </DialogSurface>
  );
}

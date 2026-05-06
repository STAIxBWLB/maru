import * as Dialog from "@radix-ui/react-dialog";
import { Save, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "./ui/Button";
import { Field, TextInput } from "./ui/Field";
import { useTranslation } from "../lib/i18n";
import type { InboxSettings } from "../lib/types";

interface InboxSettingsDialogProps {
  open: boolean;
  settings: InboxSettings;
  onOpenChange: (open: boolean) => void;
  onSave: (next: InboxSettings) => Promise<void>;
}

export function InboxSettingsDialog({
  open,
  settings,
  onOpenChange,
  onSave,
}: InboxSettingsDialogProps) {
  const { t } = useTranslation();
  const [inboxRoot, setInboxRoot] = useState(settings.inboxRoot);
  const [sources, setSources] = useState(settings.sources.join(", "));
  const [gwsPath, setGwsPath] = useState(settings.gwsPath ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setInboxRoot(settings.inboxRoot);
    setSources(settings.sources.join(", "));
    setGwsPath(settings.gwsPath ?? "");
    setError(null);
  }, [open, settings]);

  async function submit() {
    setError(null);
    const trimmedRoot = inboxRoot.trim() || "inbox/downloads";
    const parsedSources = sources
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const trimmedGws = gwsPath.trim();
    setSaving(true);
    try {
      await onSave({
        inboxRoot: trimmedRoot,
        sources: parsedSources,
        gwsPath: trimmedGws ? trimmedGws : null,
      });
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <div className="dialog-header">
            <div>
              <Dialog.Title>{t("inbox.settings.title")}</Dialog.Title>
              <Dialog.Description>{t("inbox.settings.description")}</Dialog.Description>
            </div>
            <Dialog.Close
              className="icon-button"
              title={t("app.errorClose")}
              aria-label={t("app.errorClose")}
            >
              <X size={16} />
            </Dialog.Close>
          </div>

          <Field label={t("inbox.settings.root.label")} error={error ?? undefined}>
            <TextInput
              value={inboxRoot}
              onChange={(event) => setInboxRoot(event.target.value)}
              placeholder={t("inbox.settings.root.placeholder")}
            />
          </Field>

          <Field
            label={t("inbox.settings.sources.label")}
            helper={t("inbox.settings.sources.hint")}
          >
            <TextInput
              value={sources}
              onChange={(event) => setSources(event.target.value)}
              placeholder={t("inbox.settings.sources.placeholder")}
            />
          </Field>

          <Field
            label={t("inbox.settings.gws.label")}
            helper={t("inbox.settings.gws.hint")}
          >
            <TextInput
              value={gwsPath}
              onChange={(event) => setGwsPath(event.target.value)}
              placeholder={t("inbox.settings.gws.placeholder")}
            />
          </Field>

          <div className="dialog-actions">
            <Dialog.Close asChild>
              <Button variant="ghost">{t("inbox.settings.cancel")}</Button>
            </Dialog.Close>
            <Button
              variant="primary"
              onClick={submit}
              disabled={saving}
              icon={<Save size={15} />}
            >
              {t("inbox.settings.save")}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

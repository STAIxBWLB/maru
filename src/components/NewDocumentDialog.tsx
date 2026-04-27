import * as Dialog from "@radix-ui/react-dialog";
import { FilePlus2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "./ui/Button";
import { Field, TextArea, TextInput } from "./ui/Field";
import { useTranslation } from "../lib/i18n";

interface NewDocumentDialogProps {
  open: boolean;
  initialTitle?: string;
  initialRelPath?: string | null;
  initialDocType?: string;
  onOpenChange: (open: boolean) => void;
  onCreate: (
    title: string,
    docType: string,
    body: string,
    targetRelPath: string | null,
  ) => Promise<void>;
}

export function NewDocumentDialog({
  open,
  initialTitle = "",
  initialRelPath = null,
  initialDocType = "reference",
  onOpenChange,
  onCreate,
}: NewDocumentDialogProps) {
  const { t } = useTranslation();
  const [title, setTitle] = useState("");
  const [docType, setDocType] = useState("reference");
  const [relPath, setRelPath] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(initialTitle);
    setDocType(initialDocType);
    setRelPath(initialRelPath ?? "");
    setBody("");
    setError(null);
    setSaving(false);
  }, [open, initialTitle, initialRelPath, initialDocType]);

  async function submit() {
    setError(null);
    if (!title.trim()) {
      setError(t("newDoc.error.title"));
      return;
    }
    if (!docType.trim()) {
      setError(t("newDoc.error.type"));
      return;
    }
    setSaving(true);
    try {
      await onCreate(title.trim(), docType.trim(), body.trim(), relPath.trim() || null);
      setTitle("");
      setDocType("reference");
      setRelPath("");
      setBody("");
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
              <Dialog.Title>{t("newDoc.dialog.title")}</Dialog.Title>
              <Dialog.Description>{t("newDoc.dialog.description")}</Dialog.Description>
            </div>
            <Dialog.Close className="icon-button" title={t("app.errorClose")}>
              <X size={16} />
            </Dialog.Close>
          </div>

          <Field label={t("newDoc.field.title")} error={error ?? undefined}>
            <TextInput
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={t("newDoc.field.title.placeholder")}
            />
          </Field>

          <Field label={t("newDoc.field.type")}>
            <TextInput
              value={docType}
              onChange={(event) => setDocType(event.target.value)}
              placeholder={t("newDoc.field.type.placeholder")}
            />
          </Field>

          <Field label={t("newDoc.field.path")} helper={t("newDoc.field.path.helper")}>
            <TextInput
              value={relPath}
              onChange={(event) => setRelPath(event.target.value)}
              placeholder={t("newDoc.field.path.placeholder")}
            />
          </Field>

          <Field label={t("newDoc.field.body")} helper={t("newDoc.field.body.helper")}>
            <TextArea rows={7} value={body} onChange={(event) => setBody(event.target.value)} />
          </Field>

          <div className="dialog-actions">
            <Dialog.Close asChild>
              <Button variant="ghost">{t("newDoc.cancel")}</Button>
            </Dialog.Close>
            <Button
              variant="primary"
              onClick={submit}
              disabled={saving}
              icon={<FilePlus2 size={15} />}
            >
              {saving ? t("newDoc.creating") : t("newDoc.create")}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

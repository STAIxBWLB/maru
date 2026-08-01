import { useEffect, useState } from "react";
import { createDraft } from "../../lib/api";
import { useTranslation } from "../../lib/i18n";
import type { DraftEntry, DraftImportance, DraftKind } from "../../lib/types";
import { Button } from "../ui/Button";
import { DialogSurface, DialogSurfaceTitle } from "../ui/DialogSurface";
import { Field, TextArea, TextInput } from "../ui/Field";

const KINDS: DraftKind[] = ["task", "idea", "implementation"];
const IMPORTANCES: DraftImportance[] = ["high", "medium", "low"];

interface NewDraftDialogProps {
  open: boolean;
  workPath: string | null;
  onClose: () => void;
  onError: (message: string | null) => void;
  onCreated: (entry: DraftEntry) => void;
}

export function NewDraftDialog({ open, workPath, onClose, onError, onCreated }: NewDraftDialogProps) {
  const { t } = useTranslation();
  const [kind, setKind] = useState<DraftKind>("task");
  const [title, setTitle] = useState("");
  const [importance, setImportance] = useState<DraftImportance | "">("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setKind("task");
    setTitle("");
    setImportance("");
    setBody("");
  }, [open]);

  if (!open) return null;

  const submit = async () => {
    if (!workPath || busy || !title.trim()) return;
    setBusy(true);
    onError(null);
    try {
      const created = await createDraft({
        workPath,
        kind,
        title: title.trim(),
        source: "manual",
        originRefs: [],
        importance: importance === "" ? null : importance,
        confidence: null,
        body,
      });
      onCreated(created);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogSurface
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      ariaLabel={t("drafts.create.title")}
      className="drafts-create-dialog"
    >
      <DialogSurfaceTitle>{t("drafts.create.title")}</DialogSurfaceTitle>
      <div className="drafts-create-body">
        <Field label={t("drafts.create.kind")}>
          <div className="drafts-create-kinds" role="radiogroup">
            {KINDS.map((candidate) => (
              <label key={candidate}>
                <input
                  type="radio"
                  name="drafts-create-kind"
                  checked={kind === candidate}
                  onChange={() => setKind(candidate)}
                />
                <span>{t(`drafts.kind.${candidate}`)}</span>
              </label>
            ))}
          </div>
        </Field>
        <Field label={t("drafts.create.draftTitle")}>
          <TextInput
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={t("drafts.create.titlePlaceholder")}
          />
        </Field>
        <Field label={t("drafts.create.importance")}>
          <div className="drafts-create-importance" role="radiogroup">
            <label>
              <input
                type="radio"
                name="drafts-create-importance"
                checked={importance === ""}
                onChange={() => setImportance("")}
              />
              <span>{t("drafts.create.importanceUnset")}</span>
            </label>
            {IMPORTANCES.map((candidate) => (
              <label key={candidate}>
                <input
                  type="radio"
                  name="drafts-create-importance"
                  checked={importance === candidate}
                  onChange={() => setImportance(candidate)}
                />
                <span>{t(`drafts.importance.${candidate}`)}</span>
              </label>
            ))}
          </div>
        </Field>
        <Field label={t("drafts.create.body")}>
          <TextArea
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={10}
            placeholder={t("drafts.create.bodyPlaceholder")}
          />
        </Field>
      </div>
      <div className="dialog-actions">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          {t("dialog.cancel")}
        </Button>
        <Button type="button" onClick={() => void submit()} disabled={busy || !title.trim()}>
          {t("drafts.create.submit")}
        </Button>
      </div>
    </DialogSurface>
  );
}

import { useEffect, useState } from "react";
import type { ApprovalInput } from "../../approval/ApprovalDialog";
import { promoteDraft } from "../../lib/api";
import { defaultPromoteDocumentPath } from "../../lib/drafts";
import { setError } from "../../lib/errorStore";
import { useTranslation } from "../../lib/i18n";
import type { DraftEntry, DraftPromoteTarget } from "../../lib/types";
import { Button } from "../ui/Button";
import { DialogSurface, DialogSurfaceTitle } from "../ui/DialogSurface";
import { Field, TextInput } from "../ui/Field";

interface PromoteDraftDialogProps {
  draft: DraftEntry | null;
  workPath: string | null;
  onConfirmApproval: (input: ApprovalInput) => Promise<string | null>;
  onClose: () => void;
  onPromoted: (entry: DraftEntry) => void;
}

export function PromoteDraftDialog({
  draft,
  workPath,
  onConfirmApproval,
  onClose,
  onPromoted,
}: PromoteDraftDialogProps) {
  const { t } = useTranslation();
  const [target, setTarget] = useState<DraftPromoteTarget>("document");
  const [targetPath, setTargetPath] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!draft) return;
    setTarget(draft.kind === "task" ? "task" : "document");
    setTargetPath(defaultPromoteDocumentPath(draft.title));
  }, [draft]);

  if (!draft) return null;

  const submit = async () => {
    if (!workPath || busy) return;
    const path = target === "document" ? targetPath.trim() : "";
    if (target === "document" && !path) return;
    setBusy(true);
    setError(null);
    try {
      const approvalId = await onConfirmApproval({
        kind: "drafts.promote",
        summary: t("approval.drafts.promote.summary", { title: draft.title }),
        target: target === "document" ? path : "task",
      });
      if (!approvalId) return;
      const promoted = await promoteDraft({
        workPath,
        id: draft.id,
        target,
        targetPath: path || null,
        approvalId,
      });
      onPromoted(promoted);
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DialogSurface
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      ariaLabel={t("drafts.promote.title")}
      className="drafts-promote-dialog"
    >
      <DialogSurfaceTitle>{t("drafts.promote.title")}</DialogSurfaceTitle>
      <div className="drafts-promote-body">
        <Field label={t("drafts.promote.target")}>
          <div className="drafts-promote-targets" role="radiogroup">
            <label>
              <input
                type="radio"
                name="drafts-promote-target"
                checked={target === "document"}
                onChange={() => setTarget("document")}
              />
              <span>{t("drafts.promote.target.document")}</span>
            </label>
            <label>
              <input
                type="radio"
                name="drafts-promote-target"
                checked={target === "task"}
                onChange={() => setTarget("task")}
              />
              <span>{t("drafts.promote.target.task")}</span>
            </label>
          </div>
        </Field>
        {target === "document" ? (
          <Field label={t("drafts.promote.path")}>
            <TextInput
              value={targetPath}
              onChange={(event) => setTargetPath(event.target.value)}
            />
          </Field>
        ) : null}
      </div>
      <div className="dialog-actions">
        <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
          {t("dialog.cancel")}
        </Button>
        <Button
          type="button"
          onClick={() => void submit()}
          disabled={busy || (target === "document" && !targetPath.trim())}
        >
          {t("drafts.promote.submit")}
        </Button>
      </div>
    </DialogSurface>
  );
}

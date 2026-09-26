import { AlertTriangle, X } from "lucide-react";
import { openInFileManager } from "../lib/api";
import { dismissOperationNotice, setError, type OperationNotice } from "../lib/errorStore";
import type { Translate } from "../lib/teardownSave";

/**
 * The operation-notice toast, extracted from App.tsx (step 9). Shares the
 * global `OperationNotice` queue in `errorStore.ts`, so it survives the
 * originating pane unmounting. When the notice carries a recovery copy
 * (D-07, D-08), it also offers an "Open recovery copy" action.
 */
export function OperationNoticeToast({
  notice,
  t,
}: {
  notice: OperationNotice;
  t: Translate;
}) {
  const recovery = notice.recovery;

  return (
    <div
      className={notice.kind === "error" ? "toast" : "toast notice"}
      title={notice.message}
      role="status"
      data-skill-operation={notice.operationId}
    >
      <AlertTriangle size={15} />
      <span>{notice.message}</span>
      {recovery ? (
        <button
          type="button"
          className="button button-ghost button-sm"
          onClick={() => {
            void openInFileManager(recovery.workPath, recovery.path)
              .catch((error: unknown) => {
                setError(error instanceof Error ? error.message : String(error));
              })
              .finally(() => {
                dismissOperationNotice(notice.operationId);
              });
          }}
        >
          {t("save.teardown.openCopy")}
        </button>
      ) : null}
      <button
        type="button"
        className="icon-button"
        onClick={() => dismissOperationNotice(notice.operationId)}
        aria-label={t("app.errorClose")}
        title={t("app.errorClose")}
      >
        <X size={14} />
      </button>
    </div>
  );
}

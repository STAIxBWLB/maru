import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { trashDocument, documentDeletePlan } from "../lib/api";
import { formatBytes } from "../lib/binaryViewer";
import { useTranslation } from "../lib/i18n";
import { IpcError } from "../lib/ipcError";
import type {
  DocumentDeleteItem,
  DocumentDeleteOutcome,
  DocumentDeletePlan,
} from "../lib/types";
import { Button } from "./ui/Button";
import {
  DialogSurface,
  DialogSurfaceDescription,
  DialogSurfaceTitle,
} from "./ui/DialogSurface";

export interface DocumentDeleteRequest {
  workspacePath: string;
  documentPath: string;
}

/**
 * Document delete with a reviewed file list (#441). `requestDelete` opens the
 * dialog; `onDeleted` runs after the source reached the Trash.
 */
export function useDocumentDelete(
  onDeleted: (request: DocumentDeleteRequest, outcome: DocumentDeleteOutcome) => void,
) {
  const [request, setRequest] = useState<DocumentDeleteRequest | null>(null);
  const dialog = (
    <DocumentDeleteDialog
      request={request}
      onClose={() => setRequest(null)}
      onDeleted={onDeleted}
    />
  );
  return { requestDelete: setRequest, dialog };
}

type Group = "derived" | "metadata";

export function DocumentDeleteDialog({
  request,
  onClose,
  onDeleted,
}: {
  request: DocumentDeleteRequest | null;
  onClose: () => void;
  onDeleted: (request: DocumentDeleteRequest, outcome: DocumentDeleteOutcome) => void;
}) {
  const { t } = useTranslation();
  const [plan, setPlan] = useState<DocumentDeletePlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [groups, setGroups] = useState<Record<Group, boolean>>({ derived: false, metadata: false });
  const [unchecked, setUnchecked] = useState<Set<string>>(() => new Set());
  const [failures, setFailures] = useState<DocumentDeleteOutcome["items"]>([]);

  // Only the latest request may fill the dialog; a slow earlier plan is dropped.
  const latest = useRef<DocumentDeleteRequest | null>(null);
  const loadPlan = useCallback(async (target: DocumentDeleteRequest) => {
    latest.current = target;
    setPlan(null);
    setError(null);
    try {
      const next = await documentDeletePlan(target.workspacePath, target.documentPath);
      if (latest.current === target) setPlan(next);
    } catch (err) {
      if (latest.current === target) setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    latest.current = request;
    setGroups({ derived: false, metadata: false });
    setUnchecked(new Set());
    setNotice(null);
    setFailures([]);
    if (request) void loadPlan(request);
  }, [loadPlan, request]);

  const selected = useMemo(() => {
    if (!plan) return [];
    return (["derived", "metadata"] as const)
      .filter((group) => groups[group])
      .flatMap((group) => plan[group])
      .filter((item) => !unchecked.has(item.relPath));
  }, [groups, plan, unchecked]);

  const totalBytes =
    (plan?.source.sizeBytes ?? 0) + selected.reduce((sum, item) => sum + item.sizeBytes, 0);

  const confirm = async () => {
    if (!request || !plan || busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await trashDocument(
        request.workspacePath,
        request.documentPath,
        plan.fingerprint,
        selected.map((item) => item.relPath),
      );
      onDeleted(request, outcome);
      const failed = outcome.items.filter((item) => item.status !== "trashed");
      if (failed.length > 0) setFailures(failed);
      else onClose();
    } catch (err) {
      if (err instanceof IpcError && err.code === "document_delete_stale") {
        // Keep what the user unchecked; the new plan is reviewed again.
        setNotice(t("documentDelete.stale"));
        await loadPlan(request);
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const toggleItem = (relPath: string, checked: boolean) => {
    setUnchecked((current) => {
      const next = new Set(current);
      if (checked) next.delete(relPath);
      else next.add(relPath);
      return next;
    });
  };

  const done = failures.length > 0;
  return (
    <DialogSurface
      open={request !== null}
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      className="dialog-content document-delete-dialog"
      hasDescription
    >
      <div className="dialog-header">
        <div>
          <DialogSurfaceTitle>{t("documentDelete.title")}</DialogSurfaceTitle>
          <DialogSurfaceDescription>{t("documentDelete.description")}</DialogSurfaceDescription>
        </div>
      </div>
      {notice ? <p className="document-delete-notice" role="status">{notice}</p> : null}
      {error ? <p className="document-delete-error" role="alert">{error}</p> : null}
      {!plan && !error ? <p className="document-delete-muted">{t("documentDelete.loading")}</p> : null}
      {plan && !done ? (
        <div className="document-delete-body">
          <ul className="document-delete-list" aria-label={t("documentDelete.sourceLabel")}>
            <DeleteRow item={plan.source} checked disabled />
          </ul>
          {(["derived", "metadata"] as const).map((group) => {
            const items = plan[group];
            const label = t(`documentDelete.${group}`, { count: items.length });
            return (
              <section key={group} className="document-delete-group">
                <label className="document-delete-group-head">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={groups[group]}
                    disabled={items.length === 0}
                    onChange={(event) => {
                      const checked = event.target.checked;
                      setGroups((current) => ({ ...current, [group]: checked }));
                    }}
                  />
                  <span>{label}</span>
                </label>
                {items.length === 0 ? (
                  <p className="document-delete-muted">{t("documentDelete.noneFound")}</p>
                ) : groups[group] ? (
                  <ul className="document-delete-list" aria-label={label}>
                    {items.map((item) => (
                      <DeleteRow
                        key={item.relPath}
                        item={item}
                        checked={!unchecked.has(item.relPath)}
                        onChange={(checked) => toggleItem(item.relPath, checked)}
                      />
                    ))}
                  </ul>
                ) : null}
              </section>
            );
          })}
          {plan.kept.length > 0 ? (
            <section className="document-delete-group">
              <div className="document-delete-group-head">
                <span>{t("documentDelete.kept", { count: plan.kept.length })}</span>
              </div>
              <ul className="document-delete-list" aria-label={t("documentDelete.kept", { count: plan.kept.length })}>
                {plan.kept.map((item) => (
                  <DeleteRow key={item.relPath} item={item} />
                ))}
              </ul>
            </section>
          ) : null}
          <p className="document-delete-total">
            {t("documentDelete.total", {
              count: selected.length + 1,
              size: formatBytes(totalBytes),
            })}
          </p>
        </div>
      ) : null}
      {done ? <p className="document-delete-total">{t("documentDelete.failures")}</p> : null}
      {done ? (
        <ul className="document-delete-list" aria-label={t("documentDelete.failures")}>
          {failures.map((item) => (
            <li key={item.relPath} className="document-delete-row">
              <span className="document-delete-path">{item.relPath}</span>
              <span className="document-delete-meta">
                {t(`documentDelete.status.${item.status}`)}
                {item.error ? ` - ${item.error}` : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="dialog-actions">
        <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
          {done ? t("dialog.ok") : t("dialog.cancel")}
        </Button>
        {done ? null : (
          <Button
            type="button"
            variant="danger"
            disabled={!plan || busy}
            onClick={() => void confirm()}
          >
            {t("documentDelete.confirm", { count: selected.length + 1 })}
          </Button>
        )}
      </div>
    </DialogSurface>
  );
}

function DeleteRow({
  item,
  checked,
  disabled = false,
  onChange,
}: {
  item: DocumentDeleteItem;
  checked?: boolean;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
}) {
  const kept = checked === undefined;
  return (
    <li className="document-delete-row">
      <label>
        {kept ? null : (
          <input
            type="checkbox"
            checked={checked}
            disabled={disabled}
            onChange={(event) => onChange?.(event.target.checked)}
          />
        )}
        <span className="document-delete-path">
          {item.relPath}
          {item.isDir ? "/" : ""}
        </span>
      </label>
      <span className="document-delete-meta">
        {formatBytes(item.sizeBytes)} · {item.evidence}
      </span>
    </li>
  );
}

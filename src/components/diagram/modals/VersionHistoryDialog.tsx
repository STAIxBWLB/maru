import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type { DiagramSnapshotMeta } from "../../../lib/diagram";
import { deserializeDoc } from "../../../lib/diagram/persistence";
import {
  listSnapshotsForDoc,
  restoreSnapshotForDoc,
  saveSnapshotForDoc,
} from "../../../lib/diagram/versionHistory";
import type { DiagramDoc } from "../../../lib/diagram/types";
import { useTranslation } from "../../../lib/i18n";

export interface VersionHistoryDialogProps {
  open: boolean;
  doc: DiagramDoc;
  workspace: string | null;
  onRestore: (next: DiagramDoc) => void;
  onError: (message: string) => void;
  onClose: () => void;
}

function parseSnapshotTs(ts: string): Date {
  // formatSnapshotTs writes "20260526T204900Z" — compact RFC3339-like.
  if (/^\d{8}T\d{6}Z$/.test(ts)) {
    const iso = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}T${ts.slice(9, 11)}:${ts.slice(11, 13)}:${ts.slice(13, 15)}Z`;
    return new Date(iso);
  }
  return new Date(ts);
}

export function VersionHistoryDialog({
  open,
  doc,
  workspace,
  onRestore,
  onError,
  onClose,
}: VersionHistoryDialogProps) {
  const { t } = useTranslation();
  const [snapshots, setSnapshots] = useState<DiagramSnapshotMeta[]>([]);
  const [busy, setBusy] = useState(false);
  const [pendingRestoreTs, setPendingRestoreTs] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!workspace) {
      setSnapshots([]);
      return;
    }
    try {
      const list = await listSnapshotsForDoc(workspace, doc);
      setSnapshots(list);
    } catch (err) {
      onError((err as Error).message ?? "unknown");
    }
  }, [doc, onError, workspace]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const handleSaveNow = useCallback(async () => {
    if (!workspace) return;
    setBusy(true);
    try {
      await saveSnapshotForDoc(workspace, doc);
      await refresh();
    } catch (err) {
      onError((err as Error).message ?? "unknown");
    } finally {
      setBusy(false);
    }
  }, [doc, onError, refresh, workspace]);

  const handleRestore = useCallback(
    async (ts: string) => {
      if (!workspace) return;
      setPendingRestoreTs(ts);
    },
    [workspace],
  );

  const confirmRestore = useCallback(
    async () => {
      if (!workspace || !pendingRestoreTs) return;
      setBusy(true);
      try {
        // Capture current state before restoring.
        await saveSnapshotForDoc(workspace, doc);
        const body = await restoreSnapshotForDoc(workspace, doc, pendingRestoreTs);
        const next = deserializeDoc(body);
        onRestore(next);
        await refresh();
      } catch (err) {
        onError((err as Error).message ?? "unknown");
      } finally {
        setBusy(false);
        setPendingRestoreTs(null);
      }
    },
    [doc, onError, onRestore, pendingRestoreTs, refresh, workspace],
  );

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content anchor-diagram-history-dialog">
          <div className="dialog-header">
            <Dialog.Title>{t("diagram.dialog.history.title")}</Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="icon-button"
                aria-label={t("diagram.dialog.history.close")}
                title={t("diagram.dialog.history.close")}
              >
                <X size={14} />
              </button>
            </Dialog.Close>
          </div>
          <div className="anchor-diagram-history-toolbar">
            <button
              type="button"
              onClick={() => void handleSaveNow()}
              disabled={busy || !workspace}
              className="anchor-diagram-toolbar-primary"
            >
              {t("diagram.dialog.history.saveNow")}
            </button>
          </div>
          {snapshots.length === 0 ? (
            <p className="anchor-diagram-history-empty">{t("diagram.dialog.history.empty")}</p>
          ) : (
            <ul className="anchor-diagram-history-list">
              {snapshots.map((snap) => {
                const date = parseSnapshotTs(snap.snapshotTs);
                const valid = !Number.isNaN(date.getTime());
                const kb = (snap.size / 1024).toFixed(1);
                return (
                  <li key={snap.snapshotTs}>
                    <div className="anchor-diagram-history-meta">
                      <span className="anchor-diagram-history-ts">
                        {valid ? date.toLocaleString() : snap.snapshotTs}
                      </span>
                      <span className="anchor-diagram-history-size">
                        {t("diagram.dialog.history.size", { kb })}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => void handleRestore(snap.snapshotTs)}
                      disabled={busy}
                    >
                      {t("diagram.dialog.history.restore")}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          <Dialog.Root
            open={pendingRestoreTs !== null}
            onOpenChange={(next) => {
              if (!next) setPendingRestoreTs(null);
            }}
          >
            <Dialog.Portal>
              <Dialog.Overlay className="dialog-overlay" />
              <Dialog.Content className="dialog-content anchor-diagram-confirm-dialog">
                <Dialog.Title>{t("diagram.dialog.history.confirmTitle")}</Dialog.Title>
                <p>{t("diagram.dialog.history.confirmRestore")}</p>
                <div className="dialog-actions">
                  <Dialog.Close asChild>
                    <button type="button">{t("diagram.dialog.confirm.cancel")}</button>
                  </Dialog.Close>
                  <button
                    type="button"
                    className="anchor-diagram-toolbar-primary"
                    disabled={busy}
                    onClick={() => void confirmRestore()}
                  >
                    {t("diagram.dialog.confirm.restore")}
                  </button>
                </div>
              </Dialog.Content>
            </Dialog.Portal>
          </Dialog.Root>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useRef, useState } from "react";
import { chooseWorkspaceDirectory } from "../../../lib/api";
import { confirmDialog } from "../../../lib/confirmDialog";
import { ipcErrorMessage } from "../../../lib/ipcError";
import { useTranslation } from "../../../lib/i18n";
import {
  proposalFromReport,
  repoScanAvailable,
  scanRepository,
  type RepoScanProposal,
} from "../../../lib/diagram/repoScan";
import type { DiagramDoc } from "../../../lib/diagram/types";

export interface ScanRepositoryDialogProps {
  open: boolean;
  workspace: string | null;
  dirty?: boolean;
  /** Opens the proposal as an unsaved document; saving stays the user's step. */
  onOpenProposal: (doc: DiagramDoc) => void;
  onClose: () => void;
}

/**
 * Scan a folder inside the open workspace and review the proposed Floorplan
 * map (issue #553). Nothing is written here: "Open as unsaved document" hands
 * the map to the editor, and the user saves it like any other document.
 */
export function ScanRepositoryDialog({ open, workspace, dirty = false, onOpenProposal, onClose }: ScanRepositoryDialogProps) {
  const { t } = useTranslation();
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<RepoScanProposal | null>(null);
  const epoch = useRef(0);

  useEffect(() => {
    if (!open) return;
    setPath(workspace ?? "");
    setError(null);
    setProposal(null);
    return () => { epoch.current += 1; };
  }, [open, workspace]);

  const pick = async () => {
    const chosen = await chooseWorkspaceDirectory(t("diagram.scan.pickTitle"));
    if (chosen) { setPath(chosen); setProposal(null); setError(null); }
  };

  const run = async () => {
    if (!workspace || !path.trim()) return;
    const ticket = ++epoch.current;
    setBusy(true); setError(null); setProposal(null);
    try {
      const report = await scanRepository(workspace, path.trim());
      if (ticket === epoch.current) setProposal(proposalFromReport(report));
    } catch (err) {
      if (ticket === epoch.current) setError(ipcErrorMessage(err));
    } finally {
      if (ticket === epoch.current) setBusy(false);
    }
  };

  const accept = async () => {
    if (!proposal?.ok) return;
    if (dirty && !(await confirmDialog(t("diagram.dialog.ie.confirmReplace")))) return;
    onOpenProposal(proposal.doc);
  };

  const stats = proposal?.report.stats;
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content maru-diagram-scan" aria-describedby="diagram-scan-description" data-testid="diagram-scan-dialog">
          <Dialog.Title>{t("diagram.scan.title")}</Dialog.Title>
          <Dialog.Description id="diagram-scan-description">{t("diagram.scan.description")}</Dialog.Description>
          {!repoScanAvailable() ? (
            <p role="status">{t("diagram.scan.desktopOnly")}</p>
          ) : !workspace ? (
            <p role="status">{t("diagram.scan.workspaceRequired")}</p>
          ) : (
            <>
              <label>
                {t("diagram.scan.folder")}
                <input
                  type="text"
                  data-testid="diagram-scan-path"
                  value={path}
                  disabled={busy}
                  onChange={(event) => { setPath(event.target.value); setProposal(null); }}
                />
              </label>
              <button type="button" disabled={busy} onClick={() => void pick()}>{t("diagram.scan.browse")}</button>
              <button type="button" data-testid="diagram-scan-run" disabled={busy || !path.trim()} onClick={() => void run()}>
                {t("diagram.scan.run")}
              </button>
              {busy && <p role="status">{t("diagram.scan.running")}</p>}
              {error && <p role="alert" data-testid="diagram-scan-error">{error}</p>}
              {proposal && stats && (
                <section data-testid="diagram-scan-proposal" aria-label={t("diagram.scan.proposal")}>
                  <p data-testid="diagram-scan-summary">
                    {t("diagram.scan.summary", {
                      nodes: stats.nodes,
                      edges: stats.edges,
                      files: stats.files,
                      folder: proposal.report.relativePath || ".",
                    })}
                  </p>
                  <p>{t(stats.inventory === "gitIndex" ? "diagram.scan.inventoryGit" : "diagram.scan.inventoryWalk")}</p>
                  {stats.skippedLarge > 0 && <p>{t("diagram.scan.skippedLarge", { count: stats.skippedLarge })}</p>}
                  {proposal.diagnostics.length > 0 && (
                    <ul>
                      {proposal.diagnostics.map((diagnostic, i) => (
                        <li key={`${diagnostic.key}:${i}`}>{t(diagnostic.key, diagnostic.params ?? {})}</li>
                      ))}
                    </ul>
                  )}
                  {proposal.ok ? (
                    <>
                      <p>{t("diagram.scan.notSaved")}</p>
                      <button type="button" data-testid="diagram-scan-open" disabled={busy} onClick={() => void accept()}>
                        {t("diagram.scan.open")}
                      </button>
                    </>
                  ) : (
                    <p role="alert">{t("diagram.scan.refused")}</p>
                  )}
                </section>
              )}
            </>
          )}
          <button type="button" disabled={busy} onClick={onClose}>{t("diagram.scan.close")}</button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

import * as Dialog from "@radix-ui/react-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { assetUrlForPath } from "../../../lib/binaryViewer";
import { useTranslation } from "../../../lib/i18n";
import { deleteRender, listRenders, openRender, prepareRenderView, rendersAvailable,
  type RenderGroup, type RenderView, type StoredRender } from "../../../lib/diagram/renders";

const FRAME_SANDBOX = "allow-scripts allow-downloads allow-popups allow-popups-to-escape-sandbox";
export interface RendersDialogProps {
  open: boolean;
  workspace: string | null;
  theme: "light" | "dark";
  onRerender: (group: RenderGroup, render: StoredRender) => Promise<void>;
  onClose: () => void;
}

export function RendersDialog({ open, workspace, theme, onRerender, onClose }: RendersDialogProps) {
  const { t } = useTranslation();
  const [groups, setGroups] = useState<RenderGroup[]>([]);
  const [selected, setSelected] = useState<StoredRender | null>(null);
  const [view, setView] = useState<RenderView | null>(null);
  const [preparedTheme, setPreparedTheme] = useState<"light" | "dark" | null>(null);
  const previousTheme = useRef(theme);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState(false);
  const epoch = useRef(0);
  const refresh = useCallback(async () => {
    if (!workspace || !rendersAvailable()) return;
    const ticket = ++epoch.current;
    setBusy(true); setError(null); setView(null); setSelected(null); setPendingDelete(false);
    try { const result = await listRenders(workspace); if (ticket === epoch.current) setGroups(result); }
    catch (err) { if (ticket === epoch.current) setError(String(err)); }
    finally { if (ticket === epoch.current) setBusy(false); }
  }, [workspace]);
  useEffect(() => {
    if (open) void refresh();
    return () => { epoch.current += 1; };
  }, [open, refresh]);
  const select = useCallback(async (render: StoredRender) => {
    if (!workspace) return;
    const ticket = ++epoch.current;
    setSelected(render); setView(null); setError(null); setPendingDelete(false); setBusy(true);
    try {
      const next = await prepareRenderView(workspace, render.docId, render.renderId);
      if (ticket === epoch.current) { setView(next); setPreparedTheme(theme); }
    } catch (err) { if (ticket === epoch.current) setError(String(err)); }
    finally { if (ticket === epoch.current) setBusy(false); }
  }, [workspace, theme]);
  useEffect(() => {
    if (previousTheme.current === theme) return;
    previousTheme.current = theme;
    if (selected) void select(selected);
  }, [theme, selected, select]);
  const action = async (operation: () => Promise<void>, reload = false) => {
    const ticket = epoch.current;
    setBusy(true); setError(null);
    try { await operation(); if (reload && ticket === epoch.current) await refresh(); }
    catch (err) { if (ticket === epoch.current) setError(String(err)); }
    finally { if (ticket === epoch.current) setBusy(false); }
  };
  const group = groups.find((item) => item.docId === selected?.docId);
  const displayedReceipt = view?.receipt ?? selected?.receipt;
  return <Dialog.Root open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
    <Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content maru-diagram-renders" aria-describedby="diagram-renders-description">
      <Dialog.Title>{t("diagram.renders.title")}</Dialog.Title>
      <Dialog.Description id="diagram-renders-description">{t("diagram.renders.description")}</Dialog.Description>
      {!rendersAvailable() ? <p role="status">{t("diagram.renders.desktopOnly")}</p> : !workspace ? <p role="status">{t("diagram.renders.workspaceRequired")}</p> : <>
        <button type="button" disabled={busy} onClick={() => void refresh()}>{t("diagram.renders.refresh")}</button>
        <div className="maru-diagram-renders-columns"><div className="maru-diagram-renders-list">
          {!groups.length && !busy && <p>{t("diagram.renders.empty")}</p>}
          {groups.map((entry) => <section key={entry.docId}>
            <h3>{entry.documentName ?? entry.docId}{entry.orphaned ? ` (${t("diagram.renders.orphaned")})` : ""}</h3>
            {entry.renders.map((render) => <button type="button" key={render.renderId} data-testid="diagram-render-entry" aria-pressed={selected?.docId === render.docId && selected.renderId === render.renderId} disabled={busy} onClick={() => void select(render)}>
              <span>{render.receipt?.renderedAt ?? render.renderId}</span>
              <span>{render.verified && render.receipt ? `${render.receipt.enginePin.name} ${render.receipt.enginePin.version} / ${render.receipt.diagramType}` : t("diagram.renders.unverified")}</span>
              <span>{render.verified && render.receipt ? `${render.receipt.gates.schema.status} / ${render.receipt.gates.artifact.status} / ${render.receipt.gates.visualReview.status}` : render.diagnostic}</span>
            </button>)}
          </section>)}
        </div><div className="maru-diagram-renders-detail">
          {selected && <div className="maru-diagram-renders-actions">
            <button disabled={busy || !view} onClick={() => void action(() => openRender(workspace, selected))}>{t("diagram.renders.open")}</button>
            <button disabled={busy || !view} onClick={() => void action(() => openRender(workspace, selected, true))}>{t("diagram.renders.reveal")}</button>
            <button disabled={busy || !group || group.orphaned} onClick={() => group && void action(() => onRerender(group, selected), true)}>{t("diagram.renders.rerender")}</button>
            <button disabled={busy} onClick={() => setPendingDelete(true)}>{t("diagram.renders.delete")}</button>
            {pendingDelete && <div role="alert"><p>{t("diagram.renders.deleteConfirm")}</p><button disabled={busy} onClick={() => void action(() => deleteRender(workspace, selected.docId, selected.renderId), true)}>{t("diagram.renders.confirmDelete")}</button><button disabled={busy} onClick={() => setPendingDelete(false)}>{t("diagram.renders.cancel")}</button></div>}
          </div>}
          {error && <p role="alert">{error}</p>}
          {busy && <p role="status">{t("diagram.renders.loading")}</p>}
          {view && preparedTheme === theme && (view.mimeType === "text/html" ? <iframe key={`${view.path}:${theme}`} title={t("diagram.renders.frameTitle")} data-testid="diagram-render-frame" sandbox={FRAME_SANDBOX} referrerPolicy="no-referrer" src={`${assetUrlForPath(view.path)}?theme=${theme}`} /> : <img src={assetUrlForPath(view.path)} alt={t("diagram.renders.frameTitle")} />)}
          {displayedReceipt && <dl className="maru-diagram-render-receipt">
            <dt>{t("diagram.renders.documentRevision")}</dt><dd>{displayedReceipt.documentRevision}</dd>
            <dt>{t("diagram.renders.specHash")}</dt><dd>{displayedReceipt.inputSpecSha256}</dd>
            <dt>{t("diagram.renders.artifactHash")}</dt><dd>{displayedReceipt.outputSha256}</dd>
            <dt>{t("diagram.renders.gates")}</dt><dd>{JSON.stringify(displayedReceipt.gates)}</dd>
          </dl>}
        </div></div>
      </>}
      <button type="button" disabled={busy} onClick={onClose}>{t("diagram.renders.close")}</button>
    </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DocumentHandle } from "@hwp-editor/core";
import { useTranslation } from "../../lib/i18n";
import { captureHwpedSource, saveHwpedDocument } from "../../lib/hwpedPersistence";
import { IpcError, ipcErrorMessage, normalizeIpcError } from "../../lib/ipcError";
import { registerHwpxEditorGuard } from "../../lib/hwpxEditorGuard";
import { useWorkspaceRegistry } from "../../lib/workspaceStore";
import { workspaceCapabilities } from "../../lib/workspaceCapabilities";
import type { WorkspaceFileEntry } from "../../lib/types";
import { HwpxViewer } from "./HwpxViewer";
import { DialogSurface, DialogSurfaceTitle } from "../ui/DialogSurface";

const EDITOR_MAX_BYTES = 32 * 1024 * 1024;
const HwpEditorSurface = lazy(() => import("./HwpEditorSurface").then((module) => ({ default: module.HwpEditorSurface })));
interface Props {
  entry: WorkspaceFileEntry;
  workspacePath: string;
  onPreviewExternal: () => void;
  onOpenExternal: () => void;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
function base64Bytes(data: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < data.length; i += 8192) binary += String.fromCharCode(...data.subarray(i, i + 8192));
  return btoa(binary);
}

/** A keyed session prevents late engine/save results from changing another file. */
export function HwpxEditorPane(props: Props) {
  return <HwpxEditorSession key={JSON.stringify([props.workspacePath, props.entry.relPath])} {...props} />;
}

function HwpxEditorSession({ entry, workspacePath, onPreviewExternal, onOpenExternal }: Props) {
  const { t } = useTranslation();
  const registry = useWorkspaceRegistry();
  const selectedWorkspace = registry.workspaces.find((root) => root.path === workspacePath);
  const owner = registry.workspaces.filter((root) => entry.path === root.path || entry.path.startsWith(`${root.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0]
    // Scanners can return a physical path for a selected symlink/dot alias.
    // Rust still rechecks alias ownership and nested policies on every save.
    ?? selectedWorkspace;
  const writable = workspaceCapabilities(owner).canModify &&
    (!selectedWorkspace || workspaceCapabilities(selectedWorkspace).canModify);
  const [editing, setEditing] = useState(false);
  const [file, setFile] = useState<DocumentHandle | null>(null);
  const [fileGeneration, setFileGeneration] = useState(0);
  const [current, setCurrent] = useState<DocumentHandle | null>(null);
  const [baseline, setBaseline] = useState<{ data: Uint8Array; revision: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [ready, setReady] = useState(false);
  const [activity, setActivity] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [previewVersion, setPreviewVersion] = useState(0);
  const [discard, setDiscard] = useState(false);
  const [reloading, setReloading] = useState(false);
  const pane = useRef<HTMLDivElement>(null);
  const saveRef = useRef<() => Promise<boolean>>(async () => false);
  const alive = useRef(true);
  const generation = useRef(0);
  const captureRequest = useRef(0);
  const saveLock = useRef(false);
  const discardAnswer = useRef<((answer: boolean) => void) | null>(null);
  const unsaved = useMemo(() => current !== null && baseline !== null && !sameBytes(current.data, baseline.data), [baseline, current]);
  const busy = loading || saving || activity || navigating;
  const canSave = writable && ready && current !== null && baseline !== null && unsaved && !pending && !busy;
  const state = useRef({ pending, unsaved, busy, canSave });
  state.current = { pending, unsaved, busy, canSave };

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; generation.current += 1; captureRequest.current += 1; discardAnswer.current?.(false); };
  }, []);

  const capture = useCallback(async (): Promise<boolean> => {
    const token = ++captureRequest.current;
    state.current.busy = true; state.current.canSave = false;
    setLoading(true); setError(null);
    try {
      const result = await captureHwpedSource(workspacePath, entry.relPath);
      if (!alive.current || token !== captureRequest.current) return false;
      const data = Uint8Array.from(atob(result.source.dataBase64), (value) => value.charCodeAt(0));
      const handle = { name: entry.name, data };
      generation.current += 1;
      setFileGeneration(generation.current); setActivity(false);
      setFile(handle); setCurrent(handle); setBaseline({ data: data.slice(), revision: result.source.revision });
      setReady(false); setPending(false); setConflict(false); setSaved(false);
      return true;
    } catch (cause) {
      if (alive.current && token === captureRequest.current) setError(t("binaryViewer.hwpEditorLoadFailed", { message: ipcErrorMessage(cause) }));
      return false;
    } finally {
      if (alive.current && token === captureRequest.current) setLoading(false);
    }
  }, [entry.name, entry.relPath, t, workspacePath]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!state.current.canSave || saveLock.current || current === null || baseline === null) return false;
    saveLock.current = true;
    const token = generation.current;
    const data = current.data.slice();
    const revision = baseline.revision;
    setSaving(true); setError(null); setSaved(false);
    try {
      const result = await saveHwpedDocument(workspacePath, entry.relPath, base64Bytes(data), revision);
      if (!alive.current || token !== generation.current) return false;
      setBaseline({ data, revision: result.revision }); setSaved(true); setConflict(false);
      setPreviewVersion((value) => value + 1);
      window.dispatchEvent(new CustomEvent("maru:hwpx-saved", { detail: { workspacePath, documentPath: entry.relPath, sizeBytes: result.sizeBytes } }));
      return true;
    } catch (cause) {
      if (!alive.current || token !== generation.current) return false;
      const normalized = normalizeIpcError(cause);
      setConflict(normalized instanceof IpcError && normalized.code === "document_conflict");
      setError(t("binaryViewer.hwpEditorSaveFailed", { message: ipcErrorMessage(normalized) }));
      return false;
    } finally {
      saveLock.current = false;
      if (alive.current && token === generation.current) setSaving(false);
    }
  }, [baseline, current, entry.relPath, t, workspacePath]);

  saveRef.current = () => discard ? Promise.resolve(false) : save();

  const answerDiscard = useCallback((answer: boolean) => {
    const resolve = discardAnswer.current;
    discardAnswer.current = null;
    setDiscard(false);
    resolve?.(answer);
  }, []);

  useEffect(() => registerHwpxEditorGuard({
    ownsFocus: () => pane.current?.contains(document.activeElement) ?? false,
    hasChanges: () => state.current.pending || state.current.unsaved || state.current.busy,
    save: () => saveRef.current(),
    setNavigationBusy: (value) => {
      if (!alive.current) return;
      if (value) { state.current.busy = true; state.current.canSave = false; }
      setNavigating(value);
    },
    beforeLeave: async () => {
    if (!state.current.pending && !state.current.unsaved && !state.current.busy) return true;
    if (discardAnswer.current !== null) return false;
    setDiscard(true);
    return new Promise<boolean>((resolve) => { discardAnswer.current = resolve; });
  } }), []);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!state.current.pending && !state.current.unsaved && !state.current.busy) return;
      event.preventDefault(); event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);

  const reload = async () => {
    if (busy) return;
    if (pending || unsaved) {
      if (discardAnswer.current !== null) return;
      setReloading(true); setDiscard(true);
      const accepted = await new Promise<boolean>((resolve) => { discardAnswer.current = resolve; });
      setReloading(false);
      if (!accepted) return;
    }
    await capture();
  };

  return (
    <div ref={pane} className="hwp-editor-pane" tabIndex={-1} onKeyDownCapture={(event) => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "s") {
        event.preventDefault(); event.stopPropagation(); if (!discard) void save();
      }
    }}>
      <div className="hwp-editor-pane-bar">
        {entry.sizeBytes > EDITOR_MAX_BYTES ? null : <button type="button" className="hwp-editor-pane-toggle" aria-pressed={editing} disabled={loading || saving || navigating}
          onClick={() => { if (!file && !editing) void capture(); setEditing((value) => !value); }}>
          {editing ? t("binaryViewer.hwpEditorClose") : t("binaryViewer.hwpEditorOpen")}
        </button>}
        {file ? <button type="button" data-testid="hwpx-save" disabled={!canSave} onClick={() => void save()}>{t(saving ? "binaryViewer.hwpEditorSaving" : "binaryViewer.hwpEditorSave")}</button> : null}
        <p className="hwp-editor-pane-note" role="status" aria-live="polite" data-testid="hwpx-status">
          {pending ? t("binaryViewer.hwpEditorApplyFirst") : unsaved ? t("binaryViewer.hwpEditorNotSaved") : saved ? t("binaryViewer.hwpEditorSaved") : loading ? t("binaryViewer.loading") : ""}
          {file && !writable ? t("binaryViewer.hwpEditorReadOnly") : ""}
          {pending || unsaved ? ` ${t("binaryViewer.hwpEditorExternalNotice")}` : ""}
        </p>
      </div>
      {conflict ? <div role="alert" data-testid="hwpx-conflict">
        <p>{t("binaryViewer.hwpEditorConflict")}</p>
        <button type="button" data-testid="hwpx-keep-editing" onClick={() => { setConflict(false); setError(null); }}>{t("binaryViewer.hwpEditorKeepEditing")}</button>
        <button type="button" data-testid="hwpx-reload" disabled={busy} onClick={() => void reload()}>{t("binaryViewer.hwpEditorReload")}</button>
      </div> : null}
      {error ? <div role="alert" data-testid="hwpx-error">{error}{!file ? <button type="button" onClick={() => void capture()}>{t("binaryViewer.hwpEditorRetry")}</button> : null}</div> : null}
      <DialogSurface open={discard} onOpenChange={(open) => { if (!open) answerDiscard(false); }} ariaLabel={t("binaryViewer.hwpEditorDiscardTitle")} data-testid="hwpx-discard-dialog">
        <DialogSurfaceTitle>{t("binaryViewer.hwpEditorDiscardTitle")}</DialogSurfaceTitle>
        <p>{t(reloading ? "binaryViewer.hwpEditorReloadConfirm" : "binaryViewer.hwpEditorDiscardPrompt")}</p>
        <button type="button" data-testid="hwpx-discard-cancel" onClick={() => answerDiscard(false)}>{t("binaryViewer.hwpEditorCancel")}</button>
        <button type="button" data-testid="hwpx-discard" disabled={busy} onClick={() => answerDiscard(true)}>{t("binaryViewer.hwpEditorDiscard")}</button>
        {canSave && !reloading ? <button type="button" data-testid="hwpx-discard-save" onClick={() => { void save().then(answerDiscard); }}>{t("binaryViewer.hwpEditorSave")}</button> : null}
      </DialogSurface>
      {file ? <div className="hwp-editor-host" hidden={!editing}>
        <Suspense fallback={<p>{t("binaryViewer.loading")}</p>}>
          <HwpEditorSurface key={fileGeneration} file={file} workspacePath={workspacePath} locked={saving || loading || discard || navigating}
            onReady={(document) => { if (alive.current && fileGeneration === generation.current) { setCurrent(document); setReady(true); } }}
            onChange={(document) => { if (alive.current && fileGeneration === generation.current) { state.current.canSave = false; state.current.unsaved = baseline !== null && !sameBytes(document.data, baseline.data); setCurrent({ ...document, data: document.data.slice() }); setSaved(false); } }}
            onDirtyChange={(value) => { if (alive.current && fileGeneration === generation.current) { state.current.pending = value; if (value) state.current.canSave = false; setPending(value); } }}
            onActivityChange={(value) => { if (alive.current && fileGeneration === generation.current) { state.current.busy = value || loading || saving || navigating; if (value) state.current.canSave = false; setActivity(value); } }}
            onError={(cause) => { if (alive.current && fileGeneration === generation.current) setError(t("binaryViewer.hwpEditorEngineFailed", { message: ipcErrorMessage(cause) })); }} />
        </Suspense>
      </div> : null}
      {editing ? null : <HwpxViewer key={previewVersion} entry={entry} workspacePath={workspacePath} onPreviewExternal={onPreviewExternal} onOpenExternal={onOpenExternal} />}
    </div>
  );
}

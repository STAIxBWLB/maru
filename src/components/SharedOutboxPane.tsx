import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  CheckCircle2,
  FolderOpen,
  FolderPlus,
  Plus,
  RefreshCcw,
  Send,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { chooseFiles, chooseWorkspaceDirectory } from "../lib/api";
import { useTranslation } from "../lib/i18n";
import {
  basenameOf,
  buildShareQueue,
  type ShareOutboxConfig,
  type ShareOutboxResult,
  type ShareOutboxScan,
  type ShareOutboxSource,
} from "../lib/shareOutbox";

interface SharedOutboxPaneProps {
  workspacePath: string | null;
  activeDocument: { path: string; title: string; dirty: boolean } | null;
  selectedFileEntries: Array<{ path: string; name: string }>;
  inboxShareablePaths: string[];
  onError: (message: string | null) => void;
  onRevealFileInFinder: (targetPath: string) => void;
}

export function SharedOutboxPane({
  workspacePath,
  activeDocument,
  selectedFileEntries,
  inboxShareablePaths,
  onError,
  onRevealFileInFinder,
}: SharedOutboxPaneProps) {
  const { t } = useTranslation();
  const [config, setConfig] = useState<ShareOutboxConfig | null>(null);
  const [scan, setScan] = useState<ShareOutboxScan | null>(null);
  const [manualPaths, setManualPaths] = useState<string[]>([]);
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [author, setAuthor] = useState<string>("");
  const [replace, setReplace] = useState(true);
  const [applying, setApplying] = useState(false);
  const [results, setResults] = useState<ShareOutboxResult[] | null>(null);

  const loadConfig = useCallback(async () => {
    if (!workspacePath) return;
    try {
      const next = await invoke<ShareOutboxConfig>("read_share_outbox_config", {
        workPath: workspacePath,
      });
      setConfig(next);
      setAuthor((current) => current || next.defaultAuthor || "");
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }, [workspacePath, onError]);

  const loadRecent = useCallback(async () => {
    if (!workspacePath) return;
    try {
      setScan(await invoke<ShareOutboxScan>("scan_share_outbox", { workPath: workspacePath }));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }, [workspacePath, onError]);

  useEffect(() => {
    setManualPaths([]);
    setRemoved(new Set());
    setTitles({});
    setResults(null);
    setConfig(null);
    setScan(null);
    if (!workspacePath) return;
    void loadConfig();
    void loadRecent();
  }, [workspacePath, loadConfig, loadRecent]);

  const queue = useMemo(
    () =>
      buildShareQueue({
        activeDocument,
        selectedFileEntries: selectedFileEntries.map((entry) => ({
          path: entry.path,
          name: entry.name,
        })),
        inboxShareablePaths,
        manualPaths,
      }).filter((item) => !removed.has(item.path)),
    [activeDocument, selectedFileEntries, inboxShareablePaths, manualPaths, removed],
  );

  const sources: ShareOutboxSource[] = useMemo(
    () =>
      queue
        .filter((item) => item.shareable)
        .map((item) => ({ path: item.path, title: titles[item.path]?.trim() || null })),
    [queue, titles],
  );

  const canApply =
    !!workspacePath && !!config?.hasRequiredConfig && sources.length > 0 && !applying;

  const handleSetRoot = useCallback(async () => {
    if (!workspacePath) return;
    const picked = await chooseWorkspaceDirectory(t("shareOutbox.pickRoot"));
    if (!picked) return;
    try {
      setConfig(await invoke<ShareOutboxConfig>("save_share_outbox_root", {
        workPath: workspacePath,
        root: picked,
      }));
      await loadRecent();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }, [workspacePath, t, loadRecent, onError]);

  const handleCreateRoot = useCallback(async () => {
    if (!workspacePath) return;
    try {
      await invoke("ensure_share_outbox_root", { workPath: workspacePath });
      await loadConfig();
      await loadRecent();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  }, [workspacePath, loadConfig, loadRecent, onError]);

  const handleAddFiles = useCallback(async () => {
    const picked = await chooseFiles(t("shareOutbox.pickFiles"));
    if (picked.length === 0) return;
    setManualPaths((current) => {
      const merged = new Set(current);
      for (const path of picked) merged.add(path);
      return [...merged];
    });
  }, [t]);

  const handleRemove = useCallback((path: string) => {
    setRemoved((current) => {
      const next = new Set(current);
      next.add(path);
      return next;
    });
  }, []);

  const handleClear = useCallback(() => {
    setManualPaths([]);
    setRemoved(new Set());
    setTitles({});
  }, []);

  const handleApply = useCallback(async () => {
    if (!workspacePath || sources.length === 0) return;
    setApplying(true);
    onError(null);
    try {
      const res = await invoke<ShareOutboxResult[]>("prepare_share_outbox_files", {
        workPath: workspacePath,
        sources,
        options: { author: author || null, replace, dryRun: false },
      });
      setResults(res);
      await loadRecent();
      await loadConfig();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplying(false);
    }
  }, [workspacePath, sources, author, replace, loadRecent, loadConfig, onError]);

  if (!workspacePath) {
    return (
      <div className="share-outbox-pane">
        <p className="share-outbox-hint">{t("shareOutbox.noWorkspace")}</p>
      </div>
    );
  }

  return (
    <div className="share-outbox-pane">
      {/* (a) Root config */}
      <section className="share-outbox-section">
        <div className="share-outbox-root">
          <span className="share-outbox-root-label">{t("shareOutbox.root")}</span>
          <code className="share-outbox-root-path" title={config?.rootResolved ?? ""}>
            {config?.rootResolved ?? "—"}
          </code>
        </div>
        {config && !config.insideWorkspace && config.root ? (
          <p className="share-outbox-warn">
            <AlertTriangle size={13} /> {t("shareOutbox.outsideWorkspace")}
          </p>
        ) : null}
        {config && config.root && !config.rootExists ? (
          <p className="share-outbox-warn">
            <AlertTriangle size={13} /> {t("shareOutbox.rootMissing")}
          </p>
        ) : null}
        {config && config.missingKeys.length > 0 ? (
          <p className="share-outbox-warn">
            <AlertTriangle size={13} />{" "}
            {t("shareOutbox.missingConfig", { keys: config.missingKeys.join(", ") })}
          </p>
        ) : null}
        <div className="share-outbox-actions">
          <button type="button" onClick={() => void handleSetRoot()}>
            {t("shareOutbox.setRoot")}
          </button>
          <button
            type="button"
            onClick={() => void handleCreateRoot()}
            disabled={!config?.root || config.rootExists}
          >
            <FolderPlus size={14} /> {t("shareOutbox.createRoot")}
          </button>
          <button
            type="button"
            onClick={() => config?.rootResolved && onRevealFileInFinder(config.rootResolved)}
            disabled={!config?.rootExists}
          >
            <FolderOpen size={14} /> {t("shareOutbox.openFolder")}
          </button>
          <button
            type="button"
            onClick={() => {
              void loadConfig();
              void loadRecent();
            }}
            title={t("shareOutbox.refresh")}
            aria-label={t("shareOutbox.refresh")}
          >
            <RefreshCcw size={14} />
          </button>
        </div>
        <div className="share-outbox-options">
          <label>
            {t("shareOutbox.author")}
            <select value={author} onChange={(event) => setAuthor(event.target.value)}>
              {(config?.authors ?? []).map((entry) => (
                <option key={entry.key} value={entry.key}>
                  {entry.key}
                  {entry.suffix ? ` (${entry.suffix})` : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="share-outbox-checkbox">
            <input
              type="checkbox"
              checked={replace}
              onChange={(event) => setReplace(event.target.checked)}
            />
            {t("shareOutbox.replace")}
          </label>
        </div>
      </section>

      {/* (b) Queue */}
      <section className="share-outbox-section">
        <div className="share-outbox-section-head">
          <h4>{t("shareOutbox.queue")}</h4>
          <div className="share-outbox-actions">
            <button type="button" onClick={() => void handleAddFiles()}>
              <Plus size={14} /> {t("shareOutbox.addFiles")}
            </button>
            <button type="button" onClick={handleClear} disabled={queue.length === 0}>
              {t("shareOutbox.clear")}
            </button>
          </div>
        </div>
        {queue.length === 0 ? (
          <p className="share-outbox-hint">{t("shareOutbox.queueEmpty")}</p>
        ) : (
          <ul className="share-outbox-queue">
            {queue.map((item) => (
              <li
                key={item.path}
                className={item.shareable ? "share-outbox-queue-item" : "share-outbox-queue-item disabled"}
              >
                <div className="share-outbox-queue-main">
                  <span className="share-outbox-queue-label" title={item.path}>
                    {item.label}
                  </span>
                  <span className="share-outbox-source-chip">
                    {t(`shareOutbox.source.${item.source}`)}
                  </span>
                  <button
                    type="button"
                    className="icon-button"
                    onClick={() => handleRemove(item.path)}
                    title={t("shareOutbox.remove")}
                    aria-label={t("shareOutbox.remove")}
                  >
                    <X size={13} />
                  </button>
                </div>
                {item.shareable ? (
                  <input
                    type="text"
                    className="share-outbox-title-input"
                    value={titles[item.path] ?? ""}
                    placeholder={t("shareOutbox.titlePlaceholder")}
                    onChange={(event) =>
                      setTitles((current) => ({ ...current, [item.path]: event.target.value }))
                    }
                  />
                ) : (
                  <span className="share-outbox-reason">
                    {item.disabledReason ? t(item.disabledReason) : ""}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <button
          type="button"
          className="share-outbox-apply"
          onClick={() => void handleApply()}
          disabled={!canApply}
        >
          <Send size={14} /> {applying ? t("shareOutbox.applying") : t("shareOutbox.apply")}
        </button>
      </section>

      {/* (c) Results */}
      {results && results.length > 0 ? (
        <section className="share-outbox-section">
          <h4>{t("shareOutbox.results")}</h4>
          <ul className="share-outbox-results">
            {results.map((result) => (
              <li
                key={result.source}
                className={result.ok ? "share-outbox-result ok" : "share-outbox-result failed"}
              >
                {result.ok ? <CheckCircle2 size={13} /> : <AlertTriangle size={13} />}
                <span title={result.output ?? result.source}>
                  {basenameOf(result.output ?? result.source)}
                </span>
                {result.ok ? (
                  <em>{t("shareOutbox.result.ok")}</em>
                ) : (
                  <em className="share-outbox-result-error" title={result.error ?? ""}>
                    {result.error ?? t("shareOutbox.result.failed")}
                  </em>
                )}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* (d) Recent */}
      <section className="share-outbox-section">
        <h4>{t("shareOutbox.recent")}</h4>
        {!scan || scan.items.length === 0 ? (
          <p className="share-outbox-hint">{t("shareOutbox.recentEmpty")}</p>
        ) : (
          <ul className="share-outbox-recent">
            {scan.items.map((file) => (
              <li
                key={file.output}
                className={file.exists ? "share-outbox-recent-item" : "share-outbox-recent-item missing"}
              >
                <div className="share-outbox-recent-main">
                  <span className="share-outbox-recent-title" title={file.output}>
                    {file.title || file.name}
                  </span>
                  <span className="share-outbox-recent-meta">
                    {[file.author, file.timestamp].filter(Boolean).join(" · ")}
                  </span>
                </div>
                <button
                  type="button"
                  className="icon-button"
                  onClick={() => onRevealFileInFinder(file.output)}
                  disabled={!file.exists}
                  title={t("shareOutbox.reveal")}
                  aria-label={t("shareOutbox.reveal")}
                >
                  <FolderOpen size={13} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

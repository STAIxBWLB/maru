import "./architecture.css";

import { DraftingCompass, ExternalLink, FolderSearch, RefreshCcw, SquarePen } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  architectureReadSiblingSpec,
  listArchitectureBlueprints,
  openInFileManager,
  prepareArchitectureBlueprint,
  type ArchitectureBlueprint,
  type ArchitectureSiblingSpec,
} from "../../lib/api";
import { assetUrlForPath } from "../../lib/binaryViewer";
import { parseArchifySpec } from "../../lib/diagram/archifyCodec";
import { layoutDoc } from "../../lib/diagram/layout";
import { listDiagrams, writeDiagram } from "../../lib/diagram/persistence";
import { projectSemanticCandidate } from "../../lib/diagram/proposal";
import { createDiagramId, createEmptyDoc } from "../../lib/diagram/types";
import { IpcError } from "../../lib/ipcError";
import { useTranslation } from "../../lib/i18n";
import { IconButton } from "../ui/Button";
import { EmptyState, StatusBanner } from "../ui/ModeChrome";

/**
 * No allow-same-origin: the asset-origin viewer runs its own scripts but
 * gets an opaque origin, so it cannot reach the app document or Tauri IPC.
 * Its remote links are sent to the system browser by the main-webview
 * navigation guard (site_view::external_link_plugin).
 */
export const BLUEPRINT_FRAME_SANDBOX =
  "allow-scripts allow-downloads allow-popups allow-popups-to-escape-sandbox";

const GROUPS = ["dev", "sites"] as const;

function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function useAppTheme(): "light" | "dark" {
  const [theme, setTheme] = useState(currentTheme);
  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(currentTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);
  return theme;
}

export interface ArchitecturePaneProps {
  workspacePath: string | null;
  /** Destination workspace used by Diagram; gallery sources remain in workspacePath. */
  copyWorkspacePath?: string | null;
  onRevealInFiles?(targetPath: string): void;
  /** Issue #433 handoff: open a saved workspace diagram in Diagram mode. */
  onOpenDiagram?(documentName: string): void;
}

/** Diagram file names are validated by the backend: no traversal, no leading
 *  dots, no control chars. Mirror that here so the handoff never proposes a
 *  name the write would reject. */
function sanitizeDiagramName(raw: string): string {
  const cleaned = raw
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : "architecture-copy";
}

export function ArchitecturePane({ workspacePath, copyWorkspacePath, onRevealInFiles, onOpenDiagram }: ArchitecturePaneProps) {
  const { t } = useTranslation();
  const theme = useAppTheme();
  const [blueprints, setBlueprints] = useState<ArchitectureBlueprint[]>([]);
  const [loading, setLoading] = useState(Boolean(workspacePath));
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [grantedPath, setGrantedPath] = useState<string | null>(null);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [siblingSpec, setSiblingSpec] = useState<ArchitectureSiblingSpec | null>(null);
  const [copyState, setCopyState] = useState<{ kind: "busy" } | { kind: "error"; message: string } | null>(null);
  const listRequest = useRef(0);

  const selected = blueprints.find((item) => item.htmlPath === selectedPath) ?? null;

  const refresh = useCallback(async () => {
    if (!workspacePath) return;
    // A slower listing for a previous workspace must not overwrite this one.
    const request = ++listRequest.current;
    setLoading(true);
    setError(null);
    try {
      const listed = await listArchitectureBlueprints(workspacePath);
      if (request !== listRequest.current) return;
      setBlueprints(listed);
      setSelectedPath((current) =>
        current && listed.some((item) => item.htmlPath === current) ? current : listed[0]?.htmlPath ?? null,
      );
    } catch (err) {
      if (request === listRequest.current) setError(String(err));
    } finally {
      if (request === listRequest.current) setLoading(false);
    }
  }, [workspacePath]);

  useEffect(() => {
    setBlueprints([]);
    setSelectedPath(null);
    void refresh();
  }, [refresh]);

  useEffect(() => {
    setGrantedPath(null);
    setPrepareError(null);
    setOpenError(null);
    if (!workspacePath || !selectedPath) return;
    let cancelled = false;
    prepareArchitectureBlueprint(workspacePath, selectedPath).then(
      (path) => {
        if (!cancelled) setGrantedPath(path);
      },
      (err) => {
        if (!cancelled) setPrepareError(String(err));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [selectedPath, workspacePath]);

  const canOpenDiagram = Boolean(onOpenDiagram);

  // Issue #433 handoff probe: a sibling typed spec enables "copy to Diagram".
  // The guarded backend read re-proves listing membership and applies its own
  // containment/symlink/size/schema checks, so a missing or unsupported spec
  // simply leaves the action unavailable (the diagnostic surfaces on click).
  useEffect(() => {
    setSiblingSpec(null);
    setCopyState(null);
    if (!workspacePath || !selectedPath || !canOpenDiagram) return;
    let cancelled = false;
    architectureReadSiblingSpec(workspacePath, selectedPath).then(
      (spec) => {
        if (!cancelled) setSiblingSpec(spec);
      },
      () => {
        if (!cancelled) setSiblingSpec(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [selectedPath, workspacePath, canOpenDiagram]);

  const destinationWorkspace = copyWorkspacePath === undefined ? workspacePath : copyWorkspacePath;
  const handleCopyToDiagram = useCallback(async () => {
    if (!destinationWorkspace || !workspacePath || !selectedPath || !onOpenDiagram || !siblingSpec) return;
    setCopyState({ kind: "busy" });
    try {
      const outcome = parseArchifySpec(siblingSpec.specJson, {
        provenance: {
          origin: "gallery-copy",
          sourcePath: selected?.repoPath ?? selectedPath,
          repository: siblingSpec.submodule,
          revision: siblingSpec.commit ?? undefined,
          capturedAt: Date.now(),
        },
      });
      if (!outcome.ok) {
        const first = outcome.diagnostics[0];
        throw new Error(first ? t(first.key, first.params) : t("architecture.copyToDiagram.invalid"));
      }
      const { dataset } = outcome.result;
      const projected = projectSemanticCandidate(dataset);
      const doc = createEmptyDoc(createDiagramId());
      doc.docTitle = dataset.name;
      doc.datasets = [dataset];
      const laidOut = layoutDoc({ ...doc, nodes: projected.nodes, edges: projected.edges });
      doc.nodes = laidOut.doc.nodes;
      doc.edges = laidOut.doc.edges;

      // Never overwrite: pick a name no existing diagram uses.
      const existing = new Set((await listDiagrams(destinationWorkspace)).map((file) => file.name));
      const base = sanitizeDiagramName(dataset.name);
      let name = base;
      let suffix = 2;
      for (;;) {
        if (!existing.has(name)) {
          try {
            await writeDiagram(destinationWorkspace, name, doc, "");
            break;
          } catch (err) {
            if (!(err instanceof IpcError) || err.code !== "document_conflict") throw err;
            // A concurrent creator won; retry a fresh candidate, never modify it.
          }
        }
        name = `${base}-${suffix}`;
        suffix += 1;
      }
      setCopyState(null);
      onOpenDiagram(name);
    } catch (err) {
      setCopyState({ kind: "error", message: (err as Error).message ?? String(err) });
    }
  }, [destinationWorkspace, workspacePath, selectedPath, onOpenDiagram, siblingSpec, selected?.repoPath, t]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return blueprints;
    return blueprints.filter((item) =>
      `${item.title} ${item.repoPath} ${item.slug}`.toLowerCase().includes(needle),
    );
  }, [blueprints, query]);

  if (!workspacePath) {
    return (
      <section className="architecture-pane" aria-label={t("mode.architecture")}>
        <EmptyState icon={<DraftingCompass size={18} />} title={t("architecture.noWorkspace")} />
      </section>
    );
  }

  return (
    <section className="architecture-pane" aria-label={t("mode.architecture")}>
      <aside className="architecture-list-col">
        <div className="architecture-list-toolbar">
          <input
            type="search"
            className="architecture-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("architecture.search.placeholder")}
            aria-label={t("architecture.search.placeholder")}
          />
          <IconButton label={t("architecture.refresh")} size="sm" onClick={() => void refresh()} disabled={loading}>
            <RefreshCcw size={14} />
          </IconButton>
        </div>
        {error ? (
          <StatusBanner tone="danger">
            <span>{t("architecture.error", { message: error })}</span>
          </StatusBanner>
        ) : null}
        <div className="architecture-list" aria-busy={loading}>
          {loading && blueprints.length === 0 ? (
            <p className="architecture-list-note" role="status">{t("architecture.loading")}</p>
          ) : null}
          {!loading && blueprints.length === 0 && !error ? (
            <EmptyState icon={<DraftingCompass size={18} />} title={t("architecture.empty")} />
          ) : null}
          {blueprints.length > 0 && visible.length === 0 ? (
            <p className="architecture-list-note" role="status">{t("architecture.noMatch")}</p>
          ) : null}
          {GROUPS.map((group) => {
            const items = visible.filter((item) => item.group === group);
            if (items.length === 0) return null;
            return (
              <div key={group} className="architecture-group" role="group" aria-label={t(`architecture.group.${group}`)}>
                <h3 className="architecture-group-title">
                  {t(`architecture.group.${group}`)}
                  <span className="architecture-group-count">{items.length}</span>
                </h3>
                {items.map((item) => (
                  <button
                    key={item.htmlPath}
                    type="button"
                    className={item.htmlPath === selectedPath ? "architecture-item active" : "architecture-item"}
                    aria-current={item.htmlPath === selectedPath ? "true" : undefined}
                    onClick={() => setSelectedPath(item.htmlPath)}
                  >
                    <strong>{item.title}</strong>
                    <code>{item.repoPath}</code>
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      </aside>
      <div className="architecture-viewer-col">
        {selected ? (
          <>
            <div className="architecture-viewer-toolbar">
              <span className="architecture-viewer-title">
                <strong>{selected.title}</strong>
                <code>{selected.repoPath}</code>
              </span>
              {onOpenDiagram && destinationWorkspace && siblingSpec ? (
                <IconButton
                  label={t("architecture.copyToDiagram")}
                  size="sm"
                  onClick={() => void handleCopyToDiagram()}
                  disabled={copyState?.kind === "busy"}
                  data-testid="architecture-copy-to-diagram"
                >
                  <SquarePen size={14} />
                </IconButton>
              ) : null}
              {onRevealInFiles ? (
                <IconButton label={t("context.revealInFiles")} size="sm" onClick={() => onRevealInFiles(selected.htmlPath)}>
                  <FolderSearch size={14} />
                </IconButton>
              ) : null}
              <IconButton
                label={t("architecture.openInBrowser")}
                size="sm"
                onClick={() => {
                  setOpenError(null);
                  openInFileManager(workspacePath, selected.htmlPath).catch((err) => setOpenError(String(err)));
                }}
              >
                <ExternalLink size={14} />
              </IconButton>
            </div>
            {openError ? (
              <StatusBanner tone="danger">
                <span>{t("architecture.openError", { message: openError })}</span>
              </StatusBanner>
            ) : null}
            {copyState?.kind === "error" ? (
              <StatusBanner tone="danger">
                <span>{t("architecture.copyToDiagram.error", { message: copyState.message })}</span>
              </StatusBanner>
            ) : null}
            {grantedPath === selected.htmlPath ? (
              <iframe
                key={`${grantedPath}:${selected.modifiedAt ?? ""}`}
                className="architecture-frame"
                data-testid="architecture-frame"
                title={t("architecture.frameTitle", { title: selected.title })}
                sandbox={BLUEPRINT_FRAME_SANDBOX}
                referrerPolicy="no-referrer"
                src={`${assetUrlForPath(grantedPath)}?theme=${theme}`}
              />
            ) : prepareError ? (
              <StatusBanner tone="danger">
                <span>{t("architecture.error", { message: prepareError })}</span>
              </StatusBanner>
            ) : (
              <p className="architecture-list-note" role="status">{t("architecture.loading")}</p>
            )}
          </>
        ) : (
          <EmptyState icon={<DraftingCompass size={18} />} title={t("architecture.select")} />
        )}
      </div>
    </section>
  );
}

import { useSyncExternalStore } from "react";
import type { ComponentProps } from "react";

import type { CatalogPane } from "../components/catalog/CatalogPane";
import type { FilesWorkbench } from "../components/FilesWorkbench";
import type { InlineDocumentEditor } from "../components/InlineDocumentEditor";
import type { StudioMode } from "../components/studio/StudioMode";
import type { ExplorerPaneMode } from "./settings";
import {
  EMPTY_WORKSPACE_FILES_PANE_FILTERS,
  type WorkspaceFilesPaneFilters,
} from "./workspaceFileTree";

export type FilesWorkbenchModeProps = Omit<ComponentProps<typeof FilesWorkbench>, "documentEditorNode">;
export type InlineDocumentEditorModeProps = ComponentProps<typeof InlineDocumentEditor>;
export type StudioModeProps = ComponentProps<typeof StudioMode>;
export type CatalogModeProps = ComponentProps<typeof CatalogPane>;

/** A narrow mode-local bridge. Canonical workspace, draft, and settings owners stay external. */
export interface DocumentOpsModeHost {
  files?: { props: FilesWorkbenchModeProps; editor: InlineDocumentEditorModeProps | null };
  studio?: StudioModeProps;
  catalog?: CatalogModeProps;
}

export type DocumentOpsModeDomain = "files" | "studio" | "catalog" | "presentation";

export interface FilesModeSlice {
  selectedPath: string | null;
  filter: string;
  preview: { path: string; content: string } | null;
  host: DocumentOpsModeHost["files"] | null;
}

export interface StudioModeSlice {
  workspacePath: string | null;
  host: DocumentOpsModeHost["studio"] | null;
}

export interface CatalogModeSlice {
  workspacePath: string | null;
  host: DocumentOpsModeHost["catalog"] | null;
}

export interface FilesPresentationSlice {
  filters: WorkspaceFilesPaneFilters;
  pendingReveal: { pane: ExplorerPaneMode; targetPath: string } | null;
  editorErrors: Record<string, string | null>;
  saving: boolean;
  savingTabId: string | null;
}

export interface DocumentOpsModeController {
  subscribe(domain: DocumentOpsModeDomain, listener: () => void): () => void;
  getFilesSlice(): FilesModeSlice;
  getStudioSlice(): StudioModeSlice;
  getCatalogSlice(): CatalogModeSlice;
  getPresentationSlice(): FilesPresentationSlice;
  beginFilesPreview(path: string): number;
  resolveFilesPreview(request: number, preview: { path: string; content: string }): boolean;
  publishFiles(patch: Partial<FilesModeSlice>): void;
  publishStudio(patch: Partial<StudioModeSlice>): void;
  publishCatalog(patch: Partial<CatalogModeSlice>): void;
  bind(host: DocumentOpsModeHost): void;
  updatePresentation(update: (current: FilesPresentationSlice) => FilesPresentationSlice): void;
}

const EMPTY_FILES: FilesModeSlice = Object.freeze({ selectedPath: null, filter: "", preview: null, host: null });
const EMPTY_STUDIO: StudioModeSlice = Object.freeze({ workspacePath: null, host: null });
const EMPTY_CATALOG: CatalogModeSlice = Object.freeze({ workspacePath: null, host: null });
const EMPTY_PRESENTATION: FilesPresentationSlice = Object.freeze({
  filters: EMPTY_WORKSPACE_FILES_PANE_FILTERS,
  pendingReveal: null,
  editorErrors: {},
  saving: false,
  savingTabId: null,
});

/**
 * Scoped transient presentation state for document-operation modes. The controller
 * deliberately does not own drafts, capabilities, revisions, or settings: those
 * remain in editorTabsStore, workspace/document browser stores, and shell settings.
 */
export function createDocumentOpsModeController(): DocumentOpsModeController {
  const listeners: Record<DocumentOpsModeDomain, Set<() => void>> = {
    files: new Set(), studio: new Set(), catalog: new Set(), presentation: new Set(),
  };
  let files = EMPTY_FILES;
  let studio = EMPTY_STUDIO;
  let catalog = EMPTY_CATALOG;
  let presentation = EMPTY_PRESENTATION;
  let previewRequest = 0;

  const notify = (domain: DocumentOpsModeDomain) => {
    for (const listener of listeners[domain]) listener();
  };
  const publishFiles = (next: FilesModeSlice) => {
    if (files.selectedPath === next.selectedPath && files.filter === next.filter && files.preview === next.preview && files.host === next.host) return;
    files = Object.freeze(next);
    notify("files");
  };
  const publishStudio = (next: StudioModeSlice) => {
    if (studio.workspacePath === next.workspacePath && studio.host === next.host) return;
    studio = Object.freeze(next);
    notify("studio");
  };
  const publishCatalog = (next: CatalogModeSlice) => {
    if (catalog.workspacePath === next.workspacePath && catalog.host === next.host) return;
    catalog = Object.freeze(next);
    notify("catalog");
  };
  const publishPresentation = (next: FilesPresentationSlice) => {
    if (presentation === next) return;
    presentation = Object.freeze(next);
    notify("presentation");
  };

  return {
    subscribe(domain, listener) {
      listeners[domain].add(listener);
      return () => listeners[domain].delete(listener);
    },
    getFilesSlice: () => files,
    getStudioSlice: () => studio,
    getCatalogSlice: () => catalog,
    getPresentationSlice: () => presentation,
    beginFilesPreview(path) {
      previewRequest += 1;
      publishFiles({ ...files, selectedPath: path, preview: null });
      return previewRequest;
    },
    resolveFilesPreview(request, preview) {
      if (request !== previewRequest || files.selectedPath !== preview.path) return false;
      publishFiles({ ...files, preview });
      return true;
    },
    publishFiles(patch) { publishFiles({ ...files, ...patch }); },
    publishStudio(patch) { publishStudio({ ...studio, ...patch }); },
    publishCatalog(patch) { publishCatalog({ ...catalog, ...patch }); },
    bind(host) {
      publishFiles({ ...files, host: host.files ?? null });
      publishStudio({ workspacePath: host.studio?.workspaceRoot ?? null, host: host.studio ?? null });
      publishCatalog({ workspacePath: host.catalog?.workspaceRoot ?? null, host: host.catalog ?? null });
    },
    updatePresentation(update) { publishPresentation(update(presentation)); },
  };
}

export const documentOpsModeController = createDocumentOpsModeController();

function useSlice<T>(domain: DocumentOpsModeDomain, getSnapshot: () => T): T {
  return useSyncExternalStore(
    (listener) => documentOpsModeController.subscribe(domain, listener),
    getSnapshot,
    getSnapshot,
  );
}

export function useFilesModeSlice(): FilesModeSlice {
  return useSlice("files", documentOpsModeController.getFilesSlice);
}

export function useStudioModeSlice(): StudioModeSlice {
  return useSlice("studio", documentOpsModeController.getStudioSlice);
}

export function useCatalogModeSlice(): CatalogModeSlice {
  return useSlice("catalog", documentOpsModeController.getCatalogSlice);
}

export function useFilesPresentationSlice(): FilesPresentationSlice {
  return useSlice("presentation", documentOpsModeController.getPresentationSlice);
}

import type { EditorPaneViewModes, MaruSettings, RightPaneTab } from "./settings";
import {
  cleanupEditorPaneWorkspace,
  setEditorPaneViewModes as publishEditorPaneViewModes,
} from "./editorPaneStore";
import {
  cleanupOutlinePaneWorkspace,
  setOutlineRightPaneTab,
  type OutlinePaneScope,
} from "./outlinePaneStore";

export interface EditorSurfaceIdentity {
  workspacePath: string;
  requestId: number;
}

export interface EditorSurfacePersistenceOptions {
  currentWorkspacePath: () => string | null;
  currentRequestId: () => number;
  setEditorPaneViewModes?: (modes: EditorPaneViewModes) => void;
  setRightPaneTab?: (tab: RightPaneTab) => void;
  scheduleSettings: (updater: (current: MaruSettings) => MaruSettings) => void;
  publishEditorPaneViewModes?: (workspacePath: string, modes: EditorPaneViewModes) => void;
  publish?: (scope: OutlinePaneScope, tab: RightPaneTab) => void;
  cleanupWorkspace?: (workspacePath: string) => void;
}

function defaultPublish(scope: OutlinePaneScope, tab: RightPaneTab): void {
  setOutlineRightPaneTab(scope, tab);
}

/**
 * Guarded bridge between existing Maru settings and facade-local render
 * state. It deliberately consumes App's loadWorkspace request id rather than
 * introducing another generation counter.
 */
export function createEditorSurfacePersistence(options: EditorSurfacePersistenceOptions) {
  const publish = options.publish ?? defaultPublish;
  const cleanupWorkspace = options.cleanupWorkspace ?? cleanupOutlinePaneWorkspace;
  const publishModes = options.publishEditorPaneViewModes ?? publishEditorPaneViewModes;

  return {
    async hydrate(
      identity: EditorSurfaceIdentity,
      persistedTab: RightPaneTab | Promise<RightPaneTab>,
    ): Promise<boolean> {
      const tab = await persistedTab;
      if (
        options.currentWorkspacePath() !== identity.workspacePath ||
        options.currentRequestId() !== identity.requestId
      ) {
        return false;
      }
      publish({ workspacePath: identity.workspacePath }, tab);
      options.setRightPaneTab?.(tab);
      return true;
    },

    setRightPaneTab(tab: RightPaneTab): void {
      options.setRightPaneTab?.(tab);
      options.scheduleSettings((current) => ({
        ...current,
        ui: { ...current.ui, rightPaneTab: tab },
      }));
    },

    async hydrateEditorPaneViewModes(
      identity: EditorSurfaceIdentity,
      persistedModes: EditorPaneViewModes | Promise<EditorPaneViewModes>,
    ): Promise<boolean> {
      const modes = await persistedModes;
      if (
        options.currentWorkspacePath() !== identity.workspacePath ||
        options.currentRequestId() !== identity.requestId
      ) {
        return false;
      }
      publishModes(identity.workspacePath, modes);
      options.setEditorPaneViewModes?.(modes);
      return true;
    },

    setEditorPaneViewModes(workspacePath: string | null, modes: EditorPaneViewModes): void {
      if (workspacePath) publishModes(workspacePath, modes);
      options.setEditorPaneViewModes?.(modes);
      options.scheduleSettings((current) => ({
        ...current,
        ui: {
          ...current.ui,
          editorViewMode: modes.left,
          editorPaneViewModes: modes,
        },
      }));
    },

    cleanupWorkspace(workspacePath: string): void {
      cleanupWorkspace(workspacePath);
      cleanupEditorPaneWorkspace(workspacePath);
    },
  };
}

export async function hydrateEditorSurfaces(
  persistence: ReturnType<typeof createEditorSurfacePersistence>,
  identity: EditorSurfaceIdentity,
  persistedTab: RightPaneTab | Promise<RightPaneTab>,
): Promise<boolean> {
  return persistence.hydrate(identity, persistedTab);
}

export async function hydrateEditorPaneViewModes(
  persistence: ReturnType<typeof createEditorSurfacePersistence>,
  identity: EditorSurfaceIdentity,
  persistedModes: EditorPaneViewModes | Promise<EditorPaneViewModes>,
): Promise<boolean> {
  return persistence.hydrateEditorPaneViewModes(identity, persistedModes);
}

export function cleanupEditorSurfaceWorkspace(
  persistence: ReturnType<typeof createEditorSurfacePersistence>,
  workspacePath: string,
): void {
  persistence.cleanupWorkspace(workspacePath);
}

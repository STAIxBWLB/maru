import type { MaruSettings, RightPaneTab } from "./settings";
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
  setRightPaneTab?: (tab: RightPaneTab) => void;
  scheduleSettings: (updater: (current: MaruSettings) => MaruSettings) => void;
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

    cleanupWorkspace(workspacePath: string): void {
      cleanupWorkspace(workspacePath);
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

export function cleanupEditorSurfaceWorkspace(
  persistence: ReturnType<typeof createEditorSurfacePersistence>,
  workspacePath: string,
): void {
  persistence.cleanupWorkspace(workspacePath);
}

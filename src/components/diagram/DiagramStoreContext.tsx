import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { defaultCoalescer } from "../../lib/diagram/actions";
import { createDiagramStore, type DiagramStore } from "../../lib/diagram/state";
import { type DiagramStateRoot } from "../../lib/diagram/types";
import { type Coalescer } from "../../lib/diagram/history";

interface DiagramStoreContextValue {
  store: DiagramStore;
  coalescer: Coalescer;
}

const Ctx = createContext<DiagramStoreContextValue | null>(null);

// ---------------------------------------------------------------------------
// Workspace-keyed module state.
//
// `DiagramMode` is mounted and unmounted whenever the user clicks an activity-
// rail icon. Keeping the store at module scope preserves in-flight work across
// those remounts, but a single global store leaks unsaved diagrams between
// workspaces. Keying the store/session by workspace path keeps the persistence
// benefit while making workspace switches isolated.
// ---------------------------------------------------------------------------

interface WorkspaceDiagramContext {
  store: DiagramStore;
  coalescer: Coalescer;
  session: DiagramSession;
}

const DEFAULT_STORE_KEY = "__anchor-diagram-default__";
const contexts = new Map<string, WorkspaceDiagramContext>();

function normalizeStoreKey(key?: string | null): string {
  return key?.trim() || DEFAULT_STORE_KEY;
}

function getWorkspaceContext(key?: string | null): WorkspaceDiagramContext {
  const normalized = normalizeStoreKey(key);
  let ctx = contexts.get(normalized);
  if (!ctx) {
    ctx = {
      store: createDiagramStore(),
      coalescer: defaultCoalescer(),
      session: {
        activeName: null,
        lastSavedBody: null,
      },
    };
    contexts.set(normalized, ctx);
  }
  return ctx;
}

/** Test-only escape hatch — drop all workspace stores so each unit test starts fresh. */
export function _resetDiagramSharedStoreForTests(): void {
  contexts.clear();
}

export interface DiagramStoreProviderProps {
  initial?: Partial<DiagramStateRoot>;
  storeKey?: string | null;
  children: ReactNode;
}

export function DiagramStoreProvider({ initial, storeKey, children }: DiagramStoreProviderProps) {
  // First-time hydration only — if a caller passes `initial` and the shared
  // store is still pristine (empty doc, untouched ephemeral), apply it.
  // Subsequent mounts ignore `initial` so we don't clobber in-flight work.
  const value = useMemo(() => {
    const ctx = getWorkspaceContext(storeKey);
    const store = ctx.store;
    if (initial && store.getState().doc.nodes.length === 0 && store.getState().doc.edges.length === 0) {
      store.setState((current) => ({
        doc: initial.doc ?? current.doc,
        ephemeral: initial.ephemeral ?? current.ephemeral,
      }));
    }
    return { store, coalescer: ctx.coalescer };
  }, [initial, storeKey]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDiagramStore(): DiagramStore {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useDiagramStore must be used inside <DiagramStoreProvider>");
  return ctx.store;
}

export function useDiagramCoalescer(): Coalescer {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useDiagramCoalescer must be used inside <DiagramStoreProvider>");
  return ctx.coalescer;
}

/**
 * Subscribe to a slice of the diagram store. Re-renders only when the
 * selected value changes (Object.is by default).
 */
export function useDiagram<T>(selector: (state: DiagramStateRoot) => T): T {
  const store = useDiagramStore();
  const getSnapshot = useCallback(() => selector(store.getState()), [store, selector]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

// ---------------------------------------------------------------------------
// Session-only DiagramMode shell state.
//
// The store handles `doc` + `ephemeral`. The DiagramShell carries additional
// per-mount state — currently-open filename, last-saved body hash — that also
// must survive activity-rail switches. We keep them in a tiny module-level
// object that `useDiagramSession` reads/writes via React state with manual
// sync.
// ---------------------------------------------------------------------------

export interface DiagramSession {
  activeName: string | null;
  lastSavedBody: string | null;
}

export function getDiagramSession(storeKey?: string | null): DiagramSession {
  return getWorkspaceContext(storeKey).session;
}

export function setDiagramSession(
  patch: Partial<DiagramSession>,
  storeKey?: string | null,
): void {
  const session = getWorkspaceContext(storeKey).session;
  if (patch.activeName !== undefined) session.activeName = patch.activeName;
  if (patch.lastSavedBody !== undefined) session.lastSavedBody = patch.lastSavedBody;
}

export function _resetDiagramSessionForTests(): void {
  for (const ctx of contexts.values()) {
    ctx.session.activeName = null;
    ctx.session.lastSavedBody = null;
  }
}

/** Mounted binary editors keep their bytes local and register navigation decisions. */
interface HwpxEditorGuard {
  beforeLeave: () => Promise<boolean>;
  hasChanges: () => boolean;
  ownsFocus: () => boolean;
  save: () => Promise<boolean>;
  setNavigationBusy?: (busy: boolean) => void;
}
const guards = new Set<HwpxEditorGuard>();
const activeNavigationLocks = new Set<Set<HwpxEditorGuard>>();
const navigationLocks = new WeakMap<HwpxEditorGuard, number>();
function addNavigationLock(guard: HwpxEditorGuard): void {
  navigationLocks.set(guard, (navigationLocks.get(guard) ?? 0) + 1);
  guard.setNavigationBusy?.(true);
}
let pending: Promise<boolean> | null = null;
let navigationDepth = 0;

function withinNavigation<T>(action: () => T): T {
  navigationDepth += 1;
  try { return action(); } finally { navigationDepth -= 1; }
}

export function registerHwpxEditorGuard(guard: HwpxEditorGuard): () => void {
  guards.add(guard);
  // A close/async switch also freezes editors mounted after it started.
  for (const locked of activeNavigationLocks) {
    locked.add(guard);
    addNavigationLock(guard);
  }
  return () => { guards.delete(guard); };
}

/** The menu Save command uses the focused binary editor, including refusals. */
export async function saveFocusedHwpxEditor(): Promise<boolean> {
  for (const guard of guards) {
    if (!guard.ownsFocus()) continue;
    await guard.save();
    return true;
  }
  return false;
}

export function hasHwpxEditorChanges(): boolean {
  return navigationDepth === 0 && Array.from(guards).some((guard) => guard.hasChanges());
}

export function requestHwpxEditorNavigation(): Promise<boolean> {
  if (navigationDepth > 0) return Promise.resolve(true);
  if (pending) return Promise.resolve(false);
  pending = (async () => {
    for (const guard of guards) if (!(await guard.beforeLeave())) return false;
    return true;
  })().finally(() => { pending = null; });
  return pending;
}

/** Keep synchronous navigation synchronous when no binary editor needs a decision. */
export function guardHwpxEditorNavigation(action: () => void): void {
  if (!hasHwpxEditorChanges()) { withinNavigation(action); return; }
  void requestHwpxEditorNavigation().then((accepted) => { if (accepted) withinNavigation(action); });
}

/** Share a confirmed decision through the synchronous start of an async action.
 * The scope ends before its promise settles, so unrelated later clicks still ask. */
export async function guardHwpxEditorNavigationAsync<T>(action: () => T | Promise<T>): Promise<T | undefined> {
  if (hasHwpxEditorChanges() && !(await requestHwpxEditorNavigation())) return undefined;
  return withinNavigation(action);
}

/** Freeze the outgoing editor while an already-approved async switch reads disk. */
export function lockHwpxEditorNavigation(): () => void {
  const locked = new Set(guards);
  activeNavigationLocks.add(locked);
  for (const guard of locked) addNavigationLock(guard);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeNavigationLocks.delete(locked);
    for (const guard of locked) {
      const remaining = Math.max(0, (navigationLocks.get(guard) ?? 1) - 1);
      navigationLocks.set(guard, remaining);
      if (remaining === 0) guard.setNavigationBusy?.(false);
    }
  };
}

import { afterEach, describe, expect, it, vi } from "vitest";
import { lockHwpxEditorNavigation, guardHwpxEditorNavigationAsync, guardHwpxEditorNavigation, hasHwpxEditorChanges, registerHwpxEditorGuard, requestHwpxEditorNavigation, saveFocusedHwpxEditor } from "./hwpxEditorGuard";
const unregister: Array<() => void> = [];
afterEach(() => { unregister.splice(0).forEach((remove) => remove()); });
function register(overrides: Partial<Parameters<typeof registerHwpxEditorGuard>[0]> = {}) {
  const guard = { beforeLeave: vi.fn(async () => true), hasChanges: () => true, ownsFocus: () => false, save: vi.fn(async () => false), ...overrides };
  unregister.push(registerHwpxEditorGuard(guard)); return guard;
}
describe("HWPX navigation and menu Save ownership", () => {
  it("keeps ordinary navigation synchronous when no editor has changes", () => {
    register({ hasChanges: () => false }); const action = vi.fn(); guardHwpxEditorNavigation(action); expect(action).toHaveBeenCalledOnce();
  });
  it("does not navigate or close after discard is cancelled", async () => {
    const guard = register({ beforeLeave: vi.fn(async () => false) }); const action = vi.fn(); guardHwpxEditorNavigation(action);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(guard.beforeLeave).toHaveBeenCalledOnce(); expect(action).not.toHaveBeenCalled(); expect(hasHwpxEditorChanges()).toBe(true);
  });
  it("one confirmation cannot approve two competing file switches", async () => {
    let answer!: (value: boolean) => void; register({ beforeLeave: () => new Promise((resolve) => { answer = resolve; }) });
    const first = requestHwpxEditorNavigation(); const second = requestHwpxEditorNavigation(); expect(await second).toBe(false); answer(true); expect(await first).toBe(true);
  });
  it("one approved action shares its decision with nested mode and file selection", async () => {
    const guard = register(); const selected = vi.fn();
    await guardHwpxEditorNavigationAsync(() => {
      guardHwpxEditorNavigation(selected);
      expect(hasHwpxEditorChanges()).toBe(false);
    });
    expect(guard.beforeLeave).toHaveBeenCalledOnce(); expect(selected).toHaveBeenCalledOnce();
    expect(hasHwpxEditorChanges()).toBe(true);
  });
  it("an async action does not suppress guards while awaiting disk reads", async () => {
    const guard = register(); let finish!: () => void; let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const navigating = guardHwpxEditorNavigationAsync(() => new Promise<void>((resolve) => { finish = resolve; signalStarted(); }));
    await started;
    expect(hasHwpxEditorChanges()).toBe(true); expect(guard.beforeLeave).toHaveBeenCalledOnce();
    finish(); await navigating;
  });
  it("focused HWPX consumes menu Save even when pending ops refuse saving", async () => {
    const guard = register({ ownsFocus: () => true }); expect(await saveFocusedHwpxEditor()).toBe(true); expect(guard.save).toHaveBeenCalledOnce();
  });
  it("keeps outgoing editors frozen until all approved disk transitions finish", () => {
    const setBusy = vi.fn(); register({ setNavigationBusy: setBusy });
    const releaseFirst = lockHwpxEditorNavigation(); const releaseSecond = lockHwpxEditorNavigation();
    releaseFirst(); expect(setBusy).not.toHaveBeenCalledWith(false);
    releaseSecond(); expect(setBusy).toHaveBeenLastCalledWith(false);
  });
  it("does not steal another pane's Save command", async () => {
    const guard = register(); expect(await saveFocusedHwpxEditor()).toBe(false); expect(guard.save).not.toHaveBeenCalled();
  });
});

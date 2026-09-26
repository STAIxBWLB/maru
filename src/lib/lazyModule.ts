/**
 * Memoizes a dynamic `import()` so concurrent callers share one in-flight
 * promise instead of each issuing an independent `import()` call for the
 * same specifier.
 *
 * Why this matters here: a component with several effects that each
 * independently `import()` the same Tauri module (all firing in the same
 * React commit, so their calls overlap before any of them has resolved)
 * can trigger a dev/test module-loader quirk in some Vite/Vitest versions,
 * where only the first of several concurrent, not-yet-resolved dynamic
 * imports of one specifier is routed through `vi.mock`'s interception; any
 * later concurrent call for the same specifier resolves the real module
 * instead. This is a test-harness artifact, not a defect in normal ES
 * module semantics (real browsers always cache by specifier), but
 * memoizing the import at the call site sidesteps it — and is also
 * strictly cheaper at runtime regardless of test concerns, since the
 * module is only ever actually requested once.
 */
export function lazyImport<T>(load: () => Promise<T>): () => Promise<T> {
  let cached: Promise<T> | null = null;
  return () => {
    if (!cached) cached = load();
    return cached;
  };
}

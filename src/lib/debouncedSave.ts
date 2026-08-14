export interface DebouncedSaver<T> {
  schedule(value: T): void;
  flush(): Promise<void>;
  cancel(): void;
}

export interface SaveQueue {
  enqueue(task: () => Promise<void> | void): Promise<void>;
  whenIdle(): Promise<void>;
}

/**
 * A small shared tail used when independent saver instances must still
 * serialize the side effect they ultimately perform.
 */
export function createSaveQueue(): SaveQueue {
  let tail: Promise<void> = Promise.resolve();
  return {
    enqueue(task) {
      const next = tail.then(() => task());
      // A failed task must not poison the queue for later callers. The
      // returned promise still reports the failure to its caller.
      tail = next.catch(() => undefined);
      return next;
    },
    whenIdle() {
      return tail;
    },
  };
}

export interface ContextualDebouncedSaver<T, C> extends DebouncedSaver<T> {
  schedule(value: T, context?: C): void;
}

type PendingContextualSave<T, C> = {
  value: T;
  context: C;
};

function reportSaveError(onError: ((error: unknown) => void) | undefined, error: unknown) {
  try {
    onError?.(error);
  } catch {
    // Error reporting must not poison the save queue.
  }
}

export function createDebouncedSaver<T>(
  save: (value: T) => Promise<void> | void,
  delayMs: number,
  onError?: (error: unknown) => void,
): DebouncedSaver<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: T | null = null;
  let hasPending = false;
  const queue = createSaveQueue();
  let inFlight: Promise<void> = Promise.resolve();

  const drain = () => {
    if (!hasPending) return;
    const value = pending as T;
    pending = null;
    hasPending = false;
    inFlight = queue.enqueue(() => save(value)).catch((error) => {
      reportSaveError(onError, error);
    });
  };

  const run = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    drain();
    return inFlight;
  };

  return {
    schedule(value: T) {
      pending = value;
      hasPending = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, delayMs);
    },
    flush() {
      return run();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
      hasPending = false;
    },
  };
}

/**
 * Debounced saver whose latest value is coalesced while the first schedule's
 * context is retained. The context is therefore a schedule-time snapshot of
 * metadata such as workPath/base, not a mutable ref read when the timer fires.
 * A shared SaveQueue serializes the actual side effect across saver instances.
 */
export function createContextualDebouncedSaver<T, C>(
  save: (value: T, context: C) => Promise<void> | void,
  delayMs: number,
  onError?: (error: unknown) => void,
  queue: SaveQueue = createSaveQueue(),
): ContextualDebouncedSaver<T, C> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: PendingContextualSave<T, C> | null = null;
  let inFlight: Promise<void> = Promise.resolve();
  let lastContext: C | undefined;
  let hasLastContext = false;

  const drain = () => {
    if (!pending) return;
    const request = pending;
    pending = null;
    // Register with the shared queue synchronously. The queue itself owns
    // cross-saver ordering; deferring enqueue behind this saver's inFlight
    // promise would leave a replacement saver unable to observe this task.
    inFlight = queue.enqueue(() => save(request.value, request.context)).catch((error) => {
      reportSaveError(onError, error);
    });
  };

  const run = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    drain();
    return inFlight;
  };

  const saver: ContextualDebouncedSaver<T, C> = {
    schedule(value: T, context?: C) {
      if (context !== undefined) {
        lastContext = context;
        hasLastContext = true;
      } else if (!hasLastContext) {
        return;
      }
      const nextContext = context ?? lastContext;
      if (nextContext === undefined) return;
      // Keep the first context for a coalesced burst, while always replacing
      // its value with the latest settings snapshot.
      pending = pending
        ? { value, context: pending.context }
        : { value, context: nextContext };
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, delayMs);
    },
    flush() {
      const ownWork = run();
      return Promise.all([ownWork, queue.whenIdle()]).then(() => undefined);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };

  return saver;
}

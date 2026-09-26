export interface DebouncedSaver<T> {
  schedule(value: T): void;
  flush(): Promise<void>;
  cancel(): void;
}

/** The outcome of settling a debounced saver's pending/in-flight work. */
export type SaveSettlement<T> =
  | { status: "clean" }
  | { status: "saved" }
  | { status: "failed"; value: T; error: unknown };

export interface SettlingDebouncedSaver<T> extends DebouncedSaver<T> {
  /** Like flush(), but reports what actually happened instead of always
   * resolving silently. Used by teardown paths (unmount, quit) that need to
   * tell a clean exit apart from a failed one. */
  flushSettled(): Promise<SaveSettlement<T>>;
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
): SettlingDebouncedSaver<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: T | null = null;
  let hasPending = false;
  const queue = createSaveQueue();
  let inFlight: Promise<void> = Promise.resolve();
  // Tracks the most recently started drain's settlement so a flushSettled()
  // call that finds nothing newly pending can still await an already
  // in-flight save instead of reporting a false "clean".
  let activeSettlement: Promise<SaveSettlement<T>> | null = null;
  // A monotonically increasing stamp assigned to every drained value. A
  // failed save's catch handler must only resurrect its own value as
  // pending when this is still the most recently drained attempt. A value
  // that was merely *scheduled* (never drained) is already caught by
  // `!hasPending`, but a value that was scheduled AND drained behind this
  // one — queued in the shared save queue while this save was still in
  // flight — clears `hasPending` back to false without becoming "the
  // failed value" itself. Without this stamp, that already-drained newer
  // value would be silently clobbered by the older failure being retried
  // on the next flush (e.g. at unmount/quit teardown).
  let nextDrainSeq = 0;
  let latestDrainSeq = 0;

  const drainSettled = (): Promise<SaveSettlement<T>> => {
    if (!hasPending) {
      return activeSettlement ?? Promise.resolve<SaveSettlement<T>>({ status: "clean" });
    }
    const value = pending as T;
    const seq = ++nextDrainSeq;
    latestDrainSeq = seq;
    pending = null;
    hasPending = false;
    const settlement: Promise<SaveSettlement<T>> = queue
      .enqueue(() => save(value))
      .then((): SaveSettlement<T> => ({ status: "saved" }))
      .catch((error): SaveSettlement<T> => {
        reportSaveError(onError, error);
        // Retry only the value that just failed — unless a newer drain has
        // started since (this drain is no longer the latest) or a newer
        // value is already waiting in the schedule slot. Never re-arm the
        // timer here: retries only happen via an explicit schedule()/
        // flush(), so a broken disk cannot spin on its own.
        if (!hasPending && seq === latestDrainSeq) {
          pending = value;
          hasPending = true;
        }
        return { status: "failed", value, error };
      });
    activeSettlement = settlement;
    inFlight = settlement.then(() => undefined);
    void settlement.finally(() => {
      if (activeSettlement === settlement) activeSettlement = null;
    });
    return settlement;
  };

  const run = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    void drainSettled();
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
    flushSettled() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      return drainSettled();
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

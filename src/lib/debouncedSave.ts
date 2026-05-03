export interface DebouncedSaver<T> {
  schedule(value: T): void;
  flush(): Promise<void>;
  cancel(): void;
}

export function createDebouncedSaver<T>(
  save: (value: T) => Promise<void> | void,
  delayMs: number,
  onError?: (error: unknown) => void,
): DebouncedSaver<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: T | null = null;
  let hasPending = false;
  let inFlight: Promise<void> = Promise.resolve();

  const run = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!hasPending) return inFlight;
    const value = pending as T;
    pending = null;
    hasPending = false;
    inFlight = Promise.resolve()
      .then(() => save(value))
      .catch((error) => {
        onError?.(error);
      });
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

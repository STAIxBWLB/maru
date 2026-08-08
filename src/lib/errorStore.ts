import { useSyncExternalStore } from "react";

// ---------------------------------------------------------------------------
// Global error toast state (extracted from MainApp in step 9). One module
// slot + the same useSyncExternalStore pattern as the other stores, so any
// component can raise or clear the toast without an onError prop drill.
// ---------------------------------------------------------------------------

export type ErrorValue = string | null;

/** setError accepts the same shapes as a React state setter: a plain value
 *  or an updater computed from the current value (used by the inbox config
 *  error reporter to clear only its own message). */
export function resolveErrorValue(
  current: ErrorValue,
  value: ErrorValue | ((current: ErrorValue) => ErrorValue),
): ErrorValue {
  return typeof value === "function" ? value(current) : value;
}

let errorValue: ErrorValue = null;
const subscribers = new Set<() => void>();

function publish(next: ErrorValue): void {
  if (next === errorValue) return;
  errorValue = next;
  for (const subscriber of subscribers) subscriber();
}

export function setError(value: ErrorValue | ((current: ErrorValue) => ErrorValue)): void {
  publish(resolveErrorValue(errorValue, value));
}

export function clearError(): void {
  publish(null);
}

function subscribe(subscriber: () => void): () => void {
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}

export function useError(): ErrorValue {
  return useSyncExternalStore(
    subscribe,
    () => errorValue,
    () => errorValue,
  );
}

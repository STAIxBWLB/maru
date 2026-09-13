import { useSyncExternalStore } from "react";

const requests = new Map<string, string>();
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** Pass an imported session between the skill dialog, note details and Meetings. */
export function requestMeetingSourceSession(workPath: string, sessionId: string): void {
  requests.set(workPath, sessionId);
  listeners.forEach((listener) => listener());
}

export function useRequestedMeetingSourceSession(workPath: string | null): string | null {
  return useSyncExternalStore(subscribe, () => workPath ? requests.get(workPath) ?? null : null, () => null);
}

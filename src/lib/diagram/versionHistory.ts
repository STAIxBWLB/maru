/**
 * Version-history helpers — auto-snapshot scheduling + Tauri bridge.
 *
 * Snapshots live at `<workspace>/.anchor/diagrams/history/<docId>/snapshot-<ts>.json`
 * (Rust side caps the ring at 20). This module is the React-facing front:
 * - `formatSnapshotTs` produces the filesystem-safe ISO compact stamp.
 * - `createAutoSnapshotScheduler` returns a tiny controller you can start/stop
 *   from a `useEffect`. It fires the callback after `intervalMs` of idle
 *   *plus* a debounce of `quietMs` so a flurry of edits collapses into one save.
 */

import {
  diagramListSnapshots,
  diagramRestoreSnapshot,
  diagramSaveSnapshot,
  type DiagramSnapshotMeta,
} from "../diagram";
import { serializeDoc } from "./persistence";
import type { DiagramDoc } from "./types";

export const DEFAULT_AUTO_SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000;
export const DEFAULT_QUIET_MS = 2_500;

export function formatSnapshotTs(date: Date = new Date()): string {
  const iso = date.toISOString(); // "2026-05-26T20:49:00.000Z"
  return iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

export interface AutoSnapshotScheduler {
  /** Mark the doc dirty; restarts the quiet timer. */
  markDirty(): void;
  /** Mark clean (e.g. after manual save) — cancels pending snapshot. */
  markClean(): void;
  /** Tear down all timers. */
  dispose(): void;
}

export interface AutoSnapshotInput {
  enabled: boolean;
  intervalMs?: number;
  quietMs?: number;
  /** Returns the latest doc — invoked at fire time. */
  getDoc: () => DiagramDoc | null;
  onFire: (content: string, doc: DiagramDoc) => void | Promise<void>;
}

export function createAutoSnapshotScheduler(input: AutoSnapshotInput): AutoSnapshotScheduler {
  const intervalMs = input.intervalMs ?? DEFAULT_AUTO_SNAPSHOT_INTERVAL_MS;
  const quietMs = input.quietMs ?? DEFAULT_QUIET_MS;
  let dirty = false;
  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  let quietHandle: ReturnType<typeof setTimeout> | null = null;

  function fire() {
    if (!dirty || !input.enabled) return;
    const doc = input.getDoc();
    if (!doc) return;
    dirty = false;
    if (quietHandle) {
      clearTimeout(quietHandle);
      quietHandle = null;
    }
    void input.onFire(serializeDoc(doc), doc);
  }

  function startInterval() {
    if (intervalHandle || !input.enabled) return;
    intervalHandle = setInterval(fire, intervalMs);
  }

  startInterval();

  return {
    markDirty() {
      dirty = true;
      if (!input.enabled) return;
      startInterval();
      if (quietHandle) clearTimeout(quietHandle);
      quietHandle = setTimeout(fire, quietMs + intervalMs);
    },
    markClean() {
      dirty = false;
      if (quietHandle) {
        clearTimeout(quietHandle);
        quietHandle = null;
      }
    },
    dispose() {
      if (intervalHandle) clearInterval(intervalHandle);
      if (quietHandle) clearTimeout(quietHandle);
      intervalHandle = null;
      quietHandle = null;
    },
  };
}

export async function saveSnapshotForDoc(
  workspace: string,
  doc: DiagramDoc,
): Promise<DiagramSnapshotMeta> {
  const ts = formatSnapshotTs();
  return diagramSaveSnapshot(workspace, doc.id, ts, serializeDoc(doc));
}

export async function listSnapshotsForDoc(
  workspace: string,
  doc: DiagramDoc,
): Promise<DiagramSnapshotMeta[]> {
  return diagramListSnapshots(workspace, doc.id);
}

export async function restoreSnapshotForDoc(
  workspace: string,
  doc: DiagramDoc,
  snapshotTs: string,
): Promise<string> {
  return diagramRestoreSnapshot(workspace, doc.id, snapshotTs);
}

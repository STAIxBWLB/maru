import { relaunch } from "@tauri-apps/plugin-process";
import { check, type DownloadEvent, type Update } from "@tauri-apps/plugin-updater";

export const CHECK_FOR_UPDATES_MENU_EVENT = "anchor://check-for-updates";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

export interface AppUpdateInfo {
  version: string;
  currentVersion: string;
  date: string | null;
  body: string | null;
}

export interface AppUpdateCheckResult {
  update: Update;
  info: AppUpdateInfo;
}

export interface AppUpdateProgress {
  downloadedBytes: number;
  contentLength: number | null;
  percent: number | null;
  finished: boolean;
}

export function updaterAvailable(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

export async function checkAppUpdate(): Promise<AppUpdateCheckResult | null> {
  if (!updaterAvailable()) return null;
  const update = await check();
  if (!update) return null;
  return {
    update,
    info: {
      version: update.version,
      currentVersion: update.currentVersion,
      date: update.date ?? null,
      body: update.body ?? null,
    },
  };
}

export async function installAppUpdate(
  update: Update,
  onProgress: (progress: AppUpdateProgress) => void,
): Promise<void> {
  let downloadedBytes = 0;
  let contentLength: number | null = null;
  await update.downloadAndInstall((event: DownloadEvent) => {
    switch (event.event) {
      case "Started":
        downloadedBytes = 0;
        contentLength = event.data.contentLength ?? null;
        break;
      case "Progress":
        downloadedBytes += event.data.chunkLength;
        break;
      case "Finished":
        break;
    }
    onProgress({
      downloadedBytes,
      contentLength,
      percent:
        contentLength && contentLength > 0
          ? Math.min(100, Math.round((downloadedBytes / contentLength) * 100))
          : null,
      finished: event.event === "Finished",
    });
  });
}

export async function relaunchApp(): Promise<void> {
  await relaunch();
}

export async function listenForCheckUpdatesMenu(
  handler: () => void,
): Promise<() => void> {
  if (!updaterAvailable()) return () => {};
  const { listen } = await import("@tauri-apps/api/event");
  return listen(CHECK_FOR_UPDATES_MENU_EVENT, handler);
}

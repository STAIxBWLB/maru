import { useEffect, type MutableRefObject } from "react";

import { addWorkspaceRoot, getSampleWorkspacePath, listWorkspaceRoots } from "./api";
import { readMaruSettings } from "./maruDir";
import { planningModeController } from "./planningModeStore";
import { MaruAppMode, MaruSettings } from "./settings";
import { updateShellSettings } from "./shellSettingsStore";
import { markStartup, measureStartup } from "./startupProfile";
import { bootAppMode } from "./startupAppMode";
import { todayLogicalDay, todayOpen, todayRollover } from "./today";
import { resolveLaunchRoute, todayAutoOpenKey } from "./todayRouting";
import type { WorkspaceRegistry, WorkspaceVisibility } from "./types";
import { activateWorkspace, setWorkspaceRegistry } from "./workspaceStore";

function visibilityAvailable(registry: WorkspaceRegistry, visibility: WorkspaceVisibility): boolean {
  return Boolean(
    registry.activeByVisibility[visibility] ??
      registry.workspaces.find((workspace) => workspace.visibility === visibility),
  );
}

function startupSettingsPath(registry: WorkspaceRegistry): string | null {
  return (
    registry.activeByVisibility.private ??
    registry.workspaces.find((workspace) => workspace.visibility === "private")?.path ??
    registry.activeByVisibility.public ??
    registry.workspaces.find((workspace) => workspace.visibility === "public")?.path ??
    null
  );
}

function initialStartupVisibility(
  registry: WorkspaceRegistry,
  settings: MaruSettings | null,
): WorkspaceVisibility {
  const preferred = settings?.ui.activeWorkspaceVisibility;
  if (preferred && visibilityAvailable(registry, preferred)) return preferred;
  return registry.activeByVisibility.private || registry.workspaces.some((workspace) => workspace.visibility === "private")
    ? "private"
    : "public";
}

interface WorkspaceBootLifecycleOptions {
  settingsOverlayOpen: boolean;
  browserPasskeyBuildRef: MutableRefObject<boolean>;
  todayAutoOpenPathRef: MutableRefObject<string | null>;
  todayAutoOpenModeRef: MutableRefObject<MaruAppMode | null>;
  lastOpenKey(workspacePath: string): string;
  loadWorkspace(workspacePath: string, visibility: WorkspaceVisibility, lastRelPath?: string | null): Promise<void>;
  setBooting(booting: boolean): void;
  setAppMode(mode: MaruAppMode): void;
  setEditorPaneViewModes(modes: MaruSettings["ui"]["editorPaneViewModes"]): void;
  setRightPaneTab(tab: MaruSettings["ui"]["rightPaneTab"]): void;
  setError(message: string): void;
}

/**
 * Owns the one-time workspace bootstrap: canonical registry activation,
 * retained settings hydration, optional Today routing, and generation-bearing
 * workspace loading. App supplies only stable shell ports and keeps no boot
 * lifecycle effect of its own.
 */
export function useWorkspaceBootLifecycle({
  settingsOverlayOpen,
  browserPasskeyBuildRef,
  todayAutoOpenPathRef,
  todayAutoOpenModeRef,
  lastOpenKey,
  loadWorkspace,
  setBooting,
  setAppMode,
  setEditorPaneViewModes,
  setRightPaneTab,
  setError,
}: WorkspaceBootLifecycleOptions): void {
  useEffect(() => {
    async function boot() {
      try {
        markStartup("boot:start");
        setBooting(true);
        const registry = await measureStartup("workspace:registry-read", () => listWorkspaceRoots());
        if (registry.workspaces.length === 0) {
          const samplePath = await getSampleWorkspacePath();
          const seeded = await addWorkspaceRoot({
            label: "Sample Workspace",
            path: samplePath,
            visibility: "private",
            provider: "local",
            providerId: null,
            externalWriter: null,
            writePolicy: "direct",
            permissionSummary: null,
          });
          setWorkspaceRegistry(seeded);
          if (seeded.activeByVisibility.private) {
            activateWorkspace(seeded, "private");
            await loadWorkspace(seeded.activeByVisibility.private, "private");
            setBooting(false);
            markStartup("boot:end", { initialPath: seeded.activeByVisibility.private, initialVisibility: "private", seeded: true });
          } else {
            setBooting(false);
            markStartup("boot:end", { initialPath: null, seeded: true });
          }
          return;
        }

        setWorkspaceRegistry(registry);
        let bootSettings: MaruSettings | null = null;
        const settingsPath = startupSettingsPath(registry);
        if (settingsPath) {
          try {
            bootSettings = await measureStartup("settings:startup-read", () => readMaruSettings(settingsPath));
            updateShellSettings(bootSettings);
            if (todayAutoOpenPathRef.current === null) {
              setAppMode(bootAppMode({
                storedMode: bootSettings.ui.activeAppMode,
                browserPasskeyBuild: browserPasskeyBuildRef.current,
              }));
            }
            setEditorPaneViewModes(bootSettings.ui.editorPaneViewModes);
            setRightPaneTab(bootSettings.ui.rightPaneTab);
          } catch {
            bootSettings = null;
          }
        }

        const initialVisibility = initialStartupVisibility(registry, bootSettings);
        activateWorkspace(registry, initialVisibility);
        const initialPath = registry.activeByVisibility[initialVisibility] ??
          registry.workspaces.find((workspace) => workspace.visibility === initialVisibility)?.path ?? null;
        if (!initialPath) {
          setBooting(false);
          markStartup("boot:end", { initialPath: null, initialVisibility });
          return;
        }

        const todaySettings = bootSettings?.tasks.today;
        if (settingsOverlayOpen === false && todaySettings?.enabled && todaySettings.autoOpenFirstDailyLaunch) {
          try {
            const tasksSettings = bootSettings!.tasks;
            const timezone = tasksSettings.timezone ?? "Asia/Seoul";
            const nowIso = new Date().toISOString();
            const info = await todayLogicalDay(initialPath, nowIso, timezone, todaySettings.dayStart);
            planningModeController.setLogicalDay(info.logicalDay);
            const lastAutoOpenDay = window.localStorage.getItem(todayAutoOpenKey(initialPath));
            if (lastAutoOpenDay !== info.logicalDay) {
              await todayRollover(initialPath, nowIso, timezone, todaySettings.dayStart, todaySettings.sleepStart).catch(() => null);
              const snapshot = await todayOpen(initialPath, nowIso, timezone, todaySettings.dayStart, todaySettings.sleepStart);
              const decision = resolveLaunchRoute({
                enabled: todaySettings.enabled,
                autoOpen: todaySettings.autoOpenFirstDailyLaunch,
                lastAutoOpenDay,
                logicalDay: info.logicalDay,
                dayState: snapshot.dayState,
                explicitMode: false,
              });
              if (decision) {
                planningModeController.setTodayRoute(decision.route);
                setAppMode(decision.mode);
                todayAutoOpenPathRef.current = initialPath;
                todayAutoOpenModeRef.current = decision.mode;
                window.localStorage.setItem(todayAutoOpenKey(initialPath), info.logicalDay);
              }
            }
          } catch (error) {
            console.warn("today auto-open skipped", error);
          }
        }
        const lastRel = typeof window !== "undefined" ? window.localStorage.getItem(lastOpenKey(initialPath)) : null;
        await loadWorkspace(initialPath, initialVisibility, lastRel);
        setBooting(false);
        markStartup("boot:end", { initialPath, initialVisibility });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setError(message);
        setBooting(false);
        markStartup("boot:error", { message });
      }
    }
    void boot();
    // Bootstrap intentionally runs only once; all values above are mount ports.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

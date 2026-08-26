import { lazy, Suspense, type ComponentType, type ReactNode } from "react";

import type { DocumentBrowserScope } from "./documentBrowserStore";
import type { DocumentOpsModeHost } from "./documentOpsModeStore";
import { isDiagramEnabled } from "./diagramFlag";
import { isE2EFlowEnabled } from "./e2eFlow";
import type { FavoriteTarget } from "../components/FavoritesSection";
import type { FavoriteKind, MaruAppMode, MaruSettings } from "./settings";

export type ModePlacement = "primary" | "right" | "panel";
export type RegisteredModeId = MaruAppMode;

const registeredModeIds = [
  "pkm", "scratchpad", "files", "inbox", "comms", "meetings", "today", "tasks", "dashboard",
  "catalog", "studio", "e2e", "diagram", "sites", "graph", "drafts", "gap", "agents",
] as const satisfies readonly RegisteredModeId[];

/** Identifiers only: adapters subscribe to their own data instead of receiving shell snapshots. */
export interface ModeHostScope {
  workspacePath: string | null;
  documentBrowserScope: DocumentBrowserScope;
}

/** Narrow shell command port. New modes add a dedicated adapter, never an App render branch. */
export interface ModeHostCommands {
  renderPrimarySurface(): ReactNode;
  revealPath?(path: string): void;
  saveDocument?(path: string, content: string, expectedRevision: string | null): Promise<unknown>;
  openGraphEntry?(entry: unknown): void;
  createGraphNote?(target: string): void;
  isGraphFavorite?(kind: FavoriteKind, relPath: string): boolean;
  toggleGraphFavorite?(target: FavoriteTarget): void;
  onGraphChanged?(): void;
  sitesOverlayOpen?: boolean;
  closeRightWorkbench?(): void;
  confirmApproval?(input: unknown): Promise<string | null>;
  refreshCurrent?(): void;
  updateSettings?(updater: MaruSettings | ((current: MaruSettings) => MaruSettings)): void;
  translate?(key: string, vars?: Record<string, string | number>): string;
  openPrimaryMode?(mode: "agents" | "gap"): void;
  openGraphPanel?(): void;
  documentOps?: DocumentOpsModeHost;
}

export interface ModeAdapterProps {
  scope: ModeHostScope;
  commands: ModeHostCommands;
}

export interface ModeDescriptor {
  id: RegisteredModeId;
  load: () => Promise<{ default: ComponentType<ModeAdapterProps> }>;
  placements: readonly ModePlacement[];
  isAvailable: () => boolean;
  fallback: "mode-loading";
}

const modeRegistry: Record<RegisteredModeId, ModeDescriptor> = {
  pkm: {
    id: "pkm",
    load: () => import("./modeAdapters/PkmModeAdapter").then((module) => ({ default: module.PkmModeAdapter })),
    placements: ["primary"],
    isAvailable: () => true,
    fallback: "mode-loading",
  },
  e2e: {
    id: "e2e",
    load: () => import("./modeAdapters/E2EFlowModeAdapter").then((module) => ({ default: module.E2EFlowModeAdapter })),
    placements: ["primary", "right"],
    isAvailable: isE2EFlowEnabled,
    fallback: "mode-loading",
  },
  diagram: {
    id: "diagram",
    load: () => import("./modeAdapters/DiagramModeAdapter").then((module) => ({ default: module.DiagramModeAdapter })),
    placements: ["primary", "right"],
    isAvailable: isDiagramEnabled,
    fallback: "mode-loading",
  },
  graph: {
    id: "graph",
    load: () => import("./modeAdapters/GraphModeAdapter").then((module) => ({ default: module.GraphModeAdapter })),
    placements: ["primary", "right", "panel"],
    isAvailable: () => true,
    fallback: "mode-loading",
  },
  sites: {
    id: "sites",
    load: () => import("./modeAdapters/SitesModeAdapter").then((module) => ({ default: module.SitesModeAdapter })),
    placements: ["primary", "right"],
    isAvailable: () => true,
    fallback: "mode-loading",
  },
  agents: {
    id: "agents",
    load: () => import("./modeAdapters/AgentsModeAdapter").then((module) => ({ default: module.AgentsModeAdapter })),
    placements: ["primary", "right"],
    isAvailable: () => true,
    fallback: "mode-loading",
  },
  inbox: {
    id: "inbox",
    load: () => import("./modeAdapters/InboxModeAdapter").then((module) => ({ default: module.InboxModeAdapter })),
    placements: ["primary", "right"],
    isAvailable: () => true,
    fallback: "mode-loading",
  },
  comms: {
    id: "comms",
    load: () => import("./modeAdapters/CommsModeAdapter").then((module) => ({ default: module.CommsModeAdapter })),
    placements: ["primary", "right"],
    isAvailable: () => true,
    fallback: "mode-loading",
  },
  meetings: {
    id: "meetings",
    load: () => import("./modeAdapters/MeetingsModeAdapter").then((module) => ({ default: module.MeetingsModeAdapter })),
    placements: ["primary", "right"],
    isAvailable: () => true,
    fallback: "mode-loading",
  },
  today: {
    id: "today",
    load: () => import("./modeAdapters/TodayModeAdapter").then((module) => ({ default: module.TodayModeAdapter })),
    placements: ["primary", "right"],
    isAvailable: () => true,
    fallback: "mode-loading",
  },
  tasks: {
    id: "tasks",
    load: () => import("./modeAdapters/TasksModeAdapter").then((module) => ({ default: module.TasksModeAdapter })),
    placements: ["primary", "right"],
    isAvailable: () => true,
    fallback: "mode-loading",
  },
  dashboard: {
    id: "dashboard",
    load: () => import("./modeAdapters/DashboardModeAdapter").then((module) => ({ default: module.DashboardModeAdapter })),
    placements: ["primary", "right"],
    isAvailable: () => true,
    fallback: "mode-loading",
  },
  scratchpad: {
    id: "scratchpad",
    load: () => import("./modeAdapters/ScratchpadModeAdapter").then((module) => ({ default: module.ScratchpadModeAdapter })),
    placements: ["primary"],
    isAvailable: () => true,
    fallback: "mode-loading",
  },
  drafts: {
    id: "drafts",
    load: () => import("./modeAdapters/DraftsModeAdapter").then((module) => ({ default: module.DraftsModeAdapter })),
    placements: ["primary", "right"],
    isAvailable: () => true,
    fallback: "mode-loading",
  },
  gap: {
    id: "gap",
    load: () => import("./modeAdapters/GapModeAdapter").then((module) => ({ default: module.GapModeAdapter })),
    placements: ["primary", "right"],
    isAvailable: () => true,
    fallback: "mode-loading",
  },
  files: {
    id: "files",
    load: () => import("./modeAdapters/FilesModeAdapter").then((module) => ({ default: module.FilesModeAdapter })),
    placements: ["primary", "right"],
    isAvailable: () => true,
    fallback: "mode-loading",
  },
  studio: {
    id: "studio",
    load: () => import("./modeAdapters/StudioModeAdapter").then((module) => ({ default: module.StudioModeAdapter })),
    placements: ["primary", "right"],
    isAvailable: () => true,
    fallback: "mode-loading",
  },
  catalog: {
    id: "catalog",
    load: () => import("./modeAdapters/CatalogModeAdapter").then((module) => ({ default: module.CatalogModeAdapter })),
    placements: ["primary", "right"],
    isAvailable: () => true,
    fallback: "mode-loading",
  },
};

const lazyAdapters: Record<RegisteredModeId, ReturnType<typeof lazy<ComponentType<ModeAdapterProps>>>> = {
  pkm: lazy(modeRegistry.pkm.load),
  e2e: lazy(modeRegistry.e2e.load),
  diagram: lazy(modeRegistry.diagram.load),
  graph: lazy(modeRegistry.graph.load),
  sites: lazy(modeRegistry.sites.load),
  agents: lazy(modeRegistry.agents.load),
  inbox: lazy(modeRegistry.inbox.load),
  comms: lazy(modeRegistry.comms.load),
  meetings: lazy(modeRegistry.meetings.load),
  today: lazy(modeRegistry.today.load),
  tasks: lazy(modeRegistry.tasks.load),
  dashboard: lazy(modeRegistry.dashboard.load),
  scratchpad: lazy(modeRegistry.scratchpad.load),
  drafts: lazy(modeRegistry.drafts.load),
  gap: lazy(modeRegistry.gap.load),
  files: lazy(modeRegistry.files.load),
  studio: lazy(modeRegistry.studio.load),
  catalog: lazy(modeRegistry.catalog.load),
};

export function getModeDescriptor(mode: string): ModeDescriptor | null {
  return mode in modeRegistry ? modeRegistry[mode as RegisteredModeId] : null;
}

/** Exhaustive app-mode inventory for registry tests and descriptor consumers. */
export function getRegisteredModeIds(): readonly RegisteredModeId[] {
  return registeredModeIds;
}

export interface ModeSurfaceHostProps {
  mode: string;
  placement: ModePlacement;
  scope: ModeHostScope;
  commands: ModeHostCommands;
}

export function ModeSurfaceHost({ mode, placement, scope, commands }: ModeSurfaceHostProps): ReactNode {
  const descriptor = getModeDescriptor(mode);
  if (!descriptor || !descriptor.placements.includes(placement) || !descriptor.isAvailable()) return null;
  const Adapter = lazyAdapters[descriptor.id];
  return (
    <Suspense fallback={<div className={descriptor.fallback} role="status">…</div>}>
      <Adapter scope={scope} commands={commands} />
    </Suspense>
  );
}

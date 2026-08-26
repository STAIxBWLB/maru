import { lazy, Suspense, type ComponentType, type ReactNode } from "react";

import type { DocumentBrowserScope } from "./documentBrowserStore";
import { isDiagramEnabled } from "./diagramFlag";
import { isE2EFlowEnabled } from "./e2eFlow";
import type { FavoriteTarget } from "../components/FavoritesSection";
import type { FavoriteKind } from "./settings";

export type ModePlacement = "primary" | "right" | "panel";
export type RegisteredModeId = "pkm" | "e2e" | "diagram" | "graph" | "sites" | "agents" | "inbox" | "comms";

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
    placements: ["primary"],
    isAvailable: () => true,
    fallback: "mode-loading",
  },
  inbox: {
    id: "inbox",
    load: () => import("./modeAdapters/InboxModeAdapter").then((module) => ({ default: module.InboxModeAdapter })),
    placements: ["primary"],
    isAvailable: () => true,
    fallback: "mode-loading",
  },
  comms: {
    id: "comms",
    load: () => import("./modeAdapters/CommsModeAdapter").then((module) => ({ default: module.CommsModeAdapter })),
    placements: ["primary"],
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
};

export function getModeDescriptor(mode: string): ModeDescriptor | null {
  return mode in modeRegistry ? modeRegistry[mode as RegisteredModeId] : null;
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

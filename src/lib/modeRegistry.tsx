import { lazy, Suspense, type ComponentType, type ReactNode } from "react";

import type { DocumentBrowserScope } from "./documentBrowserStore";

export type ModePlacement = "primary" | "right";
export type RegisteredModeId = "pkm";

/** Identifiers only: adapters subscribe to their own data instead of receiving shell snapshots. */
export interface ModeHostScope {
  workspacePath: string | null;
  documentBrowserScope: DocumentBrowserScope;
}

/** Narrow shell command port. New modes add a dedicated adapter, never an App render branch. */
export interface ModeHostCommands {
  renderPrimarySurface(): ReactNode;
  revealPath?(path: string): void;
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
};

const lazyAdapters: Record<RegisteredModeId, ReturnType<typeof lazy<ComponentType<ModeAdapterProps>>>> = {
  pkm: lazy(modeRegistry.pkm.load),
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

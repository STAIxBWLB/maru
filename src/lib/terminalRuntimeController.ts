import type { TerminalSpawnHandle } from "./api";
import { TerminalInputPump } from "./terminalInputPump";

/**
 * Mutable terminal resources deliberately live outside React snapshots. The
 * component owns render-moment DOM state; this controller owns process-wide
 * native/channel lifecycles and releases all resources in one place.
 */
export class TerminalRuntimeController {
  private readonly registries = new Map<string, Map<string, unknown>>();
  private readonly sets = new Map<string, Set<string>>();
  private readonly channels = new Map<string, TerminalSpawnHandle["channel"]>();
  private readonly inputPumps = new Map<string, TerminalInputPump>();
  private readonly disposeCallbacks = new Map<string, () => void>();
  private disposed = false;

  /** Typed process registries keep native values out of external-store snapshots. */
  registry<T>(name: string): Map<string, T> {
    let registry = this.registries.get(name);
    if (!registry) {
      registry = new Map<string, unknown>();
      this.registries.set(name, registry);
    }
    return registry as Map<string, T>;
  }

  registrySet(name: string): Set<string> {
    let registry = this.sets.get(name);
    if (!registry) {
      registry = new Set<string>();
      this.sets.set(name, registry);
    }
    return registry;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  setDisposed(disposed: boolean): void {
    this.disposed = disposed;
  }

  registerChannel(sessionId: string, channel: TerminalSpawnHandle["channel"]): void {
    if (this.disposed) return;
    this.channels.set(sessionId, channel);
  }

  registerInputPump(sessionId: string, pump: TerminalInputPump): void {
    if (this.disposed) {
      pump.fail(new Error("Terminal runtime disposed"));
      return;
    }
    this.inputPumps.set(sessionId, pump);
  }

  registerDisposer(sessionId: string, dispose: () => void): void {
    if (this.disposed) {
      dispose();
      return;
    }
    this.disposeCallbacks.set(sessionId, dispose);
  }

  release(sessionId: string): void {
    this.inputPumps.get(sessionId)?.fail(new Error("Terminal session released"));
    this.inputPumps.delete(sessionId);
    this.channels.delete(sessionId);
    const dispose = this.disposeCallbacks.get(sessionId);
    this.disposeCallbacks.delete(sessionId);
    dispose?.();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const sessionId of new Set([
      ...this.channels.keys(),
      ...this.inputPumps.keys(),
      ...this.disposeCallbacks.keys(),
    ])) {
      this.release(sessionId);
    }
    for (const registry of this.registries.values()) registry.clear();
    for (const registry of this.sets.values()) registry.clear();
  }
}

const controller = new TerminalRuntimeController();

export function getTerminalRuntimeController(): TerminalRuntimeController {
  return controller;
}

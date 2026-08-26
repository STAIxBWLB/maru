import { useLayoutEffect } from "react";
import type { ReactNode } from "react";

/** Controller contract for a host projection that must be published after React commits. */
export interface ModeHostController<Host> {
  bind(host: Host): void;
}

/**
 * Publishes a stable mode host after its parent commits. Keeping this boundary
 * outside MainApp avoids notifying adapter useSyncExternalStore subscribers
 * during the parent's render phase.
 */
export function ModeHostPublisher<Host>({
  controller,
  host,
}: {
  controller: ModeHostController<Host>;
  host: Host;
}): ReactNode {
  useLayoutEffect(() => {
    controller.bind(host);
  }, [controller, host]);
  return null;
}

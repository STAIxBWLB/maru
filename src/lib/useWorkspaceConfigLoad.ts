import { useCallback, useEffect, useRef, useState } from "react";
import {
  readWorkspaceConfig,
  resolveWorkspaceConfigLoad,
  type WorkspaceConfigLoadState,
  type WorkspaceConfigReader,
  type WorkspaceConfigValidator,
} from "./maruDir";

const IDLE_STATE: WorkspaceConfigLoadState = {
  workPath: null,
  status: "idle",
  config: null,
  error: null,
};

function pendingState(workPath: string): WorkspaceConfigLoadState {
  return {
    workPath,
    status: "pending",
    config: null,
    error: null,
  };
}

export function useWorkspaceConfigLoad(
  workPath: string | null,
  options: {
    enabled?: boolean;
    reader?: WorkspaceConfigReader;
    validator?: WorkspaceConfigValidator;
  } = {},
): {
  state: WorkspaceConfigLoadState;
  reloading: boolean;
  reload: () => Promise<WorkspaceConfigLoadState>;
} {
  const enabled = options.enabled ?? true;
  const reader = options.reader ?? readWorkspaceConfig;
  const validator = options.validator;
  const [state, setState] = useState<WorkspaceConfigLoadState>(IDLE_STATE);
  const [reloading, setReloading] = useState(false);
  const pendingRef = useRef<{
    workPath: string;
    promise: Promise<WorkspaceConfigLoadState>;
  } | null>(null);

  const reload = useCallback(async () => {
    if (!enabled || !workPath) {
      pendingRef.current = null;
      setState(IDLE_STATE);
      setReloading(false);
      return IDLE_STATE;
    }
    const pending = pendingRef.current;
    if (pending?.workPath === workPath) return pending.promise;

    // Keep an already loaded config visible while it refreshes; only the
    // first load (or a path change) flips to pending.
    setState((current) =>
      current.workPath === workPath && current.status === "ready"
        ? current
        : pendingState(workPath),
    );
    setReloading(true);
    const promise = resolveWorkspaceConfigLoad(workPath, reader, validator);
    pendingRef.current = { workPath, promise };
    const result = await promise;
    if (pendingRef.current?.promise === promise) {
      pendingRef.current = null;
      setState(result);
      setReloading(false);
    }
    return result;
  }, [enabled, reader, validator, workPath]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const exactState =
    enabled && workPath
      ? state.workPath === workPath
        ? state
        : pendingState(workPath)
      : IDLE_STATE;
  return { state: exactState, reloading, reload };
}

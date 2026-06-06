import {
  ChevronDown,
  ChevronUp,
  Code2,
  FileText,
  Maximize2,
  Minimize2,
  PanelBottom,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRight,
  Plus,
  SquareTerminal,
  X,
} from "lucide-react";
import type React from "react";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  terminalAvailable,
  terminalInput,
  terminalKill,
  terminalResize,
  terminalScroll,
  terminalSpawn,
  terminalWrite,
  type TerminalFrame,
  type TerminalInputCommand,
} from "../lib/api";
import { useTranslation } from "../lib/i18n";
import type { AnchorSettings, TerminalDock } from "../lib/settings";
import { NativeTerminalView, type NativeTerminalViewHandle } from "./NativeTerminalView";
import {
  activeItemMention,
  buildAgentContextArgs,
  buildAgentResumeArgs,
  buildAnchorContextEnv,
  createTerminalTab,
  createTerminalTask,
  describeActiveContextChip,
  EMPTY_TERMINAL_STATE,
  hydrateTerminalStateFromPersisted,
  isRelaunchableTab,
  pathMention,
  resolveExistingLaunchTaskId,
  selectTerminalSplitLeftTabId,
  selectTerminalTabByIndex,
  serializeTerminalState,
  shouldSuppressTerminalHoverMouseEvent,
  shouldCloseTerminalSplitAfterTabClose,
  shouldAutoLaunchTerminal,
  tabsForTask,
  TERMINAL_LAUNCHERS,
  terminalCommandPreview,
  terminalHookEventToStatus,
  terminalTabStatus,
  terminalTabsReducer,
  terminalTaskStatus,
  type ActiveTerminalContext,
  type AttachMentionStyle,
  type TerminalKind,
} from "../lib/terminal";

interface TerminalPanelProps {
  cwd: string | null;
  activeContext: ActiveTerminalContext;
  settings: AnchorSettings;
  launchRequest?: TerminalLaunchRequest | null;
  open: boolean;
  height: number;
  dock: TerminalDock;
  width: number;
  splitOpen: boolean;
  splitRatio: number;
  maximized: boolean;
  onOpenChange: (open: boolean) => void;
  onHeightChange: (height: number) => void;
  onDockChange: (dock: TerminalDock) => void;
  onWidthChange: (width: number) => void;
  onSplitOpenChange: (open: boolean) => void;
  onSplitRatioChange: (ratio: number) => void;
  onMaximizedChange: (maximized: boolean) => void;
}

export interface TerminalLaunchRequest {
  kind: TerminalKind;
  nonce: number;
  title?: string | null;
  cwd?: string | null;
  command?: string | null;
  extraArgs?: string[] | null;
  extraEnv?: Record<string, string> | null;
  taskId?: string | null;
  /** Force a brand-new task (sidebar "+"), ignoring the active task. */
  forceNewTask?: boolean;
}

/** Imperative surface so App can attach files to a focused agent session. */
export interface TerminalPanelHandle {
  hasFocusedAgent: () => boolean;
  attachActiveItem: () => boolean;
  attachPath: (relPath: string | null, absPath: string | null) => boolean;
}

interface TerminalExitEvent {
  sessionId: string;
  exitCode: number | null;
}

interface TerminalStatusEvent {
  sessionId: string;
  status: string;
  agentSessionId?: string | null;
}

const MIN_HEIGHT = 160;
const MAX_HEIGHT = 520;
const MIN_WIDTH = 320;
const MIN_MAIN_WIDTH = 360;
const TERMINAL_STORAGE_KEY = "anchor:terminal:v1";

function loadPersistedTerminalState(): typeof EMPTY_TERMINAL_STATE {
  try {
    const raw = window.localStorage.getItem(TERMINAL_STORAGE_KEY);
    if (!raw) return EMPTY_TERMINAL_STATE;
    return hydrateTerminalStateFromPersisted(JSON.parse(raw));
  } catch {
    return EMPTY_TERMINAL_STATE;
  }
}

function pathBaseName(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

export const TerminalPanel = memo(
  forwardRef<TerminalPanelHandle, TerminalPanelProps>(function TerminalPanel(
    {
      cwd,
      activeContext,
      settings,
      launchRequest,
      open,
      height,
      dock,
      width,
      splitOpen,
      splitRatio,
      maximized,
      onOpenChange,
      onHeightChange,
      onDockChange,
      onWidthChange,
      onSplitOpenChange,
      onSplitRatioChange,
      onMaximizedChange,
    },
    ref,
  ) {
    const { t } = useTranslation();
    const [state, dispatch] = useReducer(
      terminalTabsReducer,
      EMPTY_TERMINAL_STATE,
      loadPersistedTerminalState,
    );
    const [draftHeight, setDraftHeight] = useState(height);
    const [draftWidth, setDraftWidth] = useState(width);
    const [rightTabId, setRightTabId] = useState<string | null>(null);
    const [focusedGroup, setFocusedGroup] = useState<"left" | "right">("left");
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [renamingTaskId, setRenamingTaskId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const handlesRef = useRef<Map<string, NativeTerminalViewHandle>>(new Map());
    const terminalBodyRef = useRef<HTMLDivElement | null>(null);
    const sessionByTabRef = useRef<Map<string, string>>(new Map());
    const tabBySessionRef = useRef<Map<string, string>>(new Map());
    // One stable handler object per session so NativeTerminalView's memo() can
    // bail out — inline closures here would re-render every grid on any state
    // change. Pruned when the session ends.
    const sessionHandlersRef = useRef<
      Map<
        string,
        {
          onInput: (command: TerminalInputCommand) => void;
          onResize: (cols: number, rows: number) => void;
          onScroll: (delta: number) => void;
        }
      >
    >(new Map());
    // Whether each session's program has requested a mouse mode; lets us stop
    // suppressing hover so TUIs (claude/codex) receive it.
    const mouseModesBySessionRef = useRef<Map<string, boolean>>(new Map());
    const [framesBySession, setFramesBySession] = useState<Record<string, TerminalFrame>>({});
    const [resizeReadySessions, setResizeReadySessions] = useState<Record<string, true>>({});
    const seqRef = useRef(1);
    const taskSeqRef = useRef(1);
    const autoLaunchRef = useRef(false);
    const handledLaunchRequestRef = useRef<number | null>(null);
    const focusedTabIdRef = useRef<string | null>(null);

    const injectContext = settings.terminal.injectActiveContext ?? true;
    const attachStyle: AttachMentionStyle = settings.terminal.attachMentionStyle ?? "mention";

    const activeTaskId = state.activeTaskId;
    const activeTaskTabs = useMemo(
      () => tabsForTask(state, activeTaskId),
      [state, activeTaskId],
    );
    const activeTask = state.tasks.find((task) => task.id === activeTaskId) ?? null;
    const activeTab = activeTaskTabs.find((tab) => tab.id === state.activeTabId) ?? null;
    const rightTab = activeTaskTabs.find((tab) => tab.id === rightTabId) ?? null;
    const splitLeftTabId = selectTerminalSplitLeftTabId(
      activeTaskTabs,
      state.activeTabId,
      rightTabId,
    );
    const splitLeftTab = activeTaskTabs.find((tab) => tab.id === splitLeftTabId) ?? null;
    const canRunTerminal = useMemo(() => terminalAvailable(), []);
    const headerCwd = activeTask?.cwd ?? cwd;

    useEffect(() => {
      setDraftHeight(height);
    }, [height]);

    useEffect(() => {
      setDraftWidth(width);
    }, [width]);

    useEffect(() => {
      if (!canRunTerminal) return;
      let disposed = false;

      const framePromise = import("@tauri-apps/api/event").then(({ listen }) =>
        listen<TerminalFrame>("terminal://frame", (event) => {
          if (disposed) return;
          const tabId = tabBySessionRef.current.get(event.payload.sessionId);
          if (!tabId) return;
          const mouse = event.payload.mouse;
          mouseModesBySessionRef.current.set(
            event.payload.sessionId,
            Boolean(mouse && (mouse.click || mouse.motion || mouse.drag)),
          );
          setFramesBySession((current) => ({
            ...current,
            [event.payload.sessionId]: event.payload,
          }));
          // Output on a non-focused session raises an attention flag.
          if (tabId !== focusedTabIdRef.current) {
            dispatch({ type: "markAttention", sessionId: event.payload.sessionId });
          }
        }),
      );
      const exitPromise = import("@tauri-apps/api/event").then(({ listen }) =>
        listen<TerminalExitEvent>("terminal://exit", (event) => {
          if (disposed) return;
          const tabId = tabBySessionRef.current.get(event.payload.sessionId);
          if (tabId) {
            sessionByTabRef.current.delete(tabId);
          }
          tabBySessionRef.current.delete(event.payload.sessionId);
          sessionHandlersRef.current.delete(event.payload.sessionId);
          mouseModesBySessionRef.current.delete(event.payload.sessionId);
          setResizeReadySessions((current) => {
            const next = { ...current };
            delete next[event.payload.sessionId];
            return next;
          });
          setFramesBySession((current) => {
            if (!(event.payload.sessionId in current)) return current;
            const next = { ...current };
            delete next[event.payload.sessionId];
            return next;
          });
          dispatch({
            type: "exit",
            sessionId: event.payload.sessionId,
            exitCode: event.payload.exitCode,
          });
        }),
      );

      const statusPromise = import("@tauri-apps/api/event").then(({ listen }) =>
        listen<TerminalStatusEvent>("terminal://status", (event) => {
          if (disposed) return;
          const status = terminalHookEventToStatus(event.payload.status);
          if (!status) return;
          dispatch({
            type: "setStatus",
            sessionId: event.payload.sessionId,
            status,
            agentSessionId: event.payload.agentSessionId ?? null,
          });
        }),
      );

      framePromise.catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
      exitPromise.catch((err) => {
        setError(err instanceof Error ? err.message : String(err));
      });
      statusPromise.catch(() => {
        // The status channel is optional (agent hooks may be disabled).
      });

      return () => {
        disposed = true;
        // Wait for the listen() promises to resolve before unsubscribing,
        // otherwise we leak the registration.
        void framePromise.then((off) => off()).catch(() => {});
        void exitPromise.then((off) => off()).catch(() => {});
        void statusPromise.then((off) => off()).catch(() => {});
      };
    }, [canRunTerminal]);

    useEffect(() => {
      return () => {
        for (const sessionId of sessionByTabRef.current.values()) {
          void terminalKill(sessionId);
        }
        handlesRef.current.clear();
      };
    }, []);

    // Persist task + session metadata so the sidebar repopulates with
    // relaunchable entries after a restart (PTYs themselves cannot survive).
    useEffect(() => {
      const id = window.setTimeout(() => {
        try {
          window.localStorage.setItem(
            TERMINAL_STORAGE_KEY,
            JSON.stringify(serializeTerminalState(state)),
          );
        } catch {
          // localStorage may be unavailable (private mode); persistence is best-effort.
        }
      }, 400);
      return () => window.clearTimeout(id);
    }, [state]);

    // The native renderer owns terminal selection/copy. Prevent page-level
    // selection from leaking in around the terminal grid.
    useEffect(() => {
      const body = terminalBodyRef.current;
      if (!body) return;
      const onSelectStart = (event: Event) => event.preventDefault();
      body.addEventListener("selectstart", onSelectStart);
      return () => body.removeEventListener("selectstart", onSelectStart);
    }, []);

    const launch = useCallback(
      async (
        kind: TerminalKind,
        group: "left" | "right" = "left",
        request?: Omit<TerminalLaunchRequest, "kind" | "nonce">,
      ) => {
        if (!canRunTerminal) {
          setError(t("terminal.tauriRequired"));
          return;
        }
        const launcher = settings.terminal.launchers[kind];
        if (!launcher?.enabled) return;
        const resolvedCwd = request?.cwd ?? cwd;
        // Resolve the owning task in ONE place (launch owns creation). Using a
        // pure resolver avoids the stale-closure double-create bug where a
        // pre-dispatched task isn't yet visible in `state`.
        let taskId = resolveExistingLaunchTaskId(state.tasks, state.activeTaskId, {
          requestedTaskId: request?.taskId,
          forceNewTask: request?.forceNewTask,
        });
        if (!taskId) {
          taskId = `task-${Date.now()}-${taskSeqRef.current++}`;
          const taskName =
            pathBaseName(resolvedCwd) ?? `${t("terminal.task")} ${state.tasks.length + 1}`;
          dispatch({
            type: "createTask",
            task: createTerminalTask(taskId, taskName, resolvedCwd, { createdAt: Date.now() }),
          });
        }
        const tabId = `terminal-${Date.now()}-${seqRef.current++}`;
        const sessionId = `term-${
          typeof crypto !== "undefined" && "randomUUID" in crypto
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2)}`
        }`;
        const title = request?.title || launcher.label || t(`terminal.launcher.${kind}`);
        // Register the session↔tab mapping BEFORE spawning so we don't drop
        // any terminal://frame events that race ahead of the IPC return.
        sessionByTabRef.current.set(tabId, sessionId);
        tabBySessionRef.current.set(sessionId, tabId);
        dispatch({
          type: "create",
          tab: createTerminalTab(tabId, kind, title, {
            taskId,
            cwd: resolvedCwd,
            createdAt: Date.now(),
          }),
          activate: group !== "right",
        });
        if (group === "right") {
          setRightTabId(tabId);
          setFocusedGroup("right");
        } else {
          setFocusedGroup("left");
        }
        dispatch({ type: "attach", tabId, sessionId });
        if (!open) onOpenChange(true);
        setError(null);

        try {
          const contextEnv = buildAnchorContextEnv(activeContext, sessionId, injectContext);
          const contextArgs = buildAgentContextArgs(kind, activeContext, injectContext);
          await terminalSpawn(sessionId, kind, resolvedCwd, {
            command: request?.command ?? launcher.command ?? null,
            extraArgs: [...contextArgs, ...(request?.extraArgs ?? launcher.args ?? [])],
            extraEnv: { ...contextEnv, ...(request?.extraEnv ?? {}) },
            cols: 120,
            rows: 30,
          });
          setResizeReadySessions((current) => ({
            ...current,
            [sessionId]: true,
          }));
          window.requestAnimationFrame(() => {
            if (group === focusedGroup || group === "right") {
              handlesRef.current.get(tabId)?.focus();
            }
          });
        } catch (err) {
          sessionByTabRef.current.delete(tabId);
          tabBySessionRef.current.delete(sessionId);
          setResizeReadySessions((current) => {
            const next = { ...current };
            delete next[sessionId];
            return next;
          });
          dispatch({ type: "fail", tabId });
          setError(err instanceof Error ? err.message : String(err));
        }
      },
      [
        activeContext,
        canRunTerminal,
        cwd,
        focusedGroup,
        injectContext,
        onOpenChange,
        open,
        settings.terminal.launchers,
        state.activeTaskId,
        state.tasks,
        t,
      ],
    );

    useEffect(() => {
      if (!open) {
        autoLaunchRef.current = false;
        return;
      }
      if (splitOpen) return;
      const launcher = shouldAutoLaunchTerminal(settings, open, state.tabs.length);
      if (!launcher || autoLaunchRef.current) return;
      autoLaunchRef.current = true;
      void launch(launcher);
    }, [launch, open, settings, splitOpen, state.tabs.length]);

    useEffect(() => {
      if (!launchRequest) return;
      if (handledLaunchRequestRef.current === launchRequest.nonce) return;
      handledLaunchRequestRef.current = launchRequest.nonce;
      void launch(launchRequest.kind, focusedGroup, launchRequest);
    }, [focusedGroup, launch, launchRequest]);

    useEffect(() => {
      if (!splitOpen) {
        setRightTabId(null);
        setFocusedGroup("left");
        return;
      }

      if (rightTabId && !activeTaskTabs.some((tab) => tab.id === rightTabId)) {
        setRightTabId(null);
        setFocusedGroup("left");
        return;
      }

      if (!splitLeftTab) {
        if (rightTabId) {
          setRightTabId(null);
          setFocusedGroup("left");
          return;
        }
        const kind = settings.terminal.autoLaunch ?? "shell";
        void launch(kind, "left");
        return;
      }

      if (state.activeTabId !== splitLeftTab.id) {
        dispatch({ type: "switch", tabId: splitLeftTab.id });
      }

      if (rightTabId) return;
      const kind = splitLeftTab.kind;
      void launch(kind, "right");
    }, [
      activeTaskTabs,
      launch,
      rightTabId,
      settings.terminal.autoLaunch,
      splitLeftTab,
      splitOpen,
      state.activeTabId,
    ]);

    const closeTab = useCallback(
      (tabId: string) => {
        const sessionId = sessionByTabRef.current.get(tabId);
        if (sessionId) {
          void terminalKill(sessionId);
          sessionByTabRef.current.delete(tabId);
          tabBySessionRef.current.delete(sessionId);
          sessionHandlersRef.current.delete(sessionId);
          mouseModesBySessionRef.current.delete(sessionId);
          setResizeReadySessions((current) => {
            const next = { ...current };
            delete next[sessionId];
            return next;
          });
          setFramesBySession((current) => {
            const next = { ...current };
            delete next[sessionId];
            return next;
          });
        }
        handlesRef.current.delete(tabId);

        if (shouldCloseTerminalSplitAfterTabClose(activeTaskTabs, splitOpen, rightTabId, tabId)) {
          setRightTabId(null);
          onSplitOpenChange(false);
          setFocusedGroup("left");
        }
        dispatch({ type: "close", tabId });
      },
      [activeTaskTabs, onSplitOpenChange, rightTabId, splitOpen],
    );

    const closeTask = useCallback((taskId: string) => {
      for (const tab of state.tabs) {
        if (tab.taskId !== taskId) continue;
        const sessionId = sessionByTabRef.current.get(tab.id);
        if (sessionId) {
          void terminalKill(sessionId);
          sessionByTabRef.current.delete(tab.id);
          tabBySessionRef.current.delete(sessionId);
          sessionHandlersRef.current.delete(sessionId);
          mouseModesBySessionRef.current.delete(sessionId);
          setResizeReadySessions((current) => {
            const next = { ...current };
            delete next[sessionId];
            return next;
          });
          setFramesBySession((current) => {
            const next = { ...current };
            delete next[sessionId];
            return next;
          });
        }
        handlesRef.current.delete(tab.id);
      }
      if (rightTab && rightTab.taskId === taskId) {
        setRightTabId(null);
        setFocusedGroup("left");
      }
      dispatch({ type: "closeTask", taskId });
    }, [rightTab, state.tabs]);

    const createTask = useCallback(() => {
      // Delegate to launch with forceNewTask so task + session are created in a
      // single place — prevents the duplicate empty-task bug.
      void launch(settings.terminal.autoLaunch ?? "shell", "left", { forceNewTask: true });
    }, [launch, settings.terminal.autoLaunch]);

    // Re-spawn a restored placeholder in place: drop the placeholder and launch
    // a fresh session in the same task, resuming the agent when we have its id.
    const relaunchTab = useCallback(
      (tabId: string) => {
        const tab = state.tabs.find((item) => item.id === tabId);
        if (!tab) return;
        const resumeArgs = buildAgentResumeArgs(tab.kind, tab.agentSessionId);
        dispatch({ type: "close", tabId });
        void launch(tab.kind, "left", {
          taskId: tab.taskId,
          cwd: tab.cwd,
          title: tab.title,
          extraArgs: resumeArgs.length > 0 ? resumeArgs : undefined,
        });
      },
      [launch, state.tabs],
    );

    const toggleOpen = useCallback(() => {
      onOpenChange(!open);
    }, [onOpenChange, open]);

    const startResize = useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        const handle = event.currentTarget;
        const pointerId = event.pointerId;
        if (dock === "right") {
          const startX = event.clientX;
          const startWidth = draftWidth;
          let latest = startWidth;
          handle.setPointerCapture(pointerId);

          const onMove = (move: PointerEvent) => {
            if (move.pointerId !== pointerId) return;
            const viewportMax = Math.max(MIN_WIDTH, window.innerWidth - MIN_MAIN_WIDTH);
            const next = Math.min(
              viewportMax,
              Math.max(MIN_WIDTH, startWidth + startX - move.clientX),
            );
            latest = next;
            setDraftWidth(next);
            onWidthChange(next);
          };
          const cleanup = () => {
            handle.removeEventListener("pointermove", onMove);
            handle.removeEventListener("pointerup", onEnd);
            handle.removeEventListener("pointercancel", onEnd);
            if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
          };
          const onEnd = (end: PointerEvent) => {
            if (end.pointerId !== pointerId) return;
            cleanup();
            onWidthChange(latest);
          };
          handle.addEventListener("pointermove", onMove);
          handle.addEventListener("pointerup", onEnd);
          handle.addEventListener("pointercancel", onEnd);
          return;
        }

        const startY = event.clientY;
        const startHeight = draftHeight;
        let latest = startHeight;
        handle.setPointerCapture(pointerId);

        const onMove = (move: PointerEvent) => {
          if (move.pointerId !== pointerId) return;
          const next = Math.min(
            MAX_HEIGHT,
            Math.max(MIN_HEIGHT, startHeight + startY - move.clientY),
          );
          latest = next;
          setDraftHeight(next);
        };
        const cleanup = () => {
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup", onEnd);
          handle.removeEventListener("pointercancel", onEnd);
          if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
        };
        const onEnd = (end: PointerEvent) => {
          if (end.pointerId !== pointerId) return;
          cleanup();
          onHeightChange(latest);
        };
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onEnd);
        handle.addEventListener("pointercancel", onEnd);
      },
      [dock, draftHeight, draftWidth, onHeightChange, onWidthChange],
    );

    const startSplitResize = useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        event.stopPropagation();
        const body = terminalBodyRef.current;
        if (!body) return;
        const handle = event.currentTarget;
        const pointerId = event.pointerId;
        handle.setPointerCapture(pointerId);

        const update = (clientX: number) => {
          const rect = body.getBoundingClientRect();
          if (rect.width <= 0) return;
          const next = Math.min(0.7, Math.max(0.3, (clientX - rect.left) / rect.width));
          onSplitRatioChange(next);
        };
        update(event.clientX);

        const cleanup = () => {
          handle.removeEventListener("pointermove", onMove);
          handle.removeEventListener("pointerup", onEnd);
          handle.removeEventListener("pointercancel", onEnd);
          if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
        };
        const onMove = (move: PointerEvent) => {
          if (move.pointerId !== pointerId) return;
          update(move.clientX);
        };
        const onEnd = (end: PointerEvent) => {
          if (end.pointerId !== pointerId) return;
          cleanup();
        };
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onEnd);
        handle.addEventListener("pointercancel", onEnd);
      },
      [onSplitRatioChange],
    );

    const panelStyle =
      open && !maximized
        ? dock === "right"
          ? undefined
          : { height: draftHeight }
        : undefined;
    const dockTarget = dock === "right" ? "bottom" : "right";
    const dockTitle =
      dockTarget === "right" ? t("terminal.dockRight") : t("terminal.dockBottom");
    const splitMode = splitOpen && Boolean(rightTab);
    // Use CSS variables instead of wrapper columns so terminal-instance divs
    // stay direct children of terminal-body across split toggles.
    const splitLayoutStyle = splitMode
      ? ({
          "--terminal-split-ratio": String(splitRatio),
          "--terminal-split-left": `${splitRatio * 100}%`,
          "--terminal-split-right": `${(1 - splitRatio) * 100}%`,
        } as React.CSSProperties)
      : undefined;
    const focusedTabId =
      focusedGroup === "right" && rightTab
        ? rightTab.id
        : splitMode
          ? splitLeftTabId
          : state.activeTabId;

    useEffect(() => {
      focusedTabIdRef.current = focusedTabId;
    }, [focusedTabId]);

    // Clearing attention when a session gains focus.
    useEffect(() => {
      if (focusedTabId) dispatch({ type: "clearAttention", tabId: focusedTabId });
    }, [focusedTabId]);

    const focusedKind = useMemo(() => {
      const tab = state.tabs.find((item) => item.id === focusedTabId);
      return tab?.kind ?? null;
    }, [focusedTabId, state.tabs]);

    const attachMention = useCallback(
      (mention: string | null): boolean => {
        if (!mention) return false;
        const tabId = focusedTabIdRef.current;
        if (!tabId) return false;
        const tab = state.tabs.find((item) => item.id === tabId);
        if (!tab || !tab.running) return false;
        if (tab.kind !== "claude" && tab.kind !== "codex") return false;
        const sessionId = sessionByTabRef.current.get(tabId);
        if (!sessionId) return false;
        void terminalWrite(sessionId, mention);
        handlesRef.current.get(tabId)?.focus();
        return true;
      },
      [state.tabs],
    );

    useImperativeHandle(
      ref,
      (): TerminalPanelHandle => ({
        hasFocusedAgent: () =>
          focusedKind === "claude" || focusedKind === "codex",
        attachActiveItem: () => attachMention(activeItemMention(activeContext, attachStyle)),
        attachPath: (relPath, absPath) =>
          attachMention(pathMention(relPath, absPath, attachStyle)),
      }),
      [activeContext, attachMention, attachStyle, focusedKind],
    );

    const contextChip = useMemo(
      () => describeActiveContextChip(activeContext, { focusedKind }),
      [activeContext, focusedKind],
    );

    const handleTerminalKeyDownCapture = useCallback(
      (event: React.KeyboardEvent<HTMLElement>) => {
        const isMac = navigator.platform.toLowerCase().includes("mac");
        const mod = isMac ? event.metaKey : event.ctrlKey;
        if (!mod || event.altKey) return;
        const lower = event.key.toLowerCase();
        if (lower === "w" && !event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          if (focusedTabId) closeTab(focusedTabId);
          return;
        }
        if (lower === "t" && !event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          void launch(settings.terminal.autoLaunch ?? "shell", focusedGroup);
          return;
        }
        if (!event.shiftKey && /^[1-9]$/.test(event.key)) {
          const target = selectTerminalTabByIndex(activeTaskTabs, Number(event.key));
          if (target) {
            event.preventDefault();
            event.stopPropagation();
            if (splitOpen && rightTab?.id === target.id) {
              setFocusedGroup("right");
            } else {
              dispatch({ type: "switch", tabId: target.id });
              setFocusedGroup("left");
            }
            handlesRef.current.get(target.id)?.focus();
          }
        }
      },
      [
        activeTaskTabs,
        closeTab,
        focusedGroup,
        focusedTabId,
        launch,
        rightTab,
        settings.terminal.autoLaunch,
        splitOpen,
      ],
    );

    const handleTerminalMouseMoveCapture = useCallback(
      (event: React.MouseEvent<HTMLDivElement>) => {
        const focusedSession = focusedTabIdRef.current
          ? sessionByTabRef.current.get(focusedTabIdRef.current)
          : undefined;
        const mouseModeActive = focusedSession
          ? mouseModesBySessionRef.current.get(focusedSession) ?? false
          : false;
        if (!shouldSuppressTerminalHoverMouseEvent(event.nativeEvent, mouseModeActive)) return;
        event.preventDefault();
        event.stopPropagation();
      },
      [],
    );

    // Stable per-session handlers, created once and cached. Passing fresh
    // closures here would defeat NativeTerminalView's memo() and re-render
    // every grid on any TerminalPanel state change.
    const getSessionHandlers = useCallback((sessionId: string) => {
      const cache = sessionHandlersRef.current;
      let handlers = cache.get(sessionId);
      if (!handlers) {
        handlers = {
          onInput: (command: TerminalInputCommand) => {
            void terminalInput(sessionId, command);
          },
          onResize: (cols: number, rows: number) => {
            void terminalResize(sessionId, cols, rows).catch(() => {
              // Session may exit between measurement and IPC delivery.
            });
          },
          onScroll: (delta: number) => {
            void terminalScroll(sessionId, delta).catch(() => {
              // Session may exit before the scroll command lands.
            });
          },
        };
        cache.set(sessionId, handlers);
      }
      return handlers;
    }, []);

    const renderTerminalTab = (tab: (typeof state.tabs)[number]) => {
      const className = tab.id === focusedTabId ? "terminal-tab active" : "terminal-tab";
      const status = terminalTabStatus(tab);
      const relaunchable = isRelaunchableTab(tab);
      return (
        <div key={tab.id} className={className}>
          <button
            type="button"
            className="terminal-tab-main"
            onClick={() => {
              if (relaunchable) {
                relaunchTab(tab.id);
                return;
              }
              if (splitOpen && rightTab?.id === tab.id) {
                setFocusedGroup("right");
                return;
              }
              dispatch({ type: "switch", tabId: tab.id });
              setFocusedGroup("left");
              handlesRef.current.get(tab.id)?.focus();
            }}
            title={
              relaunchable
                ? tab.agentSessionId
                  ? t("terminal.session.resume")
                  : t("terminal.session.relaunch")
                : tab.title
            }
          >
            <span className={`terminal-status-dot ${status}`} />
            <span>{tab.title}</span>
          </button>
          <button
            type="button"
            className="terminal-tab-close"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              closeTab(tab.id);
            }}
            aria-label={t("terminal.tab.close", { title: tab.title })}
            title={t("terminal.tab.close", { title: tab.title })}
          >
            <X size={13} />
          </button>
        </div>
      );
    };

    const renderTaskRow = (task: (typeof state.tasks)[number]) => {
      const taskTabs = tabsForTask(state, task.id);
      const status = terminalTaskStatus(taskTabs);
      const isActive = task.id === activeTaskId;
      const className = [
        "terminal-task-row",
        isActive ? "active" : null,
        taskTabs.some((tab) => tab.attention || tab.agentStatus === "needs-input")
          ? "attention"
          : null,
      ]
        .filter(Boolean)
        .join(" ");
      const cwdLabel = pathBaseName(task.cwd);
      const switchTask = () => dispatch({ type: "switchTask", taskId: task.id });
      return (
        <div
          key={task.id}
          className={className}
          role="option"
          aria-selected={isActive}
          tabIndex={0}
          onClick={switchTask}
          onDoubleClick={() => setRenamingTaskId(task.id)}
          onKeyDown={(event) => {
            if (event.currentTarget !== event.target) return;
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            switchTask();
          }}
          title={task.cwd ?? task.name}
        >
          <span className={`terminal-status-dot ${status}`} />
          {renamingTaskId === task.id ? (
            <input
              className="terminal-task-rename"
              defaultValue={task.name}
              autoFocus
              aria-label={t("terminal.task.rename")}
              onClick={(event) => event.stopPropagation()}
              onBlur={(event) => {
                dispatch({ type: "renameTask", taskId: task.id, name: event.target.value });
                setRenamingTaskId(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  dispatch({
                    type: "renameTask",
                    taskId: task.id,
                    name: (event.target as HTMLInputElement).value,
                  });
                  setRenamingTaskId(null);
                } else if (event.key === "Escape") {
                  setRenamingTaskId(null);
                }
              }}
            />
          ) : (
            <span className="terminal-task-body">
              <span className="terminal-task-name">{task.name}</span>
              {cwdLabel ? <span className="terminal-task-cwd">{cwdLabel}</span> : null}
            </span>
          )}
          <button
            type="button"
            className="terminal-task-close"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              closeTask(task.id);
            }}
            aria-label={t("terminal.task.close", { name: task.name })}
            title={t("terminal.task.close", { name: task.name })}
          >
            <X size={13} />
          </button>
        </div>
      );
    };

    return (
      <section
        className={
          open
            ? maximized
              ? `terminal-panel dock-${dock} maximized`
              : `terminal-panel dock-${dock}`
            : `terminal-panel dock-${dock} collapsed`
        }
        style={panelStyle}
        onKeyDownCapture={handleTerminalKeyDownCapture}
      >
        <div className="terminal-resize-handle" onPointerDown={startResize} />
        <header className="terminal-header">
          <button
            type="button"
            className="terminal-title"
            onClick={toggleOpen}
            aria-expanded={open}
            title={open ? t("terminal.collapse") : t("terminal.expand")}
            aria-label={open ? t("terminal.collapse") : t("terminal.expand")}
          >
            {dock === "right" ? <PanelRight size={14} /> : <PanelBottom size={14} />}
            <span>{t("terminal.title")}</span>
            {open ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          </button>
          <div className="terminal-launchers" role="group" aria-label={t("terminal.launchers")}>
            {TERMINAL_LAUNCHERS.map((launcher) => {
              const enabled = settings.terminal.launchers[launcher.id]?.enabled ?? true;
              return (
                <button
                  key={launcher.id}
                  type="button"
                  disabled={!canRunTerminal || !enabled}
                  onClick={() => void launch(launcher.id, focusedGroup)}
                  title={
                    canRunTerminal
                      ? terminalCommandPreview(launcher.id, headerCwd ?? "")
                      : t("terminal.tauriRequired")
                  }
                  aria-label={t(launcher.titleKey)}
                >
                  {launcher.id === "codex" ? <Code2 size={13} /> : <SquareTerminal size={13} />}
                  <span>{t(launcher.titleKey)}</span>
                </button>
              );
            })}
          </div>
          <div className="terminal-header-right">
            <button
              type="button"
              className="terminal-context-chip"
              disabled={!contextChip.enabled}
              onClick={() => attachMention(activeItemMention(activeContext, attachStyle))}
              title={
                contextChip.enabled
                  ? t("terminal.context.attach", { item: contextChip.label })
                  : t("terminal.context.disabled")
              }
              aria-label={t("terminal.context.attach", { item: contextChip.label })}
            >
              <FileText size={12} />
              <span>{contextChip.label}</span>
            </button>
            <div className="terminal-cwd" title={headerCwd ?? t("terminal.cwd.none")}>
              {headerCwd ?? t("terminal.cwd.none")}
            </div>
          </div>
          <button
            type="button"
            className="terminal-icon-button"
            onClick={() => onDockChange(dockTarget)}
            aria-label={dockTitle}
            title={dockTitle}
          >
            {dockTarget === "right" ? <PanelRight size={14} /> : <PanelBottom size={14} />}
          </button>
          <button
            type="button"
            className="terminal-icon-button"
            onClick={() => onMaximizedChange(!maximized)}
            aria-label={maximized ? t("terminal.restore") : t("terminal.maximize")}
            title={maximized ? t("terminal.restore") : t("terminal.maximize")}
          >
            {maximized ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
        </header>

        {/* Workspace (sidebar + main) stays mounted across collapse so PTY-backed
            panes keep their React state. Visibility is controlled via [hidden]. */}
        <div
          className={
            sidebarCollapsed ? "terminal-workspace sidebar-collapsed" : "terminal-workspace"
          }
          hidden={!open}
        >
          <aside
            className={
              sidebarCollapsed
                ? "terminal-session-sidebar collapsed"
                : "terminal-session-sidebar"
            }
          >
            <div className="terminal-session-sidebar-header">
              <button
                type="button"
                className="terminal-sidebar-btn"
                onClick={() => setSidebarCollapsed((value) => !value)}
                aria-label={
                  sidebarCollapsed ? t("terminal.sidebar.expand") : t("terminal.sidebar.collapse")
                }
                title={
                  sidebarCollapsed ? t("terminal.sidebar.expand") : t("terminal.sidebar.collapse")
                }
              >
                {sidebarCollapsed ? <PanelLeftOpen size={14} /> : <PanelLeftClose size={14} />}
              </button>
              {!sidebarCollapsed ? (
                <span className="terminal-session-sidebar-title">{t("terminal.tasks")}</span>
              ) : null}
              <button
                type="button"
                className="terminal-sidebar-btn"
                disabled={!canRunTerminal}
                onClick={createTask}
                aria-label={t("terminal.task.new")}
                title={t("terminal.task.new")}
              >
                <Plus size={14} />
              </button>
            </div>
            <div className="terminal-task-list" role="listbox" aria-label={t("terminal.tasks")}>
              {state.tasks.length === 0 ? (
                <span className="terminal-task-empty">{t("terminal.tasks.empty")}</span>
              ) : (
                state.tasks.map((task) => renderTaskRow(task))
              )}
            </div>
          </aside>

          <div className="terminal-main">
            <div
              className="terminal-tabs"
              role="tablist"
              aria-label={t("terminal.tabs")}
            >
              {activeTaskTabs.length === 0 ? (
                <span className="terminal-tab-placeholder">{t("terminal.empty")}</span>
              ) : (
                activeTaskTabs.map((tab) => renderTerminalTab(tab))
              )}
            </div>
            <div
              className={splitMode ? "terminal-body split" : "terminal-body"}
              style={splitLayoutStyle}
              ref={terminalBodyRef}
            >
              {!canRunTerminal ? (
                <div className="terminal-empty">{t("terminal.tauriRequired")}</div>
              ) : activeTaskTabs.length === 0 ? (
                <div className="terminal-empty">{t("terminal.empty.detail")}</div>
              ) : null}
              {/* Flat sibling list under terminal-body across ALL tasks.
                  Non-active-task instances are hidden while PTYs stay alive. */}
              {state.tabs.map((tab) => {
                const inActiveTask = tab.taskId === activeTaskId;
                const isRight = splitMode && rightTabId === tab.id;
                const isLeftActive =
                  !isRight &&
                  (splitMode ? splitLeftTabId === tab.id : state.activeTabId === tab.id);
                const isVisible = inActiveTask && (isRight || isLeftActive);
                const isFocused =
                  isVisible &&
                  (splitMode
                    ? isRight
                      ? focusedGroup === "right"
                      : focusedGroup === "left"
                    : state.activeTabId === tab.id);
                const sessionId = tab.sessionId ?? sessionByTabRef.current.get(tab.id) ?? null;
                const handlers = sessionId ? getSessionHandlers(sessionId) : null;
                const className = [
                  "terminal-instance",
                  isVisible ? "active" : null,
                  splitMode ? (isRight ? "pane-right" : "pane-left") : null,
                  isFocused ? "focused" : null,
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <div
                    key={tab.id}
                    className={className}
                    onMouseMoveCapture={handleTerminalMouseMoveCapture}
                    onPointerDown={() => setFocusedGroup(isRight ? "right" : "left")}
                  >
                    {isVisible ? (
                      <button
                        type="button"
                        className="terminal-pane-close"
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          closeTab(tab.id);
                        }}
                        title={t("terminal.tab.close", { title: tab.title })}
                        aria-label={t("terminal.tab.close", { title: tab.title })}
                      >
                        <X size={13} />
                      </button>
                    ) : null}
                    <div className="terminal-instance-host">
                      {sessionId && handlers ? (
                        <NativeTerminalView
                          ref={(handle) => {
                            if (handle) {
                              handlesRef.current.set(tab.id, handle);
                            } else {
                              handlesRef.current.delete(tab.id);
                            }
                          }}
                          sessionId={sessionId}
                          frame={framesBySession[sessionId] ?? null}
                          active={isVisible}
                          focused={isFocused}
                          resizeReady={resizeReadySessions[sessionId] === true}
                          inputLabel={t("terminal.input")}
                          onInput={handlers.onInput}
                          onResize={handlers.onResize}
                          onScroll={handlers.onScroll}
                        />
                      ) : null}
                    </div>
                  </div>
                );
              })}
              {!splitMode && activeTab && isRelaunchableTab(activeTab) ? (
                <div className="terminal-relaunch-overlay">
                  <button
                    type="button"
                    className="terminal-relaunch-button"
                    onClick={() => relaunchTab(activeTab.id)}
                  >
                    {activeTab.agentSessionId
                      ? t("terminal.session.resume")
                      : t("terminal.session.relaunch")}
                  </button>
                </div>
              ) : null}
              {splitMode ? (
                <div
                  className="terminal-split-resize-handle"
                  role="separator"
                  aria-orientation="vertical"
                  aria-valuemin={30}
                  aria-valuemax={70}
                  aria-valuenow={Math.round(splitRatio * 100)}
                  onPointerDown={startSplitResize}
                />
              ) : null}
            </div>
          </div>
        </div>
        {open && error ? <div className="terminal-error">{error}</div> : null}
      </section>
    );
  }),
);

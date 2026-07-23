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
  Search,
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
  terminalAck,
  terminalClear,
  terminalCopySelection,
  terminalInputBatch,
  terminalKill,
  terminalRequestFull,
  terminalResize,
  terminalSearch,
  terminalSelection,
  terminalSetVisibility,
  terminalScroll,
  terminalSpawn,
  terminalText,
  decodeTerminalWireFrame,
  type TerminalFrame,
  type TerminalInputCommand,
  type TerminalSpawnHandle,
  type TerminalStreamMessage,
  type TerminalSelectionCommand,
  type TerminalSearchDirection,
  type TerminalSearchMatch,
} from "../lib/api";
import { clipboardReadText, clipboardWriteText } from "../lib/clipboard";
import { useTranslation } from "../lib/i18n";
import type { MaruSettings, TerminalDock } from "../lib/settings";
import { terminalShortcutActionForEvent } from "../lib/terminalShortcuts";
import { TerminalInputPump } from "../lib/terminalInputPump";
import { NativeTerminalView, type NativeTerminalViewHandle } from "./NativeTerminalView";
import {
  activeItemMention,
  buildAgentContextArgs,
  buildAgentResumeArgs,
  buildMaruContextEnv,
  createTerminalTab,
  createTerminalTask,
  describeActiveContextChip,
  EMPTY_TERMINAL_STATE,
  isRelaunchableTab,
  loadPersistedTerminalState,
  mergeMaruTerminalEnv,
  pathMention,
  persistTerminalState,
  resolveExistingLaunchTaskId,
  selectTerminalSplitLeftTabId,
  selectTerminalTabByIndex,
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
  settings: MaruSettings;
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

interface TerminalStatusEvent {
  sessionId: string;
  status: string;
  agentSessionId?: string | null;
}

export interface TerminalFocusState {
  open: boolean;
  searchOpen: boolean;
  renamingTaskId: string | null;
}

export interface TerminalStreamCursor {
  generation: string;
  lastSeq: number;
}

export function terminalFrameDisposition(
  current: TerminalStreamCursor | null | undefined,
  generation: string,
  seq: number,
  prevSeq: number,
  patch: boolean,
): "apply" | "duplicate" | "resync" {
  if (current?.generation === generation && seq <= current.lastSeq) return "duplicate";
  if (patch && (!current || current.generation !== generation || current.lastSeq !== prevSeq)) {
    return "resync";
  }
  return "apply";
}

const MIN_HEIGHT = 160;
const MAX_HEIGHT = 520;
const MIN_WIDTH = 320;
const MIN_MAIN_WIDTH = 360;

export function shouldFocusTerminalInput(state: TerminalFocusState): boolean {
  return state.open && !state.searchOpen && state.renamingTaskId === null;
}

/** Decides the window-activation focus repair. `ownsFocus` (the activating
 *  click already DOM-focused this terminal's textarea) must repair even with
 *  no seeded tab: on first-ever first-mouse activation the textarea is
 *  DOM-focused but key-dead, and treating it as "someone else has focus"
 *  is exactly the bug. Without ownership, keep the strict no-steal rules. */
export function terminalActivationFocusAction(args: {
  seededTabId: string | null;
  focusedTabId: string | null;
  ownsFocus: boolean;
  activeElementIsBody: boolean;
  focusState: TerminalFocusState;
}): "reattach" | "none" {
  if (!args.focusedTabId) return "none";
  if (!shouldFocusTerminalInput(args.focusState)) return "none";
  if (!args.ownsFocus) {
    if (args.seededTabId !== args.focusedTabId) return "none";
    if (!args.activeElementIsBody) return "none";
  }
  return "reattach";
}

export function cancelTerminalLayoutRefresh(
  rafRef: React.MutableRefObject<number | null>,
  cancelAnimationFrameFn: (handle: number) => void = window.cancelAnimationFrame,
): boolean {
  if (rafRef.current == null) return false;
  cancelAnimationFrameFn(rafRef.current);
  rafRef.current = null;
  return true;
}

export function refreshFocusedTerminal(
  handle: NativeTerminalViewHandle | null | undefined,
  state: TerminalFocusState,
): boolean {
  if (!handle || !state.open) return false;
  handle.refreshLayout({ focus: false });
  if (shouldFocusTerminalInput(state)) handle.focus();
  return true;
}

function pathBaseName(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.closest(".native-terminal-view")) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName.toLowerCase();
  return tag === "input" || tag === "textarea" || tag === "select";
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
    const [draftSplitRatio, setDraftSplitRatio] = useState(splitRatio);
    const [rightTabId, setRightTabId] = useState<string | null>(null);
    const [focusedGroup, setFocusedGroup] = useState<"left" | "right">("left");
    const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
    const [renamingTaskId, setRenamingTaskId] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const handlesRef = useRef<Map<string, NativeTerminalViewHandle>>(new Map());
    const terminalBodyRef = useRef<HTMLDivElement | null>(null);
    const searchInputRef = useRef<HTMLInputElement | null>(null);
    const sessionByTabRef = useRef<Map<string, string>>(new Map());
    const tabBySessionRef = useRef<Map<string, string>>(new Map());
    const generationBySessionRef = useRef<Map<string, string>>(new Map());
    const channelsBySessionRef = useRef<Map<string, TerminalSpawnHandle["channel"]>>(new Map());
    const streamSeqBySessionRef = useRef<Map<string, { generation: string; lastSeq: number }>>(
      new Map(),
    );
    const pendingFramesRef = useRef<Map<string, TerminalStreamMessage[]>>(new Map());
    const visibilityBySessionRef = useRef<Map<string, boolean>>(new Map());
    // Bumped (paced) when a visibility send fails, re-running the visibility
    // effect: a ref delete alone never re-triggers it, and a hidden->visible
    // send that stays lost parks the backend frame emitter until refocus.
    const [visibilityRetryNonce, setVisibilityRetryNonce] = useState(0);
    const inputPumpsRef = useRef<Map<string, TerminalInputPump>>(new Map());
    const cancelledSessionsRef = useRef<Set<string>>(new Set());
    const disposedRef = useRef(false);
    const handleRefCallbacksRef = useRef<
      Map<string, (handle: NativeTerminalViewHandle | null) => void>
    >(new Map());
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
          onFocusOwnership: () => void;
          onSelection: (command: TerminalSelectionCommand) => Promise<void>;
          onCopySelection: () => Promise<string>;
          onContextCopy: () => void;
          onContextPaste: () => void;
          onContextSelectAll: () => void;
          onContextFind: () => void;
          onContextClear: () => void;
          canForwardMouse: () => boolean;
        }
      >
    >(new Map());
    // Whether each session's program has requested a mouse mode; lets us stop
    // suppressing hover so TUIs (claude/codex) receive it.
    const mouseModesBySessionRef = useRef<Map<string, boolean>>(new Map());
    const [searchOpen, setSearchOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState("");
    const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
    const [searchMatchesBySession, setSearchMatchesBySession] = useState<
      Record<string, TerminalSearchMatch | null>
    >({});
    const [resizeReadySessions, setResizeReadySessions] = useState<Record<string, true>>({});
    const seqRef = useRef(1);
    const taskSeqRef = useRef(1);
    const autoLaunchRef = useRef(false);
    const handledLaunchRequestRef = useRef<number | null>(null);
    const focusedTabIdRef = useRef<string | null>(null);
    const lastActualFocusTabRef = useRef<string | null>(null);
    const restoreFocusTabRef = useRef<string | null>(null);
    const appActiveRef = useRef(
      typeof document === "undefined" ? true : document.hasFocus(),
    );
    const suppressTerminalMouseUntilRef = useRef(0);
    // Lifecycle of a pointer gesture that began while the app was inactive:
    // "down" while pressed, "done" once released. Lets restore() skip arming
    // the mouse grace when native activation lands after the activating
    // click's pointerup — arming then would eat a fast second TUI click.
    const inactiveGestureRef = useRef<"none" | "down" | "done">("none");
    const layoutRefreshRafRef = useRef<number | null>(null);
    const terminalFocusStateRef = useRef<TerminalFocusState>({
      open,
      searchOpen,
      renamingTaskId,
    });

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
      setDraftSplitRatio(splitRatio);
    }, [splitRatio]);

    const applyStreamFrame = useCallback(
      (
        message: Extract<TerminalStreamMessage, { kind: "frame" }>,
        handle: NativeTerminalViewHandle,
      ) => {
        const { sessionId, generation, seq, prevSeq } = message;
        const frame = decodeTerminalWireFrame(message.frame);
        const expectedGeneration = generationBySessionRef.current.get(sessionId);
        if (expectedGeneration && expectedGeneration !== generation) return;
        const current = streamSeqBySessionRef.current.get(sessionId);
        const disposition = terminalFrameDisposition(
          current,
          generation,
          seq,
          prevSeq,
          Boolean(frame.dirtyRows),
        );
        if (disposition === "duplicate") {
          void terminalAck(sessionId, generation, seq).catch(() => {});
          return;
        }
        const applied = disposition === "apply" && handle.applyFrame(frame);
        // Ack regardless (credit is about delivery, not application), but only
        // advance the cursor on a frame that actually landed. Otherwise a
        // dropped patch followed by a failed requestFull would let the next
        // patch look contiguous and paper over the missing rows for good.
        if (applied) streamSeqBySessionRef.current.set(sessionId, { generation, lastSeq: seq });
        void terminalAck(sessionId, generation, seq).catch(() => {});
        if (!applied) {
          void terminalRequestFull(sessionId, generation).catch(() => {});
          return;
        }
        const mouse = frame.mouse;
        mouseModesBySessionRef.current.set(
          sessionId,
          Boolean(mouse && (mouse.click || mouse.motion || mouse.drag)),
        );
        const tabId = tabBySessionRef.current.get(sessionId);
        if (tabId && tabId !== focusedTabIdRef.current) {
          dispatch({ type: "markAttention", sessionId });
        }
      },
      [],
    );

    const handleTerminalStreamMessage = useCallback(
      (message: TerminalStreamMessage) => {
        if (disposedRef.current) {
          if (message.kind === "frame") {
            void terminalAck(message.sessionId, message.generation, message.seq).catch(() => {});
          }
          return;
        }
        const cancelled = cancelledSessionsRef.current.has(message.sessionId);
        if (cancelled && message.kind === "frame") {
          void terminalAck(message.sessionId, message.generation, message.seq).catch(() => {});
          return;
        }
        if (cancelled && message.kind === "fault") return;
        const expectedGeneration = generationBySessionRef.current.get(message.sessionId);
        if (expectedGeneration && expectedGeneration !== message.generation) return;
        if (message.kind === "frame") {
          const tabId = tabBySessionRef.current.get(message.sessionId);
          const handle = tabId ? handlesRef.current.get(tabId) : null;
          if (!handle) {
            const pending = pendingFramesRef.current.get(message.sessionId) ?? [];
            pending.push(message);
            pendingFramesRef.current.set(message.sessionId, pending.slice(-2));
            // Ack even while buffered: the backend only allows two unacked
            // frames, so withholding acks here stalls the emitter permanently
            // if the handle attaches late. A seq gap resyncs via requestFull.
            void terminalAck(message.sessionId, message.generation, message.seq).catch(() => {});
            return;
          }
          applyStreamFrame(message, handle);
          return;
        }
        if (message.kind === "fault") {
          setError(message.message);
          return;
        }

        const tabId = tabBySessionRef.current.get(message.sessionId);
        if (tabId) sessionByTabRef.current.delete(tabId);
        tabBySessionRef.current.delete(message.sessionId);
        generationBySessionRef.current.delete(message.sessionId);
        channelsBySessionRef.current.delete(message.sessionId);
        streamSeqBySessionRef.current.delete(message.sessionId);
        pendingFramesRef.current.delete(message.sessionId);
        visibilityBySessionRef.current.delete(message.sessionId);
        inputPumpsRef.current.get(message.sessionId)?.fail();
        inputPumpsRef.current.delete(message.sessionId);
        cancelledSessionsRef.current.delete(message.sessionId);
        sessionHandlersRef.current.delete(message.sessionId);
        mouseModesBySessionRef.current.delete(message.sessionId);
        setResizeReadySessions((current) => {
          const next = { ...current };
          delete next[message.sessionId];
          return next;
        });
        if (!cancelled) {
          dispatch({
            type: "exit",
            sessionId: message.sessionId,
            exitCode: message.exitCode,
          });
        }
      },
      [applyStreamFrame],
    );

    useEffect(() => {
      if (!canRunTerminal) return;
      let disposed = false;
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

      statusPromise.catch(() => {
        // The status channel is optional (agent hooks may be disabled).
      });

      return () => {
        disposed = true;
        // Wait for the listen() promises to resolve before unsubscribing,
        // otherwise we leak the registration.
        void statusPromise.then((off) => off()).catch(() => {});
      };
    }, [canRunTerminal]);

    useEffect(() => {
      disposedRef.current = false;
      return () => {
        disposedRef.current = true;
        cancelTerminalLayoutRefresh(layoutRefreshRafRef);
        for (const sessionId of sessionByTabRef.current.values()) {
          void terminalKill(sessionId);
        }
        for (const pump of inputPumpsRef.current.values()) pump.fail();
        inputPumpsRef.current.clear();
        channelsBySessionRef.current.clear();
        generationBySessionRef.current.clear();
        streamSeqBySessionRef.current.clear();
        pendingFramesRef.current.clear();
        visibilityBySessionRef.current.clear();
        cancelledSessionsRef.current.clear();
        sessionHandlersRef.current.clear();
        mouseModesBySessionRef.current.clear();
        handleRefCallbacksRef.current.clear();
        handlesRef.current.clear();
      };
    }, []);

    // Persist task + session metadata so the sidebar repopulates with
    // relaunchable entries after a restart (PTYs themselves cannot survive).
    useEffect(() => {
      const id = window.setTimeout(() => {
        persistTerminalState(state);
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
        // Register the session↔tab mapping BEFORE spawning so the Channel can
        // deliver the first frame immediately after the backend accepts it.
        sessionByTabRef.current.set(tabId, sessionId);
        tabBySessionRef.current.set(sessionId, tabId);
        const inputPump = new TerminalInputPump(
          async (clientSeq, commands) => {
            const generation = generationBySessionRef.current.get(sessionId);
            if (!generation) throw new Error("terminal_session_not_ready");
            await terminalInputBatch(sessionId, generation, clientSeq, commands);
          },
          (inputError) => {
            setError(inputError instanceof Error ? inputError.message : String(inputError));
          },
        );
        inputPumpsRef.current.set(sessionId, inputPump);
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
          const contextEnv = buildMaruContextEnv(activeContext, sessionId, injectContext);
          const contextArgs = buildAgentContextArgs(kind, activeContext, injectContext);
          const spawn = await terminalSpawn(
            sessionId,
            kind,
            resolvedCwd,
            {
              command: request?.command ?? launcher.command ?? null,
              extraArgs: [...contextArgs, ...(request?.extraArgs ?? launcher.args ?? [])],
              extraEnv: mergeMaruTerminalEnv(request?.extraEnv, contextEnv),
              cols: 120,
              rows: 30,
            },
            handleTerminalStreamMessage,
          );
          const cancelled =
            disposedRef.current ||
            cancelledSessionsRef.current.has(sessionId) ||
            sessionByTabRef.current.get(tabId) !== sessionId ||
            tabBySessionRef.current.get(sessionId) !== tabId;
          if (cancelled) {
            pendingFramesRef.current.delete(sessionId);
            visibilityBySessionRef.current.delete(sessionId);
            inputPump.fail();
            inputPumpsRef.current.delete(sessionId);
            await terminalSetVisibility(sessionId, spawn.generation, false).catch(() => {});
            await terminalKill(sessionId).catch(() => {});
            return;
          }
          generationBySessionRef.current.set(sessionId, spawn.generation);
          channelsBySessionRef.current.set(sessionId, spawn.channel);
          inputPump.ready();
          setResizeReadySessions((current) => ({
            ...current,
            [sessionId]: true,
          }));
          window.requestAnimationFrame(() => {
            // Spawn takes long enough for the user to move on: only claim focus
            // if this tab is still the focused one and no rename/search input
            // owns the caret, otherwise launching steals keystrokes mid-typing.
            if (focusedTabIdRef.current !== tabId) return;
            if (!shouldFocusTerminalInput(terminalFocusStateRef.current)) return;
            handlesRef.current.get(tabId)?.focus();
          });
        } catch (err) {
          const cancelled =
            disposedRef.current || cancelledSessionsRef.current.delete(sessionId);
          sessionByTabRef.current.delete(tabId);
          tabBySessionRef.current.delete(sessionId);
          generationBySessionRef.current.delete(sessionId);
          channelsBySessionRef.current.delete(sessionId);
          visibilityBySessionRef.current.delete(sessionId);
          inputPumpsRef.current.get(sessionId)?.fail();
          inputPumpsRef.current.delete(sessionId);
          if (cancelled) return;
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
        handleTerminalStreamMessage,
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
          cancelledSessionsRef.current.add(sessionId);
          const generation = generationBySessionRef.current.get(sessionId);
          if (generation) void terminalSetVisibility(sessionId, generation, false).catch(() => {});
          void terminalKill(sessionId).catch((killError) => {
            setError(killError instanceof Error ? killError.message : String(killError));
          });
          sessionByTabRef.current.delete(tabId);
          tabBySessionRef.current.delete(sessionId);
          inputPumpsRef.current.get(sessionId)?.fail();
          inputPumpsRef.current.delete(sessionId);
          sessionHandlersRef.current.delete(sessionId);
          mouseModesBySessionRef.current.delete(sessionId);
          visibilityBySessionRef.current.delete(sessionId);
          setResizeReadySessions((current) => {
            const next = { ...current };
            delete next[sessionId];
            return next;
          });
        }
        handlesRef.current.delete(tabId);
        handleRefCallbacksRef.current.delete(tabId);

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
          cancelledSessionsRef.current.add(sessionId);
          const generation = generationBySessionRef.current.get(sessionId);
          if (generation) void terminalSetVisibility(sessionId, generation, false).catch(() => {});
          void terminalKill(sessionId).catch((killError) => {
            setError(killError instanceof Error ? killError.message : String(killError));
          });
          sessionByTabRef.current.delete(tab.id);
          tabBySessionRef.current.delete(sessionId);
          inputPumpsRef.current.get(sessionId)?.fail();
          inputPumpsRef.current.delete(sessionId);
          sessionHandlersRef.current.delete(sessionId);
          mouseModesBySessionRef.current.delete(sessionId);
          visibilityBySessionRef.current.delete(sessionId);
          setResizeReadySessions((current) => {
            const next = { ...current };
            delete next[sessionId];
            return next;
          });
        }
        handlesRef.current.delete(tab.id);
        handleRefCallbacksRef.current.delete(tab.id);
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
          let resizeRaf: number | null = null;
          handle.setPointerCapture(pointerId);

          const onMove = (move: PointerEvent) => {
            if (move.pointerId !== pointerId) return;
            const viewportMax = Math.max(MIN_WIDTH, window.innerWidth - MIN_MAIN_WIDTH);
            const next = Math.min(
              viewportMax,
              Math.max(MIN_WIDTH, startWidth + startX - move.clientX),
            );
            latest = next;
            if (resizeRaf == null) {
              resizeRaf = window.requestAnimationFrame(() => {
                resizeRaf = null;
                setDraftWidth(latest);
                onWidthChange(latest);
              });
            }
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
            if (resizeRaf != null) window.cancelAnimationFrame(resizeRaf);
            setDraftWidth(latest);
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
        let resizeRaf: number | null = null;
        handle.setPointerCapture(pointerId);

        const onMove = (move: PointerEvent) => {
          if (move.pointerId !== pointerId) return;
          const next = Math.min(
            MAX_HEIGHT,
            Math.max(MIN_HEIGHT, startHeight + startY - move.clientY),
          );
          latest = next;
          if (resizeRaf == null) {
            resizeRaf = window.requestAnimationFrame(() => {
              resizeRaf = null;
              setDraftHeight(latest);
            });
          }
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
          if (resizeRaf != null) window.cancelAnimationFrame(resizeRaf);
          setDraftHeight(latest);
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
        let latest = draftSplitRatio;
        let resizeRaf: number | null = null;
        handle.setPointerCapture(pointerId);

        const update = (clientX: number) => {
          const rect = body.getBoundingClientRect();
          if (rect.width <= 0) return;
          latest = Math.min(0.7, Math.max(0.3, (clientX - rect.left) / rect.width));
          if (resizeRaf != null) return;
          resizeRaf = window.requestAnimationFrame(() => {
            resizeRaf = null;
            setDraftSplitRatio(latest);
          });
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
          if (resizeRaf != null) window.cancelAnimationFrame(resizeRaf);
          setDraftSplitRatio(latest);
          onSplitRatioChange(latest);
        };
        handle.addEventListener("pointermove", onMove);
        handle.addEventListener("pointerup", onEnd);
        handle.addEventListener("pointercancel", onEnd);
      },
      [draftSplitRatio, onSplitRatioChange],
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
          "--terminal-split-ratio": String(draftSplitRatio),
          "--terminal-split-left": `${draftSplitRatio * 100}%`,
          "--terminal-split-right": `${(1 - draftSplitRatio) * 100}%`,
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

    useEffect(() => {
      const visibleTabs = new Set<string>();
      if (open) {
        if (splitMode) {
          if (splitLeftTabId) visibleTabs.add(splitLeftTabId);
          if (rightTabId) visibleTabs.add(rightTabId);
        } else if (state.activeTabId) {
          visibleTabs.add(state.activeTabId);
        }
      }
      for (const tab of state.tabs) {
        const sessionId = sessionByTabRef.current.get(tab.id);
        if (!sessionId) continue;
        const generation = generationBySessionRef.current.get(sessionId);
        if (!generation) continue;
        const visible = visibleTabs.has(tab.id);
        if (visibilityBySessionRef.current.get(sessionId) === visible) continue;
        visibilityBySessionRef.current.set(sessionId, visible);
        // On failure, uncache and schedule a paced re-run so the value is
        // resent; caching a failed send would suppress the corrective update
        // forever. Only uncache while the entry still holds the value this
        // send attempted — a late failure must not evict a newer success.
        // Retries stop once the session's generation is torn down.
        void terminalSetVisibility(sessionId, generation, visible).catch(() => {
          if (visibilityBySessionRef.current.get(sessionId) !== visible) return;
          visibilityBySessionRef.current.delete(sessionId);
          window.setTimeout(() => setVisibilityRetryNonce((n) => n + 1), 250);
        });
      }
    }, [
      open,
      resizeReadySessions,
      rightTabId,
      splitLeftTabId,
      splitMode,
      state.activeTabId,
      state.tabs,
      visibilityRetryNonce,
    ]);

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
        if (!inputPumpsRef.current.get(sessionId)?.push({ type: "text", text: mention })) {
          return false;
        }
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
    const terminalContextMenuLabels = useMemo(
      () => ({
        copy: t("terminal.menu.copy"),
        paste: t("terminal.menu.paste"),
        selectAll: t("terminal.menu.selectAll"),
        find: t("terminal.menu.find"),
        clear: t("terminal.menu.clear"),
      }),
      [t],
    );

    const getFocusedTerminalHandle = useCallback(() => {
      const tabId = focusedTabIdRef.current;
      return tabId ? handlesRef.current.get(tabId) ?? null : null;
    }, []);

    const cancelFocusedTerminalRefresh = useCallback(() => {
      cancelTerminalLayoutRefresh(layoutRefreshRafRef);
    }, []);

    const scheduleFocusedTerminalRefresh = useCallback(() => {
      cancelFocusedTerminalRefresh();
      layoutRefreshRafRef.current = window.requestAnimationFrame(() => {
        layoutRefreshRafRef.current = null;
        refreshFocusedTerminal(getFocusedTerminalHandle(), terminalFocusStateRef.current);
      });
    }, [cancelFocusedTerminalRefresh, getFocusedTerminalHandle]);

    useEffect(() => {
      terminalFocusStateRef.current = { open, searchOpen, renamingTaskId };
    }, [open, renamingTaskId, searchOpen]);

    useEffect(() => {
      const onFocusIn = (event: FocusEvent) => {
        const target = event.target;
        if (!(target instanceof HTMLElement) || target === document.body) return;
        const terminal = target.closest<HTMLElement>(".native-terminal-view");
        if (terminal) {
          const sessionId = terminal.dataset.sessionId;
          lastActualFocusTabRef.current = sessionId
            ? tabBySessionRef.current.get(sessionId) ?? null
            : null;
        } else {
          lastActualFocusTabRef.current = null;
        }
      };
      document.addEventListener("focusin", onFocusIn, true);
      const onActivationPointerDown = (event: PointerEvent) => {
        // First-mouse activation is a native macOS/Tauri concern. Browser
        // shells (including E2E) may report `document.hasFocus() === false`
        // indefinitely and must never have ordinary clicks swallowed.
        if (!canRunTerminal) return;
        if (!appActiveRef.current) inactiveGestureRef.current = "down";
        if (
          appActiveRef.current &&
          performance.now() >= suppressTerminalMouseUntilRef.current
        ) {
          return;
        }
        const target = event.target;
        // Let the whole instance through (host padding included), not just the
        // grid: the instance holds no controls, and swallowing a chrome click
        // here would leave the terminal unfocused with no repair path.
        if (target instanceof HTMLElement && target.closest(".terminal-instance")) return;
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      document.addEventListener("pointerdown", onActivationPointerDown, true);
      // The activation grace ends with the activating gesture. A fast second
      // click (double-click in htop) must not be eaten, in either ordering of
      // native activation vs. the activating click's pointerup.
      const onActivationPointerUp = () => {
        if (appActiveRef.current) suppressTerminalMouseUntilRef.current = 0;
        else if (inactiveGestureRef.current === "down") {
          inactiveGestureRef.current = "done";
        }
      };
      document.addEventListener("pointerup", onActivationPointerUp, true);
      document.addEventListener("pointercancel", onActivationPointerUp, true);

      const restore = () => {
        // Window focus and Tauri onFocusChanged both call this on one
        // activation; only the inactive->active edge may arm the grace and
        // schedule the repair, or the repair cycle would run twice.
        const wasActive = appActiveRef.current;
        appActiveRef.current = true;
        if (wasActive) return;
        suppressTerminalMouseUntilRef.current =
          inactiveGestureRef.current === "done" ? 0 : performance.now() + 150;
        inactiveGestureRef.current = "none";
        const seededTab = restoreFocusTabRef.current;
        restoreFocusTabRef.current = null;
        // Decide inside the rAF: on first-mouse activation the activating
        // pointerdown (which DOM-focuses the textarea) has already run by
        // then, and that DOM-focused-but-key-dead textarea must be repaired
        // rather than treated as "another element holds focus".
        window.requestAnimationFrame(() => {
          // Prefer the terminal the click actually landed on over
          // focusedTabIdRef: the pane-switch state update from the activating
          // pointerdown may not have flushed to the ref before this rAF.
          const owned = [...handlesRef.current.entries()].find(([, h]) =>
            h.ownsFocus(),
          );
          const tabId = owned?.[0] ?? focusedTabIdRef.current;
          const handle = owned?.[1] ?? (tabId ? handlesRef.current.get(tabId) : undefined);
          if (!tabId || !handle) return;
          const el = document.activeElement;
          const action = terminalActivationFocusAction({
            seededTabId: seededTab,
            focusedTabId: tabId,
            ownsFocus: owned != null,
            activeElementIsBody: !el || el === document.body,
            focusState: terminalFocusStateRef.current,
          });
          if (action === "reattach") handle.focus({ reattach: true });
        });
      };
      const deactivate = () => {
        appActiveRef.current = false;
        inactiveGestureRef.current = "none";
        restoreFocusTabRef.current = lastActualFocusTabRef.current;
      };
      const onWindowBlur = () => deactivate();
      const onWindowFocus = () => restore();
      window.addEventListener("blur", onWindowBlur);
      window.addEventListener("focus", onWindowFocus);

      let disposed = false;
      let offNative: (() => void) | null = null;
      if (canRunTerminal) {
        void import("@tauri-apps/api/window")
          .then(({ getCurrentWindow }) =>
            getCurrentWindow().onFocusChanged(({ payload: active }) => {
              if (disposed) return;
              if (active) restore();
              else deactivate();
            }),
          )
          .then((off) => {
            if (disposed) off();
            else offNative = off;
          })
          .catch(() => {
            // Browser tests and unsupported shells use window focus fallback.
          });
      }

      return () => {
        disposed = true;
        offNative?.();
        document.removeEventListener("focusin", onFocusIn, true);
        document.removeEventListener("pointerdown", onActivationPointerDown, true);
        document.removeEventListener("pointerup", onActivationPointerUp, true);
        document.removeEventListener("pointercancel", onActivationPointerUp, true);
        window.removeEventListener("blur", onWindowBlur);
        window.removeEventListener("focus", onWindowFocus);
      };
    }, [canRunTerminal]);

    useEffect(() => {
      if (!open) {
        cancelFocusedTerminalRefresh();
        return;
      }
      scheduleFocusedTerminalRefresh();
    }, [
      cancelFocusedTerminalRefresh,
      dock,
      draftHeight,
      draftSplitRatio,
      draftWidth,
      focusedGroup,
      focusedTabId,
      maximized,
      open,
      renamingTaskId,
      scheduleFocusedTerminalRefresh,
      searchOpen,
      splitOpen,
    ]);

    const keepTerminalFocusOnToolbarPointerDown = useCallback(
      (event: React.PointerEvent<HTMLButtonElement>) => {
        if (!shouldFocusTerminalInput({ open, searchOpen, renamingTaskId })) return;
        event.preventDefault();
        getFocusedTerminalHandle()?.focus();
      },
      [getFocusedTerminalHandle, open, renamingTaskId, searchOpen],
    );

    const keepSearchFocusOnPointerDown = useCallback(
      (event: React.PointerEvent<HTMLButtonElement | HTMLLabelElement>) => {
        event.preventDefault();
        searchInputRef.current?.focus();
      },
      [],
    );

    const focusTabSoon = useCallback((tabId: string | null) => {
      if (!tabId) return;
      window.requestAnimationFrame(() => handlesRef.current.get(tabId)?.focus());
    }, []);

    const getFocusedSessionId = useCallback(() => {
      const tabId = focusedTabIdRef.current;
      return tabId ? sessionByTabRef.current.get(tabId) ?? null : null;
    }, []);

    const writeClipboardText = useCallback(
      async (text: string) => {
        if (!text) return;
        try {
          await clipboardWriteText(text);
        } catch {
          setError(t("terminal.clipboard.writeFailed"));
        }
      },
      [t],
    );

    const readClipboardText = useCallback(async (): Promise<string> => {
      try {
        return await clipboardReadText();
      } catch {
        setError(t("terminal.clipboard.readFailed"));
        return "";
      }
    }, [t]);

    const copySelectedTerminalText = useCallback(
      (text: string) => {
        void writeClipboardText(text);
      },
      [writeClipboardText],
    );

    const openSearch = useCallback(() => {
      setSearchOpen(true);
      window.requestAnimationFrame(() => searchInputRef.current?.select());
    }, []);

    const closeSearch = useCallback(() => {
      setSearchOpen(false);
      const handle = getFocusedTerminalHandle();
      handle?.focus();
    }, [getFocusedTerminalHandle]);

    const runTerminalSearch = useCallback(
      async (direction: TerminalSearchDirection) => {
        const sessionId = getFocusedSessionId();
        const query = searchQuery;
        if (!sessionId || !query) return;
        try {
          const result = await terminalSearch(
            sessionId,
            query,
            direction,
            searchCaseSensitive,
          );
          setSearchMatchesBySession((current) => ({
            ...current,
            [sessionId]: result.found && result.row != null && result.col != null
              ? { row: result.row, col: result.col, length: result.length }
              : null,
          }));
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      },
      [getFocusedSessionId, searchCaseSensitive, searchQuery],
    );

    const handleTerminalKeyDownCapture = useCallback(
      (event: React.KeyboardEvent<HTMLElement>) => {
        if (isTextEditingTarget(event.target)) return;
        const isMac = navigator.platform.toLowerCase().includes("mac");
        const action = terminalShortcutActionForEvent(
          event.nativeEvent,
          settings.terminal.shortcuts,
          isMac,
        );
        if (!action) return;
        event.preventDefault();
        event.stopPropagation();

        if (action === "paste") {
          const tabId = focusedTabIdRef.current;
          const sessionId = tabId ? sessionByTabRef.current.get(tabId) ?? null : null;
          const generation = sessionId
            ? generationBySessionRef.current.get(sessionId) ?? null
            : null;
          const handle = tabId ? handlesRef.current.get(tabId) ?? null : null;
          void (async () => {
            const text = await readClipboardText();
            if (!text || !sessionId || !generation) return;
            if (generationBySessionRef.current.get(sessionId) !== generation) return;
            inputPumpsRef.current.get(sessionId)?.push({ type: "paste", text });
            handle?.focus();
          })();
          return;
        }
        if (action === "copy") {
          const sessionId = getFocusedSessionId();
          const generation = sessionId
            ? generationBySessionRef.current.get(sessionId) ?? null
            : null;
          if (sessionId && generation) {
            void terminalCopySelection(sessionId, generation)
              .then((text) => {
                if (text) return writeClipboardText(text);
              })
              .catch(() => {
                const fallback = getFocusedTerminalHandle()?.copySelection();
                if (fallback) void writeClipboardText(fallback);
              });
          } else {
            const fallback = getFocusedTerminalHandle()?.copySelection();
            if (fallback) void writeClipboardText(fallback);
          }
          return;
        }
        if (action === "selectAll") {
          void (async () => {
            const handle = getFocusedTerminalHandle();
            if (!handle) return;
            const sessionId = getFocusedSessionId();
            let text: string | null = null;
            if (sessionId) {
              try {
                text = await terminalText(sessionId);
              } catch {
                text = null;
              }
            }
            handle.selectAll(text);
          })();
          return;
        }
        if (action === "find") {
          openSearch();
          return;
        }
        if (action === "clear") {
          const sessionId = getFocusedSessionId();
          if (sessionId) {
            setSearchMatchesBySession((current) => ({ ...current, [sessionId]: null }));
            void terminalClear(sessionId).catch((err) =>
              setError(err instanceof Error ? err.message : String(err)),
            );
          }
          return;
        }
        if (action === "closeTab") {
          if (focusedTabId) closeTab(focusedTabId);
          return;
        }
        if (action === "newTab") {
          void launch(settings.terminal.autoLaunch ?? "shell", focusedGroup);
          return;
        }
        if (action === "split") {
          onSplitOpenChange(true);
          return;
        }
        if (action.startsWith("tab")) {
          const index = Number(action.slice(3));
          const target = selectTerminalTabByIndex(activeTaskTabs, index);
          if (target) {
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
        getFocusedSessionId,
        getFocusedTerminalHandle,
        launch,
        onSplitOpenChange,
        openSearch,
        readClipboardText,
        rightTab,
        settings.terminal.autoLaunch,
        settings.terminal.shortcuts,
        splitOpen,
        writeClipboardText,
      ],
    );

    const handleTerminalMouseMoveCapture = useCallback(
      (event: React.MouseEvent<HTMLDivElement>) => {
        const target = event.target;
        const view =
          target instanceof HTMLElement ? target.closest(".native-terminal-view") : null;
        const sessionId = view instanceof HTMLElement ? view.dataset.sessionId : undefined;
        const mouseModeActive = sessionId
          ? mouseModesBySessionRef.current.get(sessionId) ?? false
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
        let pendingResize: { cols: number; rows: number } | null = null;
        let resizeRaf: number | null = null;
        let resizeTail = Promise.resolve();
        let pendingScroll = 0;
        let scrollRaf: number | null = null;
        handlers = {
          onInput: (command: TerminalInputCommand) => {
            inputPumpsRef.current.get(sessionId)?.push(command);
          },
          onResize: (cols: number, rows: number) => {
            pendingResize = { cols, rows };
            if (resizeRaf != null) return;
            resizeRaf = window.requestAnimationFrame(() => {
              resizeRaf = null;
              const size = pendingResize;
              pendingResize = null;
              if (!size) return;
              resizeTail = resizeTail.then(() =>
                terminalResize(sessionId, size.cols, size.rows).catch((resizeError) => {
                  if (tabBySessionRef.current.has(sessionId)) {
                    setError(
                      resizeError instanceof Error ? resizeError.message : String(resizeError),
                    );
                  }
                }),
              );
            });
          },
          onScroll: (delta: number) => {
            pendingScroll += delta;
            if (scrollRaf != null) return;
            scrollRaf = window.requestAnimationFrame(() => {
              scrollRaf = null;
              const next = pendingScroll;
              pendingScroll = 0;
              if (next === 0) return;
              void terminalScroll(sessionId, next).catch(() => {
                // Session may exit before the scroll command lands.
              });
            });
          },
          onFocusOwnership: () => {
            lastActualFocusTabRef.current = tabBySessionRef.current.get(sessionId) ?? null;
          },
          onSelection: async (command: TerminalSelectionCommand) => {
            const generation = generationBySessionRef.current.get(sessionId);
            if (!generation) return;
            await terminalSelection(sessionId, generation, command);
          },
          onCopySelection: async () => {
            const generation = generationBySessionRef.current.get(sessionId);
            if (!generation) return "";
            return terminalCopySelection(sessionId, generation);
          },
          onContextCopy: () => {
            const generation = generationBySessionRef.current.get(sessionId);
            if (!generation) return;
            void terminalCopySelection(sessionId, generation)
              .then((text) => {
                if (text) return writeClipboardText(text);
              })
              .catch(() => {});
          },
          onContextPaste: () => {
            const generation = generationBySessionRef.current.get(sessionId);
            if (!generation) return;
            void readClipboardText().then((text) => {
              if (!text || generationBySessionRef.current.get(sessionId) !== generation) return;
              inputPumpsRef.current.get(sessionId)?.push({ type: "paste", text });
            });
          },
          onContextSelectAll: () => {
            const generation = generationBySessionRef.current.get(sessionId);
            if (!generation) return;
            void terminalSelection(sessionId, generation, { type: "selectAll" }).catch(() => {});
          },
          onContextFind: () => openSearch(),
          onContextClear: () => {
            void terminalClear(sessionId).catch(() => {});
          },
          canForwardMouse: () =>
            appActiveRef.current && performance.now() >= suppressTerminalMouseUntilRef.current,
        };
        cache.set(sessionId, handlers);
      }
      return handlers;
    }, []);

    const getHandleRefCallback = useCallback(
      (tabId: string, sessionId: string) => {
        let callback = handleRefCallbacksRef.current.get(tabId);
        if (!callback) {
          callback = (handle: NativeTerminalViewHandle | null) => {
            if (!handle) {
              handlesRef.current.delete(tabId);
              return;
            }
            handlesRef.current.set(tabId, handle);
            const pending = pendingFramesRef.current.get(sessionId) ?? [];
            pendingFramesRef.current.delete(sessionId);
            for (const message of pending) {
              if (message.kind === "frame") applyStreamFrame(message, handle);
            }
          };
          handleRefCallbacksRef.current.set(tabId, callback);
        }
        return callback;
      },
      [applyStreamFrame],
    );

    const renderTerminalTab = (tab: (typeof state.tabs)[number]) => {
      const className = tab.id === focusedTabId ? "terminal-tab active" : "terminal-tab";
      const status = terminalTabStatus(tab);
      const relaunchable = isRelaunchableTab(tab);
      return (
        <div key={tab.id} className={className}>
          <button
            type="button"
            className="terminal-tab-main"
            onPointerDown={(event) => {
              event.preventDefault();
              if (!relaunchable) handlesRef.current.get(tab.id)?.focus();
            }}
            onClick={() => {
              if (relaunchable) {
                relaunchTab(tab.id);
                return;
              }
              if (splitOpen && rightTab?.id === tab.id) {
                setFocusedGroup("right");
                handlesRef.current.get(tab.id)?.focus();
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
      const switchTask = () => {
        dispatch({ type: "switchTask", taskId: task.id });
        setFocusedGroup("left");
        focusTabSoon(taskTabs[0]?.id ?? null);
      };
      return (
        <div
          key={task.id}
          className={className}
          role="option"
          aria-selected={isActive}
          tabIndex={0}
          onPointerDown={(event) => {
            if ((event.target as HTMLElement).closest("input")) return;
            event.preventDefault();
          }}
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
                  onPointerDown={keepTerminalFocusOnToolbarPointerDown}
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
              onPointerDown={keepTerminalFocusOnToolbarPointerDown}
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
            onPointerDown={keepTerminalFocusOnToolbarPointerDown}
            onClick={() => onDockChange(dockTarget)}
            aria-label={dockTitle}
            title={dockTitle}
          >
            {dockTarget === "right" ? <PanelRight size={14} /> : <PanelBottom size={14} />}
          </button>
          <button
            type="button"
            className="terminal-icon-button"
            onPointerDown={keepTerminalFocusOnToolbarPointerDown}
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
                onPointerDown={keepTerminalFocusOnToolbarPointerDown}
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
                onPointerDown={keepTerminalFocusOnToolbarPointerDown}
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
                    onPointerDown={() => {
                      setFocusedGroup(isRight ? "right" : "left");
                      handlesRef.current.get(tab.id)?.focus();
                    }}
                  >
                    <div className="terminal-instance-host">
                      {sessionId && handlers ? (
                        <NativeTerminalView
                          ref={getHandleRefCallback(tab.id, sessionId)}
                          sessionId={sessionId}
                          active={isVisible}
                          focused={isFocused}
                          resizeReady={resizeReadySessions[sessionId] === true}
                          inputLabel={t("terminal.input")}
                          copyOnSelect={settings.terminal.copyOnSelect}
                          searchMatch={searchMatchesBySession[sessionId] ?? null}
                          onInput={handlers.onInput}
                          onResize={handlers.onResize}
                          onScroll={handlers.onScroll}
                          onCopyOnSelect={copySelectedTerminalText}
                          onFocusOwnership={handlers.onFocusOwnership}
                          onSelection={handlers.onSelection}
                          onCopySelection={handlers.onCopySelection}
                          contextMenuLabels={terminalContextMenuLabels}
                          onContextCopy={handlers.onContextCopy}
                          onContextPaste={handlers.onContextPaste}
                          onContextSelectAll={handlers.onContextSelectAll}
                          onContextFind={handlers.onContextFind}
                          onContextClear={handlers.onContextClear}
                          canForwardMouse={handlers.canForwardMouse}
                        />
                      ) : null}
                    </div>
                  </div>
                );
              })}
              {searchOpen ? (
                <form
                  className="terminal-search-overlay"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void runTerminalSearch("next");
                  }}
                >
                  <Search size={13} aria-hidden="true" />
                  <input
                    ref={searchInputRef}
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        closeSearch();
                      } else if (event.key === "Enter" && event.shiftKey) {
                        event.preventDefault();
                        void runTerminalSearch("previous");
                      }
                    }}
                    placeholder={t("terminal.search.placeholder")}
                    aria-label={t("terminal.search.placeholder")}
                  />
                  <button
                    type="button"
                    className="terminal-search-button"
                    onPointerDown={keepSearchFocusOnPointerDown}
                    onClick={() => void runTerminalSearch("previous")}
                    aria-label={t("terminal.search.previous")}
                    title={t("terminal.search.previous")}
                  >
                    <ChevronUp size={13} />
                  </button>
                  <button
                    type="submit"
                    className="terminal-search-button"
                    onPointerDown={keepSearchFocusOnPointerDown}
                    aria-label={t("terminal.search.next")}
                    title={t("terminal.search.next")}
                  >
                    <ChevronDown size={13} />
                  </button>
                  <label className="terminal-search-case" title={t("terminal.search.case")}>
                    <input
                      type="checkbox"
                      checked={searchCaseSensitive}
                      onChange={(event) => {
                        setSearchCaseSensitive(event.target.checked);
                        window.requestAnimationFrame(() => searchInputRef.current?.focus());
                      }}
                    />
                    <span>Aa</span>
                  </label>
                  <button
                    type="button"
                    className="terminal-search-button"
                    onPointerDown={keepSearchFocusOnPointerDown}
                    onClick={closeSearch}
                    aria-label={t("terminal.search.close")}
                    title={t("terminal.search.close")}
                  >
                    <X size={13} />
                  </button>
                </form>
              ) : null}
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
                  aria-valuenow={Math.round(draftSplitRatio * 100)}
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

import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import {
  ChevronDown,
  ChevronUp,
  Code2,
  Maximize2,
  Minimize2,
  PanelBottom,
  SquareTerminal,
  X,
} from "lucide-react";
import type React from "react";
import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import {
  terminalAvailable,
  terminalKill,
  terminalResize,
  terminalSpawn,
  terminalWrite,
} from "../lib/api";
import { useTranslation } from "../lib/i18n";
import type { AnchorSettings } from "../lib/settings";
import {
  createTerminalTab,
  EMPTY_TERMINAL_STATE,
  TERMINAL_LAUNCHERS,
  terminalCommandPreview,
  terminalTabsReducer,
  shouldAutoLaunchTerminal,
  type TerminalKind,
} from "../lib/terminal";

interface TerminalPanelProps {
  cwd: string | null;
  settings: AnchorSettings;
  open: boolean;
  height: number;
  splitOpen: boolean;
  splitRatio: number;
  maximized: boolean;
  onOpenChange: (open: boolean) => void;
  onHeightChange: (height: number) => void;
  onSplitOpenChange: (open: boolean) => void;
  onSplitRatioChange: (ratio: number) => void;
  onMaximizedChange: (maximized: boolean) => void;
}

interface TerminalOutputEvent {
  sessionId: string;
  data: string;
}

interface TerminalExitEvent {
  sessionId: string;
  exitCode: number | null;
}

interface TerminalHandle {
  terminal: XtermTerminal;
  fit: FitAddon;
}

const MIN_HEIGHT = 160;
const MAX_HEIGHT = 520;

export const TerminalPanel = memo(function TerminalPanel({
  cwd,
  settings,
  open,
  height,
  splitOpen,
  splitRatio,
  maximized,
  onOpenChange,
  onHeightChange,
  onSplitOpenChange,
  onSplitRatioChange,
  onMaximizedChange,
}: TerminalPanelProps) {
  const { t } = useTranslation();
  const [state, dispatch] = useReducer(terminalTabsReducer, EMPTY_TERMINAL_STATE);
  const [draftHeight, setDraftHeight] = useState(height);
  const [rightTabId, setRightTabId] = useState<string | null>(null);
  const [focusedGroup, setFocusedGroup] = useState<"left" | "right">("left");
  const [error, setError] = useState<string | null>(null);
  const handlesRef = useRef<Map<string, TerminalHandle>>(new Map());
  const hostRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const terminalBodyRef = useRef<HTMLDivElement | null>(null);
  const sessionByTabRef = useRef<Map<string, string>>(new Map());
  const tabBySessionRef = useRef<Map<string, string>>(new Map());
  const seqRef = useRef(1);
  const autoLaunchRef = useRef(false);
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
  const rightTab = state.tabs.find((tab) => tab.id === rightTabId) ?? null;
  const canRunTerminal = useMemo(() => terminalAvailable(), []);

  const waitForTerminalHost = useCallback(async (tabId: string) => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (hostRef.current.has(tabId)) return;
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    }
  }, []);

  useEffect(() => {
    setDraftHeight(height);
  }, [height]);

  const fitTab = useCallback((tabId: string) => {
    const handle = handlesRef.current.get(tabId);
    if (!handle) return;
    try {
      handle.fit.fit();
      const sessionId = sessionByTabRef.current.get(tabId);
      if (sessionId) {
        void terminalResize(sessionId, handle.terminal.cols, handle.terminal.rows);
      }
    } catch {
      // xterm fit can fail while the host is hidden during layout changes.
    }
  }, []);

  const attachTerminal = useCallback(
    (tabId: string) => {
      const handle = handlesRef.current.get(tabId);
      const host = hostRef.current.get(tabId);
      if (!handle || !host || host.childElementCount > 0) return;
      handle.terminal.open(host);
      window.requestAnimationFrame(() => fitTab(tabId));
    },
    [fitTab],
  );

  useEffect(() => {
    if (!canRunTerminal) return;
    let disposed = false;

    const outputPromise = import("@tauri-apps/api/event").then(({ listen }) =>
      listen<TerminalOutputEvent>("terminal://output", (event) => {
        if (disposed) return;
        const tabId = tabBySessionRef.current.get(event.payload.sessionId);
        if (!tabId) return;
        handlesRef.current.get(tabId)?.terminal.write(event.payload.data);
      }),
    );
    const exitPromise = import("@tauri-apps/api/event").then(({ listen }) =>
      listen<TerminalExitEvent>("terminal://exit", (event) => {
        if (disposed) return;
        const tabId = tabBySessionRef.current.get(event.payload.sessionId);
        if (tabId) {
          handlesRef.current
            .get(tabId)
            ?.terminal.writeln(
              `\r\n[process exited: ${event.payload.exitCode ?? "unknown"}]`,
            );
          sessionByTabRef.current.delete(tabId);
        }
        tabBySessionRef.current.delete(event.payload.sessionId);
        dispatch({
          type: "exit",
          sessionId: event.payload.sessionId,
          exitCode: event.payload.exitCode,
        });
      }),
    );

    outputPromise.catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });
    exitPromise.catch((err) => {
      setError(err instanceof Error ? err.message : String(err));
    });

    return () => {
      disposed = true;
      // Wait for the listen() promises to resolve before unsubscribing,
      // otherwise we leak the registration.
      void outputPromise.then((off) => off()).catch(() => {});
      void exitPromise.then((off) => off()).catch(() => {});
    };
  }, [canRunTerminal]);

  useEffect(() => {
    if (!open || !activeTab) return;
    window.requestAnimationFrame(() => fitTab(activeTab.id));
    if (rightTab) window.requestAnimationFrame(() => fitTab(rightTab.id));
  }, [activeTab, draftHeight, fitTab, maximized, open, rightTab, splitOpen, splitRatio]);

  useEffect(() => {
    if (!open || !activeTab) return;
    let frame = 0;
    const onResize = () => {
      if (frame) cancelAnimationFrame(frame);
        frame = window.requestAnimationFrame(() => {
          frame = 0;
          fitTab(activeTab.id);
          if (rightTab) fitTab(rightTab.id);
        });
    };
    window.addEventListener("resize", onResize);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, [activeTab, fitTab, maximized, open, rightTab]);

  useEffect(() => {
    return () => {
      for (const sessionId of sessionByTabRef.current.values()) {
        void terminalKill(sessionId);
      }
      for (const handle of handlesRef.current.values()) {
        handle.terminal.dispose();
      }
    };
  }, []);

  const launch = useCallback(
    async (kind: TerminalKind, group: "left" | "right" = "left") => {
      if (!canRunTerminal) {
        setError(t("terminal.tauriRequired"));
        return;
      }
      const launcher = settings.terminal.launchers[kind];
      if (!launcher?.enabled) return;
      const tabId = `terminal-${Date.now()}-${seqRef.current++}`;
      const sessionId = `term-${
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`
      }`;
      const title = launcher.label || t(`terminal.launcher.${kind}`);
      const terminal = new XtermTerminal({
        cursorBlink: true,
        convertEol: false,
        fontFamily: "JetBrains Mono, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
        fontSize: 12,
        lineHeight: 1.25,
        scrollback: 5000,
        theme: {
          background: "#111111",
          foreground: "#d4d4d4",
          cursor: "#d4d4d4",
          selectionBackground: "#264f78",
          black: "#111111",
          red: "#f87171",
          green: "#8bc891",
          yellow: "#e5c07b",
          blue: "#7aa2f7",
          magenta: "#c792ea",
          cyan: "#70c0ba",
          white: "#d4d4d4",
        },
      });
      const fit = new FitAddon();
      terminal.loadAddon(fit);
      terminal.attachCustomKeyEventHandler((event) => {
        const isMac = navigator.platform.toLowerCase().includes("mac");
        const mod = isMac ? event.metaKey : event.ctrlKey;
        if (mod && event.key.toLowerCase() === "d") {
          event.preventDefault();
          onSplitOpenChange(true);
          return false;
        }
        return true;
      });
      terminal.onData((data) => {
        void terminalWrite(sessionId, data);
      });
      handlesRef.current.set(tabId, { terminal, fit });
      // Register the session↔tab mapping BEFORE spawning so we don't drop
      // any terminal://output events that race ahead of the IPC return.
      sessionByTabRef.current.set(tabId, sessionId);
      tabBySessionRef.current.set(sessionId, tabId);
      dispatch({
        type: "create",
        tab: createTerminalTab(tabId, kind, title),
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
        await waitForTerminalHost(tabId);
        attachTerminal(tabId);
        try {
          fit.fit();
        } catch {
          // The panel can still be settling after opening or splitting.
        }
        await terminalSpawn(sessionId, kind, cwd, {
          command: launcher.command ?? null,
          extraArgs: launcher.args ?? null,
          cols: terminal.cols,
          rows: terminal.rows,
        });
        window.requestAnimationFrame(() => {
          attachTerminal(tabId);
          fitTab(tabId);
          if (group === focusedGroup || group === "right") terminal.focus();
        });
      } catch (err) {
        sessionByTabRef.current.delete(tabId);
        tabBySessionRef.current.delete(sessionId);
        terminal.writeln(`\r\n${err instanceof Error ? err.message : String(err)}`);
        dispatch({ type: "fail", tabId });
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [
      attachTerminal,
      canRunTerminal,
      cwd,
      fitTab,
      focusedGroup,
      onOpenChange,
      onSplitOpenChange,
      open,
      settings.terminal.launchers,
      t,
      waitForTerminalHost,
    ],
  );

  useEffect(() => {
    if (!open) {
      autoLaunchRef.current = false;
      return;
    }
    const launcher = shouldAutoLaunchTerminal(settings, open, state.tabs.length);
    if (!launcher || autoLaunchRef.current) return;
    autoLaunchRef.current = true;
    void launch(launcher);
  }, [launch, open, settings, state.tabs.length]);

  useEffect(() => {
    if (!splitOpen) {
      setRightTabId(null);
      setFocusedGroup("left");
      return;
    }
    if (rightTabId && state.tabs.some((tab) => tab.id === rightTabId)) return;
    const kind = activeTab?.kind ?? settings.terminal.autoLaunch ?? "shell";
    void launch(kind, "right");
  }, [activeTab?.kind, launch, rightTabId, settings.terminal.autoLaunch, splitOpen, state.tabs]);

  const closeTab = useCallback((tabId: string) => {
    const sessionId = sessionByTabRef.current.get(tabId);
    if (sessionId) {
      void terminalKill(sessionId);
      sessionByTabRef.current.delete(tabId);
      tabBySessionRef.current.delete(sessionId);
    }
    handlesRef.current.get(tabId)?.terminal.dispose();
    handlesRef.current.delete(tabId);
    hostRef.current.delete(tabId);
    if (rightTabId === tabId) {
      setRightTabId(null);
      onSplitOpenChange(false);
      setFocusedGroup("left");
    }
    dispatch({ type: "close", tabId });
  }, [onSplitOpenChange, rightTabId]);

  const toggleOpen = useCallback(() => {
    onOpenChange(!open);
  }, [onOpenChange, open]);

  const startResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const handle = event.currentTarget;
      const pointerId = event.pointerId;
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
    [draftHeight, onHeightChange],
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

  const panelStyle = open && !maximized ? { height: draftHeight } : undefined;
  const splitMode = splitOpen && Boolean(rightTab);
  // Use a CSS variable instead of grid columns so terminal-instance divs stay
  // direct children of terminal-body. If we wrapped each side in its own
  // container the LEFT instance's DOM parent would change every time split
  // toggles, React would remount the div, and xterm.Terminal.open() would
  // refuse to re-attach (its element.parentElement guard) — leaving the left
  // pane blank and unable to receive input.
  const splitBodyStyle = splitMode
    ? ({ "--terminal-split-ratio": String(splitRatio) } as React.CSSProperties)
    : undefined;
  const focusedTabId = focusedGroup === "right" && rightTab ? rightTab.id : state.activeTabId;

  return (
    <section
      className={
        open
          ? maximized
            ? "terminal-panel maximized"
            : "terminal-panel"
          : "terminal-panel collapsed"
      }
      style={panelStyle}
    >
      <div className="terminal-resize-handle" onPointerDown={startResize} />
      <header className="terminal-header">
        <button
          type="button"
          className="terminal-title"
          onClick={toggleOpen}
          aria-expanded={open}
        >
          <PanelBottom size={14} />
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
                    ? terminalCommandPreview(launcher.id, cwd ?? "")
                    : t("terminal.tauriRequired")
                }
              >
                {launcher.id === "codex" ? <Code2 size={13} /> : <SquareTerminal size={13} />}
                <span>{t(launcher.titleKey)}</span>
              </button>
            );
          })}
        </div>
        <div className="terminal-cwd" title={cwd ?? t("terminal.cwd.none")}>
          {cwd ?? t("terminal.cwd.none")}
        </div>
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

      {/* Tabs and body stay mounted across collapse so xterm DOM keeps its
          parent. Visibility is controlled via CSS on .terminal-panel.collapsed. */}
      <div className="terminal-tabs" role="tablist" aria-label={t("terminal.tabs")} hidden={!open}>
            {state.tabs.length === 0 ? (
              <span className="terminal-tab-placeholder">{t("terminal.empty")}</span>
            ) : null}
            {state.tabs.map((tab) => (
              <div
                key={tab.id}
                className={tab.id === focusedTabId ? "terminal-tab active" : "terminal-tab"}
              >
                <button
                  type="button"
                  className="terminal-tab-main"
                  onClick={() => {
                    if (splitOpen && rightTab?.id === tab.id) {
                      setFocusedGroup("right");
                      return;
                    }
                    dispatch({ type: "switch", tabId: tab.id });
                    setFocusedGroup("left");
                  }}
                  title={tab.title}
                >
                  <span className={tab.running ? "terminal-dot running" : "terminal-dot"} />
                  <span>{tab.title}</span>
                </button>
                <button
                  type="button"
                  className="terminal-tab-close"
                  onClick={() => closeTab(tab.id)}
                  aria-label={t("terminal.tab.close", { title: tab.title })}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
      <div
        className={splitMode ? "terminal-body split" : "terminal-body"}
        style={splitBodyStyle}
        ref={terminalBodyRef}
        hidden={!open}
      >
        {!canRunTerminal ? (
          <div className="terminal-empty">{t("terminal.tauriRequired")}</div>
        ) : state.tabs.length === 0 ? (
          <div className="terminal-empty">{t("terminal.empty.detail")}</div>
        ) : (
          <>
            {/* Flat sibling list under terminal-body. Each instance keeps the
                same parent across split toggles so xterm DOM is never reparented. */}
            {state.tabs.map((tab) => {
            const isRight = splitMode && rightTabId === tab.id;
            const isLeftActive = !isRight && state.activeTabId === tab.id;
            const isVisible = isRight || isLeftActive;
            const isFocused =
              isVisible &&
              splitMode &&
              (isRight ? focusedGroup === "right" : focusedGroup === "left");
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
                onPointerDown={() => setFocusedGroup(isRight ? "right" : "left")}
              >
                {isVisible ? (
                  <button
                    type="button"
                    className="terminal-pane-close"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() => closeTab(tab.id)}
                    title={t("terminal.tab.close", { title: tab.title })}
                    aria-label={t("terminal.tab.close", { title: tab.title })}
                  >
                    <X size={13} />
                  </button>
                ) : null}
                <div
                  className="terminal-instance-host"
                  ref={(node) => {
                    if (node) {
                      hostRef.current.set(tab.id, node);
                      attachTerminal(tab.id);
                    } else {
                      hostRef.current.delete(tab.id);
                    }
                  }}
                />
              </div>
            );
            })}
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
          </>
        )}
      </div>
      {open && error ? <div className="terminal-error">{error}</div> : null}
    </section>
  );
});

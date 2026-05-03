import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XtermTerminal } from "@xterm/xterm";
import {
  ChevronDown,
  ChevronUp,
  Code2,
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
  onOpenChange: (open: boolean) => void;
  onHeightChange: (height: number) => void;
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
  onOpenChange,
  onHeightChange,
}: TerminalPanelProps) {
  const { t } = useTranslation();
  const [state, dispatch] = useReducer(terminalTabsReducer, EMPTY_TERMINAL_STATE);
  const [draftHeight, setDraftHeight] = useState(height);
  const [error, setError] = useState<string | null>(null);
  const handlesRef = useRef<Map<string, TerminalHandle>>(new Map());
  const hostRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const sessionByTabRef = useRef<Map<string, string>>(new Map());
  const tabBySessionRef = useRef<Map<string, string>>(new Map());
  const seqRef = useRef(1);
  const autoLaunchRef = useRef(false);
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
  const canRunTerminal = useMemo(() => terminalAvailable(), []);

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
  }, [activeTab, fitTab, draftHeight, open]);

  useEffect(() => {
    if (!open || !activeTab) return;
    let frame = 0;
    const onResize = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        fitTab(activeTab.id);
      });
    };
    window.addEventListener("resize", onResize);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
    };
  }, [activeTab, fitTab, open]);

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
    async (kind: TerminalKind) => {
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
      terminal.onData((data) => {
        void terminalWrite(sessionId, data);
      });
      terminal.writeln(`$ ${terminalCommandPreview(kind, cwd ?? "")}`);
      handlesRef.current.set(tabId, { terminal, fit });
      // Register the session↔tab mapping BEFORE spawning so we don't drop
      // any terminal://output events that race ahead of the IPC return.
      sessionByTabRef.current.set(tabId, sessionId);
      tabBySessionRef.current.set(sessionId, tabId);
      dispatch({ type: "create", tab: createTerminalTab(tabId, kind, title) });
      dispatch({ type: "attach", tabId, sessionId });
      if (!open) onOpenChange(true);
      setError(null);

      try {
        await terminalSpawn(sessionId, kind, cwd, {
          command: launcher.command ?? null,
          extraArgs: launcher.args ?? null,
        });
        window.requestAnimationFrame(() => {
          attachTerminal(tabId);
          fitTab(tabId);
          terminal.focus();
        });
      } catch (err) {
        sessionByTabRef.current.delete(tabId);
        tabBySessionRef.current.delete(sessionId);
        terminal.writeln(`\r\n${err instanceof Error ? err.message : String(err)}`);
        dispatch({ type: "fail", tabId });
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [attachTerminal, canRunTerminal, cwd, fitTab, onOpenChange, open, settings.terminal.launchers, t],
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
    dispatch({ type: "close", tabId });
  }, []);

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

  const panelStyle = open ? { height: draftHeight } : undefined;

  return (
    <section className={open ? "terminal-panel" : "terminal-panel collapsed"} style={panelStyle}>
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
                onClick={() => void launch(launcher.id)}
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
                className={tab.id === state.activeTabId ? "terminal-tab active" : "terminal-tab"}
              >
                <button
                  type="button"
                  className="terminal-tab-main"
                  onClick={() => dispatch({ type: "switch", tabId: tab.id })}
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
      <div className="terminal-body" hidden={!open}>
        {!canRunTerminal ? (
          <div className="terminal-empty">{t("terminal.tauriRequired")}</div>
        ) : state.tabs.length === 0 ? (
          <div className="terminal-empty">{t("terminal.empty.detail")}</div>
        ) : (
          state.tabs.map((tab) => (
            <div
              key={tab.id}
              className={
                tab.id === state.activeTabId
                  ? "terminal-instance active"
                  : "terminal-instance"
              }
              ref={(node) => {
                if (node) {
                  hostRef.current.set(tab.id, node);
                  attachTerminal(tab.id);
                } else {
                  hostRef.current.delete(tab.id);
                }
              }}
            />
          ))
        )}
      </div>
      {open && error ? <div className="terminal-error">{error}</div> : null}
    </section>
  );
});

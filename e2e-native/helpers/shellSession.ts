// Shared native shell attribution. Opening a restored split can create a right
// PTY even when restored tabs suppress the ordinary empty-panel auto-launch.
// Wait for that topology and its prompts before issuing the explicit launch.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import type {} from "webdriverio";
import { fixtureGlobalSettingsFile } from "./fixtureWorkspace";
import { readTerminalText } from "./ptyAssertions";

const POLL_TIMEOUT_MS = 20_000;

export interface NativeShellProbeRequest {
  phase: "open" | "launch" | "select" | "prompt" | "focus";
  splitExpected?: boolean;
  requireAutoSession?: boolean;
  priorIds?: string[];
  sessionId?: string;
}
export interface NativeShellProbeResult {
  ready: boolean;
  sessionId: string | null;
  sessionIds: string[];
  restoredTabsPresent: boolean;
  diagnostics: {
    phase: string;
    split: boolean;
    bridgePresent: boolean;
    activeElement: { tag: string; className: string; sessionId: string | null } | null;
    views: Array<{ id: string; className: string; visible: boolean; focused: boolean; rect: number[]; display: string; visibility: string }>;
  };
}

/** Self-contained WebDriver callback, also exercised directly by DOM tests.
 * Readiness is based on rendered topology and PTY prompts, never a quiet-period
 * sleep. Diagnostic fields deliberately exclude terminal/input contents. */
export function pollNativeShell(
  request: NativeShellProbeRequest,
  timeout: number,
  done: (result: NativeShellProbeResult) => void,
): void {
  const deadline = Date.now() + timeout;
  const visible = (element: HTMLElement): boolean => {
    if (!element.isConnected || element.getClientRects().length === 0) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    for (let node: HTMLElement | null = element; node; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      if (node.hidden || style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse") return false;
    }
    return true;
  };
  const tick = () => {
    const views = Array.from(document.querySelectorAll<HTMLElement>(".native-terminal-view[data-session-id]"));
    const ids = views.map((view) => view.dataset.sessionId!).filter(Boolean);
    const focused = (view: HTMLElement) => Boolean(view.closest(".terminal-instance.active.focused")) && visible(view);
    const textReady = (view: HTMLElement) => Boolean(window.__MARU_NATIVE_E2E__?.terminalText(view.dataset.sessionId!)?.trim());
    const candidates = views.filter((view) => focused(view) && !(request.priorIds ?? []).includes(view.dataset.sessionId!));
    let target = request.sessionId
      ? views.find((view) => view.dataset.sessionId === request.sessionId && focused(view)) ?? null
      : candidates.length === 1 ? candidates[0] : null;
    let ready = false;
    let restoredTabsPresent = false;
    if (request.phase === "open") {
      const title = document.querySelector<HTMLButtonElement>(".terminal-title");
      if (title) {
        // Sample restored metadata before opening: a new automatic launch may
        // persist its own metadata as soon as the panel opens.
        try {
          const persisted = JSON.parse(window.localStorage.getItem("maru:terminal:v1") ?? "null") as {
            tasks?: Array<{ id?: unknown; name?: unknown }>;
            sessions?: Array<{ taskId?: unknown; kind?: unknown }>;
          } | null;
          if (Array.isArray(persisted?.tasks) && Array.isArray(persisted?.sessions)) {
            const tasks = new Set(persisted.tasks.filter((task) => typeof task.id === "string" && typeof task.name === "string").map((task) => task.id));
            restoredTabsPresent = persisted.sessions.some((session) => typeof session.taskId === "string" && tasks.has(session.taskId)
              && typeof session.kind === "string" && ["claude", "codex", "kimi", "kiro", "shell"].includes(session.kind));
          }
        } catch { /* The app also rejects malformed restored metadata. */ }
        title.click(); ready = true; target = null;
      }
    } else if (request.phase === "launch") {
      const workspace = document.querySelector<HTMLElement>(".terminal-workspace");
      const body = document.querySelector<HTMLElement>(".terminal-body");
      const launcher = document.querySelector<HTMLButtonElement>('.terminal-launchers button[aria-label="Shell"]');
      const activeViews = views.filter((view) => Boolean(view.closest(".terminal-instance.active")) && visible(view));
      const right = activeViews.find((view) => Boolean(view.closest(".pane-right")));
      const topologyReady = request.splitExpected
        ? Boolean(body?.classList.contains("split") && right && textReady(right))
        : !request.requireAutoSession || activeViews.length > 0;
      ready = Boolean(workspace && visible(workspace) && launcher && !launcher.disabled && visible(launcher)
        && topologyReady && activeViews.every(textReady));
      if (ready) {
        // Capture every mounted id in the same callback immediately before click.
        // Hidden keep-alive sessions and the split's automatic right PTY belong
        // to the baseline, never to this explicit launch.
        launcher!.click();
        target = null;
      }
    } else if (target && request.phase === "select") {
      ready = true;
    } else if (target && request.phase === "prompt") {
      ready = textReady(target);
    } else if (target && request.phase === "focus") {
      const input = target.querySelector<HTMLTextAreaElement>(".native-terminal-input");
      if (input && !input.disabled && !input.closest("[hidden]")) {
        const style = window.getComputedStyle(input);
        if (style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse") {
          input.focus();
          ready = document.activeElement === input && focused(target);
        }
      }
    }
    const element = document.activeElement;
    const result: NativeShellProbeResult = {
      ready,
      sessionId: target?.dataset.sessionId ?? null,
      sessionIds: ids,
      restoredTabsPresent,
      diagnostics: {
        phase: request.phase,
        split: Boolean(document.querySelector(".terminal-body.split")),
        bridgePresent: typeof window.__MARU_NATIVE_E2E__?.terminalText === "function",
        activeElement: element instanceof HTMLElement ? {
          tag: element.tagName, className: element.className,
          sessionId: element.closest<HTMLElement>(".native-terminal-view")?.dataset.sessionId ?? null,
        } : null,
        views: views.map((view) => {
          const instance = view.closest<HTMLElement>(".terminal-instance");
          const rect = view.getBoundingClientRect();
          const style = window.getComputedStyle(view);
          return { id: view.dataset.sessionId!, className: instance?.className ?? "", visible: visible(view),
            focused: Boolean(instance?.classList.contains("focused")), rect: [rect.x, rect.y, rect.width, rect.height],
            display: style.display, visibility: style.visibility };
        }),
      },
    };
    if (ready || Date.now() >= deadline) { done(result); return; }
    setTimeout(tick, 100);
  };
  tick();
}

async function probe(request: NativeShellProbeRequest, message: string): Promise<NativeShellProbeResult> {
  const result = await browser.executeAsync(pollNativeShell, request, POLL_TIMEOUT_MS) as NativeShellProbeResult;
  if (!result.ready) console.error("native_shell_readiness_failure", JSON.stringify(result.diagnostics));
  if (!result.ready && result.sessionIds.length > 0 && !result.diagnostics.bridgePresent) {
    throw new Error("native terminal text bridge is absent; run pnpm build:frontend:native-e2e before the native suite");
  }
  assert.ok(result.ready, message);
  return result;
}

export async function openShellSession(): Promise<string> {
  const opened = await probe({ phase: "open" }, ".terminal-title never rendered");
  // This is the same private fixture settings file the relaunched app reads.
  // Reading it retains the restored split rather than resetting profile state.
  let splitExpected = opened.diagnostics.split;
  try {
    const settings = JSON.parse(await fs.readFile(fixtureGlobalSettingsFile(), "utf8")) as { ui?: { layout?: { terminalSplitOpen?: boolean } } };
    splitExpected ||= settings.ui?.layout?.terminalSplitOpen === true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // A fresh fixture has no saved settings yet; terminalSplitOpen defaults false.
  }
  const launched = await probe({ phase: "launch", splitExpected,
    requireAutoSession: opened.sessionIds.length === 0 && !opened.restoredTabsPresent }, "terminal topology or its shell prompts never became ready for explicit launch");
  const selected = await probe({ phase: "select", priorIds: launched.sessionIds }, "launching a shell never mounted one new visible focused native terminal view");
  const sessionId = selected.sessionId!;
  await readTerminalText(sessionId);
  await probe({ phase: "prompt", sessionId }, "the selected terminal lost visibility/focus or its prompt stayed empty");
  await probe({ phase: "focus", sessionId }, "the selected visible terminal's textarea never took DOM focus");
  return sessionId;
}

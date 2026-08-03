import type { AiRuntime, TerminalLauncherId } from "./settings";

/**
 * Mirror of `CliProviderKind::capabilities()` in
 * `src-tauri/src/agent_host/provider.rs`.
 *
 * It is a mirror rather than a Tauri command because the readers are
 * synchronous pure functions (argv builders inside a spawn path) and because
 * ComposeDialog runs in the browser dev shell, where there is no Tauri at all.
 * `agentCapabilities.test.ts` parses the Rust file and fails the build if the
 * two tables disagree — edit both sides together.
 */
export interface AgentCapabilities {
  /** Native session resume (`--resume` / `resume` / `--session`). */
  resume: boolean;
  /** A machine-readable usage/quota source exists. */
  usage: boolean;
  /** Accepts `--add-dir` for extra readable roots. */
  addDirs: boolean;
}

export const AGENT_CAPABILITIES: Record<AiRuntime, AgentCapabilities> = {
  claude: { resume: true, usage: true, addDirs: true },
  codex: { resume: true, usage: true, addDirs: true },
  kimi: { resume: true, usage: false, addDirs: true },
  kiro: { resume: false, usage: false, addDirs: false },
};

const NO_CAPABILITIES: AgentCapabilities = { resume: false, usage: false, addDirs: false };

/** True for the CLI agent launchers, false for the plain shell. This is a
 *  launcher predicate, not a capability — `shell` is not a provider, so it
 *  cannot appear in the table above. */
export function isAgentKind(kind: TerminalLauncherId): kind is AiRuntime {
  return kind !== "shell";
}

export function agentCapabilities(kind: TerminalLauncherId): AgentCapabilities {
  return isAgentKind(kind) ? AGENT_CAPABILITIES[kind] : NO_CAPABILITIES;
}

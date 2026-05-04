import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  MOCK_VAULT_PATH,
  mockCreateDocument,
  mockCreateVersion,
  mockEntries,
  mockInboxDropItems,
  mockSetActiveWorkspaceRoot,
  mockWorkspaceRegistry,
  readMockDocument,
} from "./fixtures";
import type {
  CreatedDocument,
  DocumentPayload,
  GitFileChange,
  GitStatus,
  GmailMessage,
  InboxClassification,
  InboxDropItem,
  InboxSettings,
  FileStoreOperation,
  VaultEntry,
  MemoDocument,
  MemoEntry,
  MemoFormat,
  StoredFileOutcome,
  WorkspaceRegistry,
  WorkspaceRootEntry,
  WorkspaceVisibility,
  VersionSnapshot,
} from "./types";
import type { TerminalKind } from "./terminal";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const isTauri = () => typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

export const DEFAULT_INBOX_SETTINGS: InboxSettings = {
  inboxRoot: "inbox/downloads",
  sources: ["outlook", "sharepoint", "gmail", "kakao", "telegram", "downloads"],
  gwsPath: null,
};

export async function getSampleVaultPath(): Promise<string> {
  if (!isTauri()) return MOCK_VAULT_PATH;
  return invoke<string>("sample_vault_path");
}

export async function chooseVaultDirectory(title: string): Promise<string | null> {
  if (!isTauri()) return MOCK_VAULT_PATH;
  const selected = await open({
    directory: true,
    multiple: false,
    title,
  });
  return typeof selected === "string" ? selected : null;
}

export async function chooseWorkspaceDirectory(title: string): Promise<string | null> {
  return chooseVaultDirectory(title);
}

export async function chooseFiles(title: string): Promise<string[]> {
  if (!isTauri()) return [];
  const selected = await open({
    directory: false,
    multiple: true,
    title,
  });
  if (Array.isArray(selected)) return selected.filter((item): item is string => typeof item === "string");
  return typeof selected === "string" ? [selected] : [];
}

export async function chooseSaveFile(
  title: string,
  defaultPath?: string,
): Promise<string | null> {
  if (!isTauri()) return null;
  const selected = await save({
    title,
    defaultPath,
  });
  return typeof selected === "string" ? selected : null;
}

export async function scanVault(vaultPath: string): Promise<VaultEntry[]> {
  if (!isTauri()) return mockEntries(vaultPath);
  return invoke<VaultEntry[]>("scan_vault", { vaultPath });
}

export async function readVaultCache(vaultPath: string): Promise<VaultEntry[] | null> {
  if (!isTauri()) return mockEntries(vaultPath);
  return invoke<VaultEntry[] | null>("read_vault_cache", { vaultPath });
}

export async function scanInboxDrop(vaultPath: string): Promise<InboxDropItem[]> {
  if (!isTauri()) return mockInboxDropItems();
  return invoke<InboxDropItem[]>("scan_inbox_drop", { vaultPath });
}

export async function readDocument(
  vaultPath: string,
  documentPath: string,
): Promise<DocumentPayload> {
  if (!isTauri()) return readMockDocument(documentPath);
  return invoke<DocumentPayload>("read_document", { vaultPath, documentPath });
}

export async function saveDocument(
  vaultPath: string,
  documentPath: string,
  content: string,
): Promise<DocumentPayload> {
  if (!isTauri()) {
    const doc = readMockDocument(documentPath);
    doc.content = content;
    doc.body = content.replace(/^---[\s\S]*?---\n/, "");
    return doc;
  }
  return invoke<DocumentPayload>("save_document", { vaultPath, documentPath, content });
}

/** Patch a single frontmatter field while preserving order + comments of
 *  every other key. Pass `value: null` to delete. */
export async function updateFrontmatterField(
  vaultPath: string,
  documentPath: string,
  key: string,
  value: string | string[] | number | boolean | null,
): Promise<DocumentPayload> {
  if (!isTauri()) {
    const doc = readMockDocument(documentPath);
    return doc;
  }
  return invoke<DocumentPayload>("update_frontmatter_field", {
    vaultPath,
    documentPath,
    key,
    value,
  });
}

export async function createDocument(
  vaultPath: string,
  title: string,
  docType: string,
  body: string,
  targetRelPath?: string | null,
): Promise<CreatedDocument> {
  if (!isTauri()) return mockCreateDocument(title, docType, body);
  return invoke<CreatedDocument>("create_document", {
    vaultPath,
    title,
    docType,
    body,
    targetRelPath: targetRelPath ?? null,
  });
}

export async function createVersion(
  vaultPath: string,
  documentPath: string,
  title: string,
  content: string,
  summary: string,
): Promise<VersionSnapshot> {
  if (!isTauri()) return mockCreateVersion(title);
  return invoke<VersionSnapshot>("create_version", {
    vaultPath,
    documentPath,
    title,
    content,
    summary,
  });
}

// === Workspace registry ===

export async function listWorkspaceRoots(): Promise<WorkspaceRegistry> {
  if (!isTauri()) return mockWorkspaceRegistry();
  return invoke<WorkspaceRegistry>("list_workspace_roots");
}

export async function addWorkspaceRoot(
  entry: WorkspaceRootEntry,
): Promise<WorkspaceRegistry> {
  if (!isTauri()) return mockWorkspaceRegistry();
  return invoke<WorkspaceRegistry>("add_workspace_root", { entry });
}

export async function removeWorkspaceRoot(path: string): Promise<WorkspaceRegistry> {
  if (!isTauri()) return mockWorkspaceRegistry();
  return invoke<WorkspaceRegistry>("remove_workspace_root", { path });
}

export async function setActiveWorkspaceRoot(
  path: string,
  visibility: WorkspaceVisibility,
): Promise<WorkspaceRegistry> {
  if (!isTauri()) return mockSetActiveWorkspaceRoot(path, visibility);
  return invoke<WorkspaceRegistry>("set_active_workspace_root", { path, visibility });
}

export async function refreshWorkspaceCapabilities(path: string): Promise<WorkspaceRegistry> {
  if (!isTauri()) return mockWorkspaceRegistry();
  return invoke<WorkspaceRegistry>("refresh_workspace_capabilities", { path });
}

// === Git ===

export async function gitStatus(vaultPath: string): Promise<GitStatus> {
  if (!isTauri()) {
    return { isRepo: false, modified: 0, staged: 0, untracked: 0, untrackedKnown: true, clean: true, branch: null };
  }
  return invoke<GitStatus>("git_status", { vaultPath });
}

export async function gitStatusFast(vaultPath: string): Promise<GitStatus> {
  if (!isTauri()) {
    return { isRepo: false, modified: 0, staged: 0, untracked: 0, untrackedKnown: false, clean: true, branch: null };
  }
  return invoke<GitStatus>("git_status_fast", { vaultPath });
}

export async function gitCommit(
  vaultPath: string,
  message: string,
  paths?: string[],
): Promise<GitStatus> {
  if (!isTauri()) {
    return { isRepo: false, modified: 0, staged: 0, untracked: 0, untrackedKnown: true, clean: true, branch: null };
  }
  return invoke<GitStatus>("git_commit", { vaultPath, message, paths: paths ?? null });
}

export async function gitChanges(vaultPath: string): Promise<GitFileChange[]> {
  if (!isTauri()) return [];
  return invoke<GitFileChange[]>("git_changes", { vaultPath });
}

export async function gitDiff(vaultPath: string, filePath: string): Promise<string> {
  if (!isTauri()) return "";
  return invoke<string>("git_diff", { vaultPath, filePath });
}

export async function revealInFileManager(
  vaultPath: string,
  targetPath: string,
): Promise<void> {
  if (!isTauri()) {
    throw new Error("Reveal in Finder requires the Tauri app.");
  }
  await invoke("reveal_in_file_manager", { vaultPath, targetPath });
}

// === Phase 2 inbox watcher / AI bridge / classifier ===

export async function startInboxWatcher(vaultPath: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("start_inbox_watcher", { vaultPath });
}

export async function stopInboxWatcher(): Promise<void> {
  if (!isTauri()) return;
  await invoke("stop_inbox_watcher");
}

/** Build the prompt anchor sends to Claude for one inbox item. Pure
 *  Rust side — keeps the prompt template under version control instead
 *  of in TS. */
export async function buildInboxClassificationPrompt(item: InboxDropItem): Promise<string> {
  if (!isTauri()) {
    return `[mock] classify ${item.relPath} (${item.source})`;
  }
  return invoke<string>("build_inbox_classification_prompt", { item });
}

/** Parse Claude's classifier reply. Tolerant of fences + surrounding
 *  prose; collapses unknown categories to `noise`. */
export async function parseInboxClassification(raw: string): Promise<InboxClassification> {
  if (!isTauri()) {
    // Browser dev fallback — synthesize a Classification from the
    // heuristic the old InboxPane used so the UI is exercised without
    // a real Claude subprocess.
    return mockClassification(raw);
  }
  return invoke<InboxClassification>("parse_inbox_classification", { raw });
}

/** Spawn the Claude CLI for a one-shot prompt. Returns the invocation
 *  id; caller subscribes to the `ai://output` and `ai://done` events
 *  with that id to accumulate output. */
export async function startClaudeCliInvocation(
  prompt: string,
  cwd: string | null = null,
  extraArgs: string[] | null = null,
): Promise<string> {
  if (!isTauri()) {
    throw new Error("Claude CLI invocation is only available inside the Tauri shell.");
  }
  return invoke<string>("start_claude_cli_invocation", { prompt, cwd, extraArgs });
}

// === Integrated terminal ===

export function terminalAvailable(): boolean {
  return isTauri();
}

export interface TerminalSpawnOptions {
  command?: string | null;
  extraArgs?: string[] | null;
  cols?: number | null;
  rows?: number | null;
}

export async function terminalSpawn(
  sessionId: string,
  kind: TerminalKind,
  cwd: string | null = null,
  options: TerminalSpawnOptions = {},
): Promise<string> {
  if (!isTauri()) {
    throw new Error("Integrated terminal is only available inside the Tauri shell.");
  }
  return invoke<string>("terminal_spawn", {
    sessionId,
    kind,
    cwd,
    command: options.command ?? null,
    extraArgs: options.extraArgs ?? null,
    cols: options.cols ?? null,
    rows: options.rows ?? null,
  });
}

export async function terminalWrite(sessionId: string, data: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("terminal_write", { sessionId, data });
}

export async function terminalResize(
  sessionId: string,
  cols: number,
  rows: number,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("terminal_resize", { sessionId, cols, rows });
}

export async function terminalKill(sessionId: string): Promise<void> {
  if (!isTauri()) return;
  await invoke("terminal_kill", { sessionId });
}

/** Pull unread Gmail messages via the user's existing `gws` Google
 *  Workspace CLI. Returns id / from / subject / date — anchor never
 *  fetches the message body, just the envelope, matching the Phase 2
 *  triage surface. Empty `query` falls back to gws's default
 *  `is:unread`. */
export async function fetchGmailUnread(
  maxOrVaultPath: number | string | null = null,
  queryOrMax: string | number | null = null,
  maybeQuery: string | null = null,
): Promise<GmailMessage[]> {
  if (!isTauri()) {
    return mockGmailUnread();
  }
  const vaultPath = typeof maxOrVaultPath === "string" ? maxOrVaultPath : null;
  const max = typeof maxOrVaultPath === "number" ? maxOrVaultPath : typeof queryOrMax === "number" ? queryOrMax : null;
  const query = typeof queryOrMax === "string" ? queryOrMax : maybeQuery;
  return invoke<GmailMessage[]>("fetch_gmail_unread", { vaultPath, max, query });
}

export async function readInboxSettings(vaultPath: string): Promise<InboxSettings> {
  if (!isTauri()) return { ...DEFAULT_INBOX_SETTINGS };
  return invoke<InboxSettings>("read_inbox_settings", { vaultPath });
}

export async function saveInboxSettings(
  vaultPath: string,
  settings: InboxSettings,
): Promise<InboxSettings> {
  if (!isTauri()) return settings;
  return invoke<InboxSettings>("save_inbox_settings", { vaultPath, settings });
}

// === Right pane file shelf / memos ===

export async function storeShelfFiles(
  vaultPath: string,
  sources: string[],
  operation: FileStoreOperation,
): Promise<StoredFileOutcome[]> {
  if (!isTauri()) {
    return sources.map((sourcePath) => ({
      sourcePath,
      targetPath: `${vaultPath}/.anchor/stash/files/${sourcePath.split("/").pop() ?? "file"}`,
      fileName: sourcePath.split("/").pop() ?? "file",
      operation,
    }));
  }
  return invoke<StoredFileOutcome[]>("store_shelf_files", { vaultPath, sources, operation });
}

export async function storeShelfFilesAs(
  sources: string[],
  targetDir: string,
  operation: FileStoreOperation,
): Promise<StoredFileOutcome[]> {
  if (!isTauri()) {
    return sources.map((sourcePath) => ({
      sourcePath,
      targetPath: `${targetDir}/${sourcePath.split("/").pop() ?? "file"}`,
      fileName: sourcePath.split("/").pop() ?? "file",
      operation,
    }));
  }
  return invoke<StoredFileOutcome[]>("store_shelf_files_as", {
    sources,
    targetDir,
    operation,
  });
}

export async function listMemos(vaultPath: string): Promise<MemoEntry[]> {
  if (!isTauri()) return [];
  return invoke<MemoEntry[]>("list_memos", { vaultPath });
}

export async function readMemo(
  vaultPath: string,
  memoPath: string,
): Promise<MemoDocument> {
  if (!isTauri()) {
    return {
      name: memoPath.split("/").pop() ?? "memo.md",
      path: memoPath,
      format: memoPath.endsWith(".txt") ? "plain" : "markdown",
      updatedAt: null,
      sizeBytes: 0,
      preview: "",
      content: "",
    };
  }
  return invoke<MemoDocument>("read_memo", { vaultPath, memoPath });
}

export async function saveMemo(
  vaultPath: string,
  name: string,
  format: MemoFormat,
  content: string,
): Promise<MemoDocument> {
  if (!isTauri()) {
    const ext = format === "plain" ? "txt" : "md";
    const leaf = (name.trim() || `memo.${ext}`).split("/").pop() ?? `memo.${ext}`;
    const fileName = `${leaf.replace(/\.(md|markdown|txt)$/i, "")}.${ext}`;
    return {
      name: fileName,
      path: `${vaultPath}/.anchor/memos/${fileName}`,
      format,
      updatedAt: null,
      sizeBytes: content.length,
      preview: content.trim().slice(0, 160),
      content,
    };
  }
  return invoke<MemoDocument>("save_memo", { vaultPath, name, format, content });
}

export async function deleteMemo(
  vaultPath: string,
  memoPath: string,
): Promise<void> {
  if (!isTauri()) return;
  await invoke("delete_memo", { vaultPath, memoPath });
}

export async function saveMemoAs(
  targetPath: string,
  content: string,
): Promise<MemoDocument> {
  if (!isTauri()) {
    return {
      name: targetPath.split("/").pop() ?? "memo.md",
      path: targetPath,
      format: targetPath.endsWith(".txt") ? "plain" : "markdown",
      updatedAt: null,
      sizeBytes: content.length,
      preview: content.trim().slice(0, 160),
      content,
    };
  }
  return invoke<MemoDocument>("save_memo_as", { targetPath, content });
}

function mockGmailUnread(): GmailMessage[] {
  return [
    {
      id: "mock-1",
      from: "boss <boss@example.com>",
      subject: "[mock] Q2 운영회의 일정 조율",
      date: "Tue, 28 Apr 2026 09:00:00 +0900",
    },
    {
      id: "mock-2",
      from: "no-reply@plaud.ai",
      subject: "[mock] Plaud-AutoFlow 회의 요약",
      date: "Tue, 28 Apr 2026 00:29:08 +0000",
    },
  ];
}

function mockClassification(raw: string): InboxClassification {
  const lower = raw.toLowerCase();
  if (lower.includes("meeting") || lower.includes("회의")) {
    return {
      category: "meeting",
      summary: "회의 관련 파일로 추정됩니다.",
      suggestedFolder: "meetings",
      extractedDate: null,
    };
  }
  if (lower.includes("task") || lower.includes("todo") || lower.includes("할일")) {
    return {
      category: "task",
      summary: "처리할 작업 항목이 포함됐을 수 있습니다.",
      suggestedFolder: null,
      extractedDate: null,
    };
  }
  if (lower.includes("budget") || lower.includes("kpi") || lower.endsWith(".pdf")) {
    return {
      category: "reference",
      summary: "참고자료 또는 행정 첨부로 추정됩니다.",
      suggestedFolder: "references",
      extractedDate: null,
    };
  }
  return {
    category: "noise",
    summary: "분류기 모의 응답.",
    suggestedFolder: null,
    extractedDate: null,
  };
}

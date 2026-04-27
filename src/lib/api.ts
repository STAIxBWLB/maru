import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  MOCK_VAULT_PATH,
  mockCreateDocument,
  mockCreateVersion,
  mockEntries,
  mockVaultList,
  readMockDocument,
} from "./fixtures";
import type {
  CreatedDocument,
  DocumentPayload,
  GitFileChange,
  GitStatus,
  VaultEntry,
  VaultList,
  VersionSnapshot,
} from "./types";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const isTauri = () => typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);

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

export async function scanVault(vaultPath: string): Promise<VaultEntry[]> {
  if (!isTauri()) return mockEntries();
  return invoke<VaultEntry[]>("scan_vault", { vaultPath });
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
): Promise<CreatedDocument> {
  if (!isTauri()) return mockCreateDocument(title, docType, body);
  return invoke<CreatedDocument>("create_document", { vaultPath, title, docType, body });
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

// === Multi-vault registry ===

export async function listVaults(): Promise<VaultList> {
  if (!isTauri()) return mockVaultList();
  return invoke<VaultList>("list_vaults");
}

export async function addVault(
  label: string,
  path: string,
  externalWriter?: string | null,
): Promise<VaultList> {
  if (!isTauri()) return mockVaultList();
  return invoke<VaultList>("add_vault", { label, path, externalWriter: externalWriter ?? null });
}

export async function removeVault(path: string): Promise<VaultList> {
  if (!isTauri()) return mockVaultList();
  return invoke<VaultList>("remove_vault", { path });
}

export async function setActiveVault(path: string): Promise<VaultList> {
  if (!isTauri()) return mockVaultList();
  return invoke<VaultList>("set_active_vault", { path });
}

// === Git ===

export async function gitStatus(vaultPath: string): Promise<GitStatus> {
  if (!isTauri()) {
    return { isRepo: false, modified: 0, staged: 0, untracked: 0, clean: true, branch: null };
  }
  return invoke<GitStatus>("git_status", { vaultPath });
}

export async function gitCommit(vaultPath: string, message: string): Promise<GitStatus> {
  if (!isTauri()) {
    return { isRepo: false, modified: 0, staged: 0, untracked: 0, clean: true, branch: null };
  }
  return invoke<GitStatus>("git_commit", { vaultPath, message });
}

export async function gitChanges(vaultPath: string): Promise<GitFileChange[]> {
  if (!isTauri()) return [];
  return invoke<GitFileChange[]>("git_changes", { vaultPath });
}

export async function gitDiff(vaultPath: string, filePath: string): Promise<string> {
  if (!isTauri()) return "";
  return invoke<string>("git_diff", { vaultPath, filePath });
}

export type DocumentMode = "edit" | "summary" | "report" | "minutes" | "kpi" | "budget";

export interface VaultEntry {
  path: string;
  relPath: string;
  title: string;
  docType: string;
  status: string;
  tags: string[];
  people: string[];
  project: string | null;
  updatedAt: string | null;
  createdAt: string | null;
  wordCount: number;
  snippet: string;
  fileKind: string;
  versionCount: number;
}

export interface DocumentPayload {
  path: string;
  relPath: string;
  title: string;
  content: string;
  body: string;
  meta: Record<string, unknown>;
  fileKind: string;
}

export interface VersionSnapshot {
  path: string;
  relPath: string;
  title: string;
  createdAt: string;
}

export interface CreatedDocument {
  path: string;
  relPath: string;
  title: string;
}

export interface AiDraft {
  provider: string;
  mode: DocumentMode;
  summary: string;
  content: string;
}

export interface KnowledgeReference {
  title: string;
  body: string;
}

export interface AppError {
  message: string;
}

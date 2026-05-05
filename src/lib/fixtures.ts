import type {
  CreatedDocument,
  DeletedDocument,
  DocumentPayload,
  InboxDropItem,
  VaultEntry,
  WorkspaceFileEntry,
  WorkspaceRegistry,
  VersionSnapshot,
} from "./types";

export const MOCK_WORKSPACE_PATH = "mock://anchor-sample-workspace";
export const MOCK_VAULT_PATH = MOCK_WORKSPACE_PATH;
export const MOCK_PUBLIC_WORKSPACE_PATH = "mock://anchor-public-workspace";
export const MOCK_PUBLIC_READONLY_WORKSPACE_PATH = "mock://anchor-sharepoint-workspace";
let mockActivePrivate = MOCK_WORKSPACE_PATH;
let mockActivePublic: string | null = null;

const now = "2026-04-27T09:00:00+09:00";

const sampleContent = `---
type: meeting
status: active
project: "[[Anchor Project]]"
tags:
  - 회의록
people:
  - "[[김하린]]"
created_at: 2026-04-20T09:00:00+09:00
updated_at: ${now}
---
# Anchor 사업 주간 점검 회의

## 메모
참석자들은 사업 KPI 산식과 예산 집행률 보고 기준을 다음 회의 전까지 정리하기로 했다.
`;

const referenceContent = `---
type: reference
status: archived
tags:
  - glossary
created_at: 2026-04-15T10:00:00+09:00
updated_at: 2026-04-22T11:00:00+09:00
---
# Anchor 용어집

## 본부 약어
- HRD : 인재양성본부
- INT : 국제협력본부
`;

export const mockDocuments: DocumentPayload[] = [
  {
    path: `${MOCK_VAULT_PATH}/anchor-weekly-meeting.md`,
    relPath: "anchor-weekly-meeting.md",
    title: "Anchor 사업 주간 점검 회의",
    content: sampleContent,
    body: sampleContent.split("---\n").slice(2).join("---\n").trim(),
    meta: {
      type: "meeting",
      status: "active",
      project: "[[Anchor Project]]",
    },
    fileKind: "md",
  },
  {
    path: `${MOCK_VAULT_PATH}/references/anchor-glossary.md`,
    relPath: "references/anchor-glossary.md",
    title: "Anchor 용어집",
    content: referenceContent,
    body: referenceContent.split("---\n").slice(2).join("---\n").trim(),
    meta: { type: "reference", status: "archived" },
    fileKind: "md",
  },
];

export function mockEntries(rootPath = MOCK_VAULT_PATH): VaultEntry[] {
  return mockDocuments.map((doc, index) => ({
    path: `${rootPath}/${doc.relPath}`,
    relPath: doc.relPath,
    title: doc.title,
    frontmatter: doc.meta,
    updatedAt: index === 0 ? now : "2026-04-22T11:00:00+09:00",
    wordCount: doc.body.split(/\s+/).filter(Boolean).length,
    snippet: doc.body.replace(/\s+/g, " ").slice(0, 220),
    fileKind: doc.fileKind,
    versionCount: 0,
  }));
}

export function mockWorkspaceFiles(rootPath = MOCK_VAULT_PATH): WorkspaceFileEntry[] {
  const docs = mockDocuments.map((doc, index) => ({
    path: `${rootPath}/${doc.relPath}`,
    relPath: doc.relPath,
    name: doc.relPath.split("/").pop() ?? doc.relPath,
    extension: doc.fileKind,
    fileKind: doc.fileKind,
    sizeBytes: doc.content.length,
    updatedAt: index === 0 ? now : "2026-04-22T11:00:00+09:00",
    gitTracked: true,
    binary: false,
  }));
  return [
    ...docs,
    {
      path: `${rootPath}/attachments/rise-budget-review.pdf`,
      relPath: "attachments/rise-budget-review.pdf",
      name: "rise-budget-review.pdf",
      extension: "pdf",
      fileKind: "pdf",
      sizeBytes: 184_320,
      updatedAt: "2026-04-26T14:30:00+09:00",
      gitTracked: false,
      binary: true,
    },
    {
      path: `${rootPath}/templates/minutes-template.md`,
      relPath: "templates/minutes-template.md",
      name: "minutes-template.md",
      extension: "md",
      fileKind: "md",
      sizeBytes: 1_024,
      updatedAt: "2026-04-20T10:00:00+09:00",
      gitTracked: true,
      binary: false,
    },
  ];
}

export function readMockDocument(path: string): DocumentPayload {
  const found = findMockDocument(path);
  if (!found) return mockDocuments[0];
  return found;
}

export function mockMoveDocument(
  documentPath: string,
  targetRelPath: string,
): DocumentPayload {
  const found = findMockDocument(documentPath);
  if (!found) throw new Error("Document file does not exist");
  const relPath = normalizeMockTargetRelPath(targetRelPath);
  if (mockDocuments.some((doc) => doc.relPath === relPath && doc !== found)) {
    throw new Error("A document already exists at that path");
  }
  const rootPath = mockRootForPath(documentPath, found.relPath, found.path);
  found.relPath = relPath;
  found.path = `${rootPath}/${relPath}`;
  found.fileKind = "md";
  return found;
}

export function mockDuplicateDocument(documentPath: string): DocumentPayload {
  const found = findMockDocument(documentPath);
  if (!found) throw new Error("Document file does not exist");
  const rootPath = mockRootForPath(documentPath, found.relPath, found.path);
  const folder = found.relPath.includes("/")
    ? `${found.relPath.split("/").slice(0, -1).join("/")}/`
    : "";
  const stem = (found.relPath.split("/").pop() ?? "document").replace(/\.(md|markdown)$/i, "");
  let counter = 1;
  let relPath = "";
  do {
    relPath = `${folder}${stem}${counter === 1 ? "-copy" : `-copy-${counter}`}.md`;
    counter += 1;
  } while (mockDocuments.some((doc) => doc.relPath === relPath));
  const next: DocumentPayload = {
    ...found,
    path: `${rootPath}/${relPath}`,
    relPath,
    fileKind: "md",
  };
  mockDocuments.push(next);
  return next;
}

export function mockTrashDocument(documentPath: string): DeletedDocument {
  const found = findMockDocument(documentPath);
  if (!found) throw new Error("Document file does not exist");
  const rootPath = mockRootForPath(documentPath, found.relPath, found.path);
  const index = mockDocuments.indexOf(found);
  if (index >= 0) mockDocuments.splice(index, 1);
  const parts = found.relPath.split("/");
  const fileName = parts.pop() ?? "document.md";
  const folder = parts.length > 0 ? `${parts.join("/")}/` : "";
  const stem = fileName.replace(/\.(md|markdown)$/i, "");
  const trashRelPath = `.anchor/trash/documents/${folder}${stem}-${Date.now()}.md`;
  return {
    originalPath: found.path,
    originalRelPath: found.relPath,
    trashPath: `${rootPath}/${trashRelPath}`,
    trashRelPath,
  };
}

function findMockDocument(path: string): DocumentPayload | undefined {
  return mockDocuments.find(
    (doc) => doc.path === path || doc.relPath === path || path.endsWith(`/${doc.relPath}`),
  );
}

function mockRootForPath(path: string, relPath: string, fallbackPath: string): string {
  if (path.endsWith(`/${relPath}`)) {
    return path.slice(0, -relPath.length - 1);
  }
  if (fallbackPath.endsWith(`/${relPath}`)) {
    return fallbackPath.slice(0, -relPath.length - 1);
  }
  return MOCK_VAULT_PATH;
}

function normalizeMockTargetRelPath(targetRelPath: string): string {
  const trimmed = targetRelPath.trim().replace(/^\/+|\/+$/g, "");
  if (!trimmed || trimmed.includes("..")) throw new Error("Invalid document path");
  return trimmed.replace(/\.(md|markdown)$/i, "") + ".md";
}

export function mockCreateDocument(
  title: string,
  docType: string,
  body: string,
): CreatedDocument {
  const relPath = `${title.toLowerCase().replace(/\s+/g, "-")}.md`;
  const content = `---\ntype: ${docType}\nstatus: draft\nupdated_at: ${now}\n---\n# ${title}\n\n${body}`;
  mockDocuments.unshift({
    path: `${MOCK_VAULT_PATH}/${relPath}`,
    relPath,
    title,
    content,
    body,
    meta: { type: docType, status: "draft" },
    fileKind: "md",
  });
  return { path: `${MOCK_VAULT_PATH}/${relPath}`, relPath, title };
}

export function mockCreateVersion(title: string): VersionSnapshot {
  return {
    path: `${MOCK_VAULT_PATH}/.anchor/versions/${Date.now()}.md`,
    relPath: `.anchor/versions/${Date.now()}.md`,
    title: `${title} - mock snapshot`,
    createdAt: now,
  };
}

export function mockWorkspaceRegistry(): WorkspaceRegistry {
  const includePublic =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("mockPublic");
  const workspaces: WorkspaceRegistry["workspaces"] = [
    {
      label: "Sample Workspace",
      path: MOCK_WORKSPACE_PATH,
      visibility: "private",
      provider: "local",
      providerId: null,
      externalWriter: null,
      writePolicy: "direct",
      permissionSummary: {
        role: null,
        source: "filesystem",
        checkedAt: "2026-04-27T09:00:00+09:00",
        capabilities: {
          canRead: true,
          canCreate: true,
          canModify: true,
          canDelete: true,
          canRenameMove: true,
          canShare: true,
          canManageMembers: true,
        },
      },
    },
  ];
  if (includePublic) {
    workspaces.push({
      label: "Public Workspace",
      path: MOCK_PUBLIC_WORKSPACE_PATH,
      visibility: "public",
      provider: "googleDrive",
      providerId: "mock-shared-drive",
      externalWriter: null,
      writePolicy: "direct",
      permissionSummary: {
        role: "contentManager",
        source: "manual",
        checkedAt: "2026-04-27T09:00:00+09:00",
        capabilities: {
          canRead: true,
          canCreate: true,
          canModify: true,
          canDelete: true,
          canRenameMove: true,
          canShare: true,
          canManageMembers: false,
        },
      },
    });
    workspaces.push({
      label: "Shared Reference",
      path: MOCK_PUBLIC_READONLY_WORKSPACE_PATH,
      visibility: "public",
      provider: "sharePoint",
      providerId: "mock-site-docs",
      externalWriter: null,
      writePolicy: "direct",
      permissionSummary: {
        role: "Can view",
        source: "manual",
        checkedAt: "2026-04-27T09:00:00+09:00",
        capabilities: {
          canRead: true,
          canCreate: false,
          canModify: false,
          canDelete: false,
          canRenameMove: false,
          canShare: false,
          canManageMembers: false,
        },
      },
    });
  }
  if (!workspaces.some((workspace) => workspace.path === mockActivePrivate)) {
    mockActivePrivate = MOCK_WORKSPACE_PATH;
  }
  if (!includePublic) {
    mockActivePublic = null;
  } else if (!mockActivePublic || !workspaces.some((workspace) => workspace.path === mockActivePublic)) {
    mockActivePublic = MOCK_PUBLIC_WORKSPACE_PATH;
  }
  return {
    workspaces,
    activeByVisibility: {
      private: mockActivePrivate,
      public: includePublic ? mockActivePublic : null,
    },
    hiddenDefaults: [],
  };
}

export function mockSetActiveWorkspaceRoot(
  path: string,
  visibility: "private" | "public",
): WorkspaceRegistry {
  if (visibility === "public") {
    mockActivePublic = path;
  } else {
    mockActivePrivate = path;
  }
  return mockWorkspaceRegistry();
}

export function mockInboxDropItems(): InboxDropItem[] {
  return [
    {
      id: "inbox/downloads/gmail/rise-budget-review.pdf",
      path: `${MOCK_VAULT_PATH}/inbox/downloads/gmail/rise-budget-review.pdf`,
      relPath: "inbox/downloads/gmail/rise-budget-review.pdf",
      title: "rise-budget-review.pdf",
      source: "gmail",
      sizeBytes: 184_320,
      receivedAt: now,
    },
    {
      id: "inbox/downloads/sharepoint/weekly-kpi.xlsx",
      path: `${MOCK_VAULT_PATH}/inbox/downloads/sharepoint/weekly-kpi.xlsx`,
      relPath: "inbox/downloads/sharepoint/weekly-kpi.xlsx",
      title: "weekly-kpi.xlsx",
      source: "sharepoint",
      sizeBytes: 92_104,
      receivedAt: "2026-04-26T14:30:00+09:00",
    },
  ];
}

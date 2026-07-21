import type {
  CreatedDocument,
  DeletedDocument,
  DocumentPayload,
  InboxDropItem,
  MeetingGuides,
  MeetingMetadata,
  MeetingNoteRow,
  TaskMetadata,
  TaskNoteRow,
  VaultEntry,
  WorkspaceFileEntry,
  WorkspaceRegistry,
  VersionSnapshot,
} from "./types";

export const MOCK_WORKSPACE_PATH = "mock://maru-sample-workspace";
export const MOCK_VAULT_PATH = MOCK_WORKSPACE_PATH;
export const MOCK_PUBLIC_WORKSPACE_PATH = "mock://maru-public-workspace";
export const MOCK_PUBLIC_READONLY_WORKSPACE_PATH = "mock://maru-sharepoint-workspace";
let mockActivePrivate = MOCK_WORKSPACE_PATH;
let mockActivePublic: string | null = null;

const now = "2026-04-27T09:00:00+09:00";

const sampleContent = `---
type: meeting
status: active
project: "[[Maru Project]]"
tags:
  - 회의록
people:
  - "[[김하린]]"
created_at: 2026-04-20T09:00:00+09:00
updated_at: ${now}
---
# Maru 사업 주간 점검 회의

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
# Maru 용어집

## 본부 약어
- HRD : 인재양성본부
- INT : 국제협력본부
`;

export const mockDocuments: DocumentPayload[] = [
  {
    path: `${MOCK_VAULT_PATH}/maru-weekly-meeting.md`,
    relPath: "maru-weekly-meeting.md",
    title: "Maru 사업 주간 점검 회의",
    content: sampleContent,
    body: sampleContent.split("---\n").slice(2).join("---\n").trim(),
    meta: {
      type: "meeting",
      status: "active",
      project: "[[Maru Project]]",
    },
    fileKind: "md",
  },
  {
    path: `${MOCK_VAULT_PATH}/references/maru-glossary.md`,
    relPath: "references/maru-glossary.md",
    title: "Maru 용어집",
    content: referenceContent,
    body: referenceContent.split("---\n").slice(2).join("---\n").trim(),
    meta: { type: "reference", status: "archived" },
    fileKind: "md",
  },
];

/**
 * HTML fixtures for the WYSIWYG HTML editor e2e spec. Opt-in via the
 * `?mockHtml=1` query param (same pattern as `mockPublic` in
 * mockWorkspaceRegistry) so the default mock workspace — and every existing
 * spec — stays byte-identical.
 */
const scriptedHtmlContent = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>Maru HTML 샘플</title>
<style>body { color: #333; }</style>
<script>window.__maruScriptRan = true</script>
</head>
<body class="report">
<h1>분기 보고서</h1>
<p>스크립트를 포함한 본문입니다.</p>
</body>
</html>
`;

const cleanHtmlContent = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>Clean Report</title>
<style>body { margin: 0; }</style>
</head>
<body class="clean">
<h1>클린 문서</h1>
<p>스크립트 없는 본문입니다.</p>
</body>
</html>
`;

const malformedHtmlContent = `<html><head><title>Broken</title>
<p>body 태그가 없는 문서입니다.`;

const remoteAssetsHtmlContent = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<title>Remote Assets</title>
</head>
<body>
<p>원격 이미지를 포함한 문서입니다.</p>
<img src="https://example.com/tracker.png" alt="tracker">
<img src="./local-image.png" alt="local">
</body>
</html>
`;

const mockHtmlDocuments: DocumentPayload[] = [
  {
    path: `${MOCK_VAULT_PATH}/sample-page.html`,
    relPath: "sample-page.html",
    title: "HTML 샘플 리포트",
    content: scriptedHtmlContent,
    body: scriptedHtmlContent,
    meta: {},
    fileKind: "html",
  },
  {
    path: `${MOCK_VAULT_PATH}/clean-report.html`,
    relPath: "clean-report.html",
    title: "클린 HTML 문서",
    content: cleanHtmlContent,
    body: cleanHtmlContent,
    meta: {},
    fileKind: "html",
  },
  {
    path: `${MOCK_VAULT_PATH}/malformed.html`,
    relPath: "malformed.html",
    title: "깨진 HTML 문서",
    content: malformedHtmlContent,
    body: malformedHtmlContent,
    meta: {},
    fileKind: "html",
  },
  {
    path: `${MOCK_VAULT_PATH}/remote-assets.html`,
    relPath: "remote-assets.html",
    title: "원격 자산 HTML 문서",
    content: remoteAssetsHtmlContent,
    body: remoteAssetsHtmlContent,
    meta: {},
    fileKind: "html",
  },
];

function mockHtmlEnabled(): boolean {
  return (
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("mockHtml")
  );
}

function allMockDocuments(): DocumentPayload[] {
  return mockHtmlEnabled() ? [...mockDocuments, ...mockHtmlDocuments] : mockDocuments;
}

export function mockEntries(rootPath = MOCK_VAULT_PATH): VaultEntry[] {
  return allMockDocuments().map((doc, index) => ({
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

/** Mock community overlay for e2e — lets the enriched graph path run in web mode
 *  (opt-in via a localStorage flag; see api.vaultGraphRead). Communities are
 *  keyed by the live-graph node ids (lowercase stem / ghost target). */
export function mockVaultGraphFile(): import("./graph/model").VaultGraphFile {
  return {
    nodes: [
      { id: "maru-weekly-meeting", community: 0 },
      { id: "maru-glossary", community: 1 },
      { id: "maru-project", community: 1 },
    ],
    edges: [],
  };
}

export function mockWorkspaceFiles(rootPath = MOCK_VAULT_PATH): WorkspaceFileEntry[] {
  const docs = allMockDocuments().map((doc, index) => ({
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
      path: `${rootPath}/attachments/sample-report.docx`,
      relPath: "attachments/sample-report.docx",
      name: "sample-report.docx",
      extension: "docx",
      fileKind: "docx",
      sizeBytes: 72_704,
      updatedAt: "2026-04-26T14:32:00+09:00",
      gitTracked: false,
      binary: true,
    },
    {
      path: `${rootPath}/attachments/weekly-kpi.xlsx`,
      relPath: "attachments/weekly-kpi.xlsx",
      name: "weekly-kpi.xlsx",
      extension: "xlsx",
      fileKind: "xlsx",
      sizeBytes: 92_104,
      updatedAt: "2026-04-26T14:33:00+09:00",
      gitTracked: false,
      binary: true,
    },
    {
      path: `${rootPath}/attachments/raw-dump.bin`,
      relPath: "attachments/raw-dump.bin",
      name: "raw-dump.bin",
      extension: "bin",
      fileKind: "bin",
      sizeBytes: 4_096,
      updatedAt: "2026-04-26T14:35:00+09:00",
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
  const trashRelPath = `.maru/trash/documents/${folder}${stem}-${Date.now()}.md`;
  return {
    originalPath: found.path,
    originalRelPath: found.relPath,
    trashPath: `${rootPath}/${trashRelPath}`,
    trashRelPath,
  };
}

function findMockDocument(path: string): DocumentPayload | undefined {
  return allMockDocuments().find(
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
    path: `${MOCK_VAULT_PATH}/.maru/versions/${Date.now()}.md`,
    relPath: `.maru/versions/${Date.now()}.md`,
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

export function mockMeetingNoteRows(rootPath = MOCK_VAULT_PATH): MeetingNoteRow[] {
  return [
    {
      path: `${rootPath}/meetings/2026/2026-04/04-20 회의 - Maru 사업 주간 점검 - KPI.md`,
      relPath: "meetings/2026/2026-04/04-20 회의 - Maru 사업 주간 점검 - KPI.md",
      fileName: "04-20 회의 - Maru 사업 주간 점검 - KPI.md",
      sizeBytes: sampleContent.length,
      updatedAt: now,
      frontmatter: { title: "Maru 사업 주간 점검 (KPI)" },
    },
    {
      path: `${rootPath}/meetings/2026/2026-05/05-04 상담 - Skills 관리 - Codex.md`,
      relPath: "meetings/2026/2026-05/05-04 상담 - Skills 관리 - Codex.md",
      fileName: "05-04 상담 - Skills 관리 - Codex.md",
      sizeBytes: referenceContent.length,
      updatedAt: "2026-05-04T11:00:00+09:00",
      frontmatter: {},
    },
  ];
}

export function mockMeetingMetadata(relPath: string): MeetingMetadata {
  return {
    relPath,
    frontmatter: {
      type: "meeting",
      tags: ["회의록", "maru"],
      attendees: ["Young Joon Lee", "Maru Team"],
      date: "2026-04-20",
    },
    tags: ["회의록", "maru"],
    attendees: ["Young Joon Lee", "Maru Team"],
    date: "2026-04-20",
    preview: "# Maru 사업 주간 점검\n\nKPI 산식과 예산 집행률 기준을 정리한다.",
    lineCount: 3,
    charCount: 44,
  };
}

export function mockMeetingGuides(): MeetingGuides {
  return {
    quickStart: "# Quick Start\n\n6 sections.",
    glossary: "# Glossary\n\nMaru = local-first workspace.",
    people: "# People\n\nYoung Joon Lee.",
    tagStandards: "# Tags\n\n#회의록",
    notesGuidelines: "# Notes Guidelines\n\nUse concise Korean.",
  };
}

export function mockTaskNoteRows(rootPath = MOCK_VAULT_PATH): TaskNoteRow[] {
  return [
    {
      path: `${rootPath}/tasks/active/260514-maru-tasks-mode.md`,
      relPath: "tasks/active/260514-maru-tasks-mode.md",
      fileName: "260514-maru-tasks-mode.md",
      bucket: "active",
      sizeBytes: 320,
      updatedAt: now,
      frontmatter: {
        title: "Maru tasks mode",
        status: "active",
        priority: "high",
        due: "2026-05-14",
        project: "Maru",
        topics: ["tasks", "ui"],
      },
    },
    {
      path: `${rootPath}/tasks/backlog/260515-google-sync-review.md`,
      relPath: "tasks/backlog/260515-google-sync-review.md",
      fileName: "260515-google-sync-review.md",
      bucket: "backlog",
      sizeBytes: 210,
      updatedAt: "2026-05-13T11:00:00+09:00",
      frontmatter: {
        title: "Google sync review",
        status: "backlog",
        priority: "medium",
        project: "Maru",
      },
    },
  ];
}

export function mockTaskMetadata(relPath: string): TaskMetadata {
  return {
    relPath,
    frontmatter: {
      title: "Maru tasks mode",
      status: "active",
      priority: "high",
      due: "2026-05-14",
      project: "Maru",
      tags: ["tasks", "maru"],
    },
    tags: ["tasks", "maru"],
    body: "# Maru tasks mode\n\nAdd first-class task management.",
    preview: "# Maru tasks mode\n\nAdd first-class task management.",
    lineCount: 4,
    charCount: 58,
  };
}

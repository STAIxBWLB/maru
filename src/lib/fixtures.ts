import type { AiDraft, CreatedDocument, DocumentMode, DocumentPayload, VaultEntry, VersionSnapshot } from "./types";

export const MOCK_VAULT_PATH = "mock://anchor-sample-vault";

const now = "2026-04-27T09:00:00+09:00";

const sampleContent = `---
type: Document
status: active
project: Anchor Project
tags:
  - RISE
  - 보고서
people:
  - 김하린
  - 오세준
created_at: 2026-04-20T09:00:00+09:00
updated_at: ${now}
---
# 2026 Anchor Project 운영 보고

## 추진 개요
제주한라대학교 Anchor Project는 AI Native Campus 전환과 지역혁신 중심 인재양성을 함께 추진한다.

## 주요 쟁점
- 핵심인재양성본부의 AI 융합전공 참여 지표 확정 필요
- 런케이션본부 프로그램 일정과 예산 집행률 동시 점검 필요
- 해외인재본부 Study Jeju 참여자 모집 경로 정리 필요

## 다음 조치
- 2분기 운영위원회 보고 전 KPI 표 정리
- 예산 과목 310, 330, 340 집행 근거 확인
- 회의록과 보고서 표현을 개조식으로 통일
`;

const meetingContent = `---
type: Meeting
status: draft
project: Anchor Project
tags:
  - 회의록
created_at: 2026-04-24T15:00:00+09:00
updated_at: 2026-04-24T17:30:00+09:00
---
# Anchor 사업 주간 점검 회의

## 메모
참석자들은 핵심인재양성본부 KPI 산식과 예산 집행률 보고 기준을 다음 회의 전까지 정리하기로 했다.
`;

export const mockDocuments: DocumentPayload[] = [
  {
    path: `${MOCK_VAULT_PATH}/2026-anchor-project-report.md`,
    relPath: "2026-anchor-project-report.md",
    title: "2026 Anchor Project 운영 보고",
    content: sampleContent,
    body: sampleContent.split("---\n").slice(2).join("---\n").trim(),
    meta: { type: "Document", status: "active", project: "Anchor Project" },
    fileKind: "md",
  },
  {
    path: `${MOCK_VAULT_PATH}/anchor-weekly-meeting.md`,
    relPath: "anchor-weekly-meeting.md",
    title: "Anchor 사업 주간 점검 회의",
    content: meetingContent,
    body: meetingContent.split("---\n").slice(2).join("---\n").trim(),
    meta: { type: "Meeting", status: "draft", project: "Anchor Project" },
    fileKind: "md",
  },
];

export function mockEntries(): VaultEntry[] {
  return mockDocuments.map((doc, index) => ({
    path: doc.path,
    relPath: doc.relPath,
    title: doc.title,
    docType: String(doc.meta.type ?? "Document"),
    status: String(doc.meta.status ?? "draft"),
    tags: index === 0 ? ["RISE", "보고서"] : ["회의록"],
    people: index === 0 ? ["김하린", "오세준"] : [],
    project: "Anchor Project",
    updatedAt: index === 0 ? now : "2026-04-24T17:30:00+09:00",
    createdAt: index === 0 ? "2026-04-20T09:00:00+09:00" : "2026-04-24T15:00:00+09:00",
    wordCount: doc.body.split(/\s+/).length,
    snippet: doc.body.replace(/\s+/g, " ").slice(0, 220),
    fileKind: doc.fileKind,
    versionCount: index === 0 ? 2 : 0,
  }));
}

export function readMockDocument(path: string): DocumentPayload {
  const found = mockDocuments.find((doc) => doc.path === path || doc.relPath === path);
  if (!found) return mockDocuments[0];
  return found;
}

export function mockAiDraft(mode: DocumentMode, instruction: string, content: string): AiDraft {
  const title = content.match(/^#\s+(.+)$/m)?.[1] ?? "Anchor 문서";
  return {
    provider: "browser-mock",
    mode,
    summary: `'${instruction}' 요청 기준으로 브라우저 mock 초안을 생성함`,
    content: `---
type: Document
status: draft
source: browser-mock
updated_at: ${now}
---
# ${title}

## 수정 방향
○ 요청사항: ${instruction}
- 제주한라대학교와 RISE Project 표기를 유지함
- 개조식 문체로 핵심 실행 과제를 정리함
- KPI, 예산, 일정 근거 확인 항목을 분리함

## 재작성 초안
${content.replace(/^---[\s\S]*?---\n/, "").split("\n").slice(0, 10).join("\n")}

## 검토 체크
- 고유명사 표기 확인
- 담당 부서와 일정 보강
- 수치 근거 확인
`,
  };
}

export function mockCreateDocument(title: string, docType: string, body: string): CreatedDocument {
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

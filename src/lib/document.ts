import type { DocumentPayload, VaultEntry } from "./types";

export function formatRelativeDate(value: string | null): string {
  if (!value) return "날짜 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function statusLabel(status: string): string {
  const map: Record<string, string> = {
    active: "진행",
    draft: "초안",
    review: "검토",
    done: "완료",
    snapshot: "스냅샷",
  };
  return map[status] ?? status;
}

export function docTypeLabel(type: string): string {
  const map: Record<string, string> = {
    Document: "문서",
    Meeting: "회의",
    Project: "사업",
    Person: "인물",
    Task: "과제",
    Template: "템플릿",
    Reference: "참조",
    Version: "버전",
  };
  return map[type] ?? type;
}

export function filterEntries(entries: VaultEntry[], query: string, type: string): VaultEntry[] {
  const q = query.trim().toLowerCase();
  return entries.filter((entry) => {
    const matchesType = type === "All" || entry.docType === type;
    if (!matchesType) return false;
    if (!q) return true;
    return [entry.title, entry.snippet, entry.project ?? "", entry.tags.join(" "), entry.people.join(" ")]
      .join(" ")
      .toLowerCase()
      .includes(q);
  });
}

export function markdownPreview(content: string): string {
  const body = content.replace(/^---[\s\S]*?---\n/, "").trim();
  const escaped = escapeHtml(body);
  return escaped
    .replace(/^# (.+)$/gm, "<h1>$1</h1>")
    .replace(/^## (.+)$/gm, "<h2>$1</h2>")
    .replace(/^### (.+)$/gm, "<h3>$1</h3>")
    .replace(/^- \[ \] (.+)$/gm, "<p class=\"task-line\"><span></span>$1</p>")
    .replace(/^- (.+)$/gm, "<p class=\"bullet-line\">$1</p>")
    .replace(/^○ (.+)$/gm, "<p class=\"circle-line\">$1</p>")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/^(?!<h|<p|<table)(.+)$/gm, "<p>$1</p>");
}

export function documentStats(doc: DocumentPayload | null): { words: number; lines: number; chars: number } {
  if (!doc) return { words: 0, lines: 0, chars: 0 };
  return {
    words: doc.body.split(/\s+/).filter(Boolean).length,
    lines: doc.content.split("\n").length,
    chars: doc.content.length,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

import * as Tabs from "@radix-ui/react-tabs";
import {
  Check,
  Clock3,
  Eye,
  FileText,
  PanelRightOpen,
  Save,
  SplitSquareVertical,
} from "lucide-react";
import { documentStats, markdownPreview } from "../lib/document";
import type { DocumentPayload } from "../lib/types";
import { Button } from "./ui/Button";

interface EditorPaneProps {
  document: DocumentPayload | null;
  draftContent: string;
  saving: boolean;
  dirty: boolean;
  onChange: (content: string) => void;
  onSave: () => void;
  onSnapshot: () => void;
  onToggleAi: () => void;
}

export function EditorPane({
  document,
  draftContent,
  saving,
  dirty,
  onChange,
  onSave,
  onSnapshot,
  onToggleAi,
}: EditorPaneProps) {
  const stats = documentStats(document);

  if (!document) {
    return (
      <main className="editor-empty">
        <div className="empty-document-plate">
          <FileText size={34} />
          <h2>문서를 선택하세요</h2>
          <p>왼쪽 목록에서 문서를 열면 원문 편집, 미리보기, AI 초안 생성이 같은 화면에 배치됩니다.</p>
        </div>
      </main>
    );
  }

  const preview = markdownPreview(draftContent);

  return (
    <main className="editor-pane">
      <header className="editor-topbar">
        <div className="editor-title">
          <span className="eyebrow">{document.relPath}</span>
          <h2>{document.title}</h2>
        </div>
        <div className="editor-actions">
          <span className={dirty ? "save-state dirty" : "save-state"}>
            {dirty ? <Clock3 size={13} /> : <Check size={13} />}
            {dirty ? "저장 필요" : "저장됨"}
          </span>
          <Button variant="secondary" onClick={onSnapshot} icon={<SplitSquareVertical size={15} />}>
            버전
          </Button>
          <Button variant="primary" onClick={onSave} disabled={saving || !dirty} icon={<Save size={15} />}>
            {saving ? "저장 중" : "저장"}
          </Button>
          <Button variant="ghost" onClick={onToggleAi} icon={<PanelRightOpen size={15} />}>
            AI
          </Button>
        </div>
      </header>

      <Tabs.Root className="editor-tabs" defaultValue="edit">
        <Tabs.List className="tab-list" aria-label="문서 보기">
          <Tabs.Trigger className="tab-trigger" value="edit">
            원문
          </Tabs.Trigger>
          <Tabs.Trigger className="tab-trigger" value="preview">
            <Eye size={14} />
            미리보기
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content className="tab-panel" value="edit">
          <textarea
            className="source-editor"
            value={draftContent}
            onChange={(event) => onChange(event.target.value)}
            spellCheck={false}
          />
        </Tabs.Content>
        <Tabs.Content className="tab-panel" value="preview">
          <article className="preview-surface" dangerouslySetInnerHTML={{ __html: preview }} />
        </Tabs.Content>
      </Tabs.Root>

      <footer className="editor-status">
        <span>{stats.lines.toLocaleString("ko-KR")} 줄</span>
        <span>{stats.words.toLocaleString("ko-KR")} 단어</span>
        <span>{stats.chars.toLocaleString("ko-KR")} 자</span>
        <span>{document.fileKind.toUpperCase()}</span>
      </footer>
    </main>
  );
}

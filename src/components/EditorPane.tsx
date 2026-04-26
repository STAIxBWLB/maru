import * as Tabs from "@radix-ui/react-tabs";
import { Check, Clock3, Eye, FileText, Save, SplitSquareVertical } from "lucide-react";
import { documentStats, markdownPreview } from "../lib/document";
import type { DocumentPayload } from "../lib/types";
import { useTranslation } from "../lib/i18n";
import { Button } from "./ui/Button";

interface EditorPaneProps {
  document: DocumentPayload | null;
  draftContent: string;
  saving: boolean;
  dirty: boolean;
  onChange: (content: string) => void;
  onSave: () => void;
  onSnapshot: () => void;
}

export function EditorPane({
  document,
  draftContent,
  saving,
  dirty,
  onChange,
  onSave,
  onSnapshot,
}: EditorPaneProps) {
  const { t, locale } = useTranslation();
  const stats = documentStats(document);

  if (!document) {
    return (
      <main className="editor-empty">
        <div className="empty-document-plate">
          <FileText size={34} />
          <h2>{t("editor.empty.title")}</h2>
          <p>{t("editor.empty.description")}</p>
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
            {dirty ? t("editor.dirty") : t("editor.saved")}
          </span>
          <Button
            variant="secondary"
            onClick={onSnapshot}
            icon={<SplitSquareVertical size={15} />}
          >
            {t("editor.snapshot")}
          </Button>
          <Button
            variant="primary"
            onClick={onSave}
            disabled={saving || !dirty}
            icon={<Save size={15} />}
          >
            {saving ? t("editor.saving") : t("editor.save")}
          </Button>
        </div>
      </header>

      <Tabs.Root className="editor-tabs" defaultValue="edit">
        <Tabs.List className="tab-list" aria-label="document view">
          <Tabs.Trigger className="tab-trigger" value="edit">
            {t("editor.tab.edit")}
          </Tabs.Trigger>
          <Tabs.Trigger className="tab-trigger" value="preview">
            <Eye size={14} />
            {t("editor.tab.preview")}
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
        <span>{t("editor.status.lines", { count: stats.lines.toLocaleString(locale) })}</span>
        <span>{t("editor.status.words", { count: stats.words.toLocaleString(locale) })}</span>
        <span>{t("editor.status.chars", { count: stats.chars.toLocaleString(locale) })}</span>
        <span>{document.fileKind.toUpperCase()}</span>
      </footer>
    </main>
  );
}

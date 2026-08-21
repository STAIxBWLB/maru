import * as Tabs from "@radix-ui/react-tabs";
import type { ReactNode } from "react";

export type EditorViewMode = "rich" | "source" | "preview";
export type HtmlViewMode = "visual" | "source" | "preview";
export type DocumentModeKind = "markdown" | "html" | "plain";
export type DocumentMode = EditorViewMode | HtmlViewMode;

interface DocumentModeSurfaceProps {
  kind: DocumentModeKind;
  mode: DocumentMode;
  onModeChange: (mode: DocumentMode) => void;
  richPanel?: ReactNode;
  sourcePanel: ReactNode;
  previewPanel?: ReactNode;
  toolbarAction?: ReactNode;
  auxiliary?: ReactNode;
  className?: string;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

export function DocumentModeSurface({
  kind,
  mode,
  onModeChange,
  richPanel,
  sourcePanel,
  previewPanel,
  toolbarAction,
  auxiliary,
  className = "",
  t,
}: DocumentModeSurfaceProps) {
  const primaryMode = kind === "html" ? "visual" : kind === "markdown" ? "rich" : null;
  const activeMode: DocumentMode = kind === "plain" ? "source" : mode;

  return (
    <Tabs.Root
      className={`editor-tabs document-mode-surface ${className}`.trim()}
      value={activeMode}
      onValueChange={(value) => onModeChange(value as DocumentMode)}
    >
      <div className="editor-view-toolbar">
        <Tabs.List className="editor-tabs-row" aria-label={t("editor.tabs.viewAria")}>
          {primaryMode ? (
            <Tabs.Trigger className="tab-trigger" value={primaryMode}>
              {kind === "html" ? t("editor.tab.visual") : t("editor.tab.rich")}
            </Tabs.Trigger>
          ) : null}
          <Tabs.Trigger className="tab-trigger" value="source">
            {t("editor.tab.source")}
          </Tabs.Trigger>
          {kind !== "plain" ? (
            <Tabs.Trigger className="tab-trigger" value="preview">
              {t("editor.tab.preview")}
            </Tabs.Trigger>
          ) : null}
        </Tabs.List>
        {toolbarAction}
      </div>

      {auxiliary}

      {primaryMode ? (
        <Tabs.Content className="tab-panel" value={primaryMode}>
          {richPanel}
        </Tabs.Content>
      ) : null}
      <Tabs.Content className="tab-panel" value="source">
        {sourcePanel}
      </Tabs.Content>
      {kind !== "plain" ? (
        <Tabs.Content className="tab-panel" value="preview">
          {previewPanel}
        </Tabs.Content>
      ) : null}
    </Tabs.Root>
  );
}

import {
  ClipboardCopy,
  Clock,
  FilePlus2,
  FileImage,
  FileInput,
  FolderOpen,
  ImportIcon,
  LayoutTemplate,
  Save,
  Share,
  Table2,
} from "lucide-react";

import { RibbonButton, RibbonGroup, RibbonSeparator } from "./ribbonPrimitives";

export interface RibbonFileProps {
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onExport: () => void;
  onTemplates: () => void;
  onHistory: () => void;
  onImport: () => void;
  onCopyPng: () => void;
  onCopySvg: () => void;
  onCopyTableHtml: () => void;
  onCopyTableMarkdown: () => void;
  /** "Insert/Update in report" — splices a managed block into a Markdown doc. */
  onInsertInReport: () => void;
  /** Dynamic label: insert vs update vs unknown (checked lazily on tab open). */
  insertInReportLabelKey: string;
  insertInReportBusy?: boolean;
  saving: boolean;
  canSave: boolean;
}

export function RibbonFile({
  onNew,
  onOpen,
  onSave,
  onExport,
  onTemplates,
  onHistory,
  onImport,
  onCopyPng,
  onCopySvg,
  onCopyTableHtml,
  onCopyTableMarkdown,
  onInsertInReport,
  insertInReportLabelKey,
  insertInReportBusy = false,
  saving,
  canSave,
}: RibbonFileProps) {
  return (
    <>
      <RibbonGroup labelKey="diagram.ribbon.group.file">
        <RibbonButton
          labelKey="diagram.toolbar.new"
          onClick={onNew}
          icon={<FilePlus2 size={14} />}
        />
        <RibbonButton
          labelKey="diagram.toolbar.open"
          onClick={onOpen}
          icon={<FolderOpen size={14} />}
        />
        <RibbonButton
          labelKey="diagram.toolbar.save"
          onClick={onSave}
          disabled={saving || !canSave}
          icon={<Save size={14} />}
          variant="primary"
        />
      </RibbonGroup>
      <RibbonSeparator />
      <RibbonGroup labelKey="diagram.ribbon.templates">
        <RibbonButton
          labelKey="diagram.ribbon.templates"
          onClick={onTemplates}
          icon={<LayoutTemplate size={14} />}
        />
      </RibbonGroup>
      <RibbonGroup labelKey="diagram.ribbon.export">
        <RibbonButton
          labelKey="diagram.ribbon.export"
          onClick={onExport}
          icon={<Share size={14} />}
        />
        <RibbonButton
          labelKey="diagram.ribbon.import"
          onClick={onImport}
          icon={<ImportIcon size={14} />}
        />
        <RibbonButton
          labelKey="diagram.ribbon.copyPng"
          onClick={onCopyPng}
          icon={<FileImage size={14} />}
        />
        <RibbonButton
          labelKey="diagram.ribbon.copySvg"
          onClick={onCopySvg}
          icon={<ClipboardCopy size={14} />}
        />
        <RibbonButton
          labelKey="diagram.ribbon.copyTableHtml"
          onClick={onCopyTableHtml}
          icon={<Table2 size={14} />}
        />
        <RibbonButton
          labelKey="diagram.ribbon.copyTableMarkdown"
          onClick={onCopyTableMarkdown}
          icon={<ClipboardCopy size={14} />}
        />
        <RibbonButton
          labelKey={insertInReportLabelKey}
          onClick={onInsertInReport}
          disabled={insertInReportBusy || !canSave}
          icon={<FileInput size={14} />}
        />
      </RibbonGroup>
      <RibbonGroup labelKey="diagram.ribbon.history">
        <RibbonButton
          labelKey="diagram.ribbon.history"
          onClick={onHistory}
          icon={<Clock size={14} />}
        />
      </RibbonGroup>
    </>
  );
}

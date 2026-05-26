import { Clock, FilePlus2, FolderOpen, ImportIcon, LayoutTemplate, Save, Share } from "lucide-react";

import { RibbonButton, RibbonGroup, RibbonSeparator } from "./ribbonPrimitives";

export interface RibbonFileProps {
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onExport: () => void;
  onTemplates: () => void;
  onHistory: () => void;
  onImportMermaid: () => void;
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
  onImportMermaid,
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
          labelKey="diagram.ribbon.importMermaid"
          onClick={onImportMermaid}
          icon={<ImportIcon size={14} />}
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

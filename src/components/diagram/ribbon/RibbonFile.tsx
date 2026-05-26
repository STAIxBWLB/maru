import { FilePlus2, FolderOpen, Save } from "lucide-react";

import { RibbonButton, RibbonGroup } from "./ribbonPrimitives";

export interface RibbonFileProps {
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  saving: boolean;
  canSave: boolean;
}

export function RibbonFile({ onNew, onOpen, onSave, saving, canSave }: RibbonFileProps) {
  return (
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
  );
}

import type { ReactNode } from "react";

import { useTranslation } from "../../../lib/i18n";
import type { RibbonTab } from "../../../lib/diagram/types";
import { RibbonEdit } from "./RibbonEdit";
import { RibbonFile, type RibbonFileProps } from "./RibbonFile";
import { RibbonFormat } from "./RibbonFormat";
import { RibbonInsert, type RibbonInsertProps } from "./RibbonInsert";
import { RibbonTools } from "./RibbonTools";
import { RibbonView, type RibbonViewProps } from "./RibbonView";
import { RibbonInfographic } from "./RibbonInfographic";
import { RibbonArrow } from "./RibbonArrow";
import { RibbonTable } from "./RibbonTable";

export interface RibbonProps {
  active: RibbonTab;
  onTabChange: (tab: RibbonTab) => void;
  fileProps: RibbonFileProps;
  insertProps: RibbonInsertProps;
  viewProps: RibbonViewProps;
  toolsProps: RibbonToolsProps;
}

export interface RibbonToolsProps {
  onFind: () => void;
  onHistory: () => void;
  onSpecialChars: () => void;
  onToggleFocus: () => void;
}

const TABS: Array<{ id: RibbonTab; labelKey: string }> = [
  { id: "file", labelKey: "diagram.ribbon.tab.file" },
  { id: "edit", labelKey: "diagram.ribbon.tab.edit" },
  { id: "view", labelKey: "diagram.ribbon.tab.view" },
  { id: "insert", labelKey: "diagram.ribbon.tab.insert" },
  { id: "format", labelKey: "diagram.ribbon.tab.format" },
  { id: "tools", labelKey: "diagram.ribbon.tab.tools" },
  { id: "info", labelKey: "diagram.ribbon.tab.info" },
  { id: "arrow", labelKey: "diagram.ribbon.tab.arrow" },
  { id: "table", labelKey: "diagram.ribbon.tab.table" },
];

function panelFor(
  active: RibbonTab,
  fileProps: RibbonFileProps,
  insertProps: RibbonInsertProps,
  viewProps: RibbonViewProps,
  toolsProps: RibbonToolsProps,
): ReactNode {
  switch (active) {
    case "file":
      return <RibbonFile {...fileProps} />;
    case "edit":
      return <RibbonEdit />;
    case "view":
      return <RibbonView {...viewProps} />;
    case "insert":
      return <RibbonInsert {...insertProps} />;
    case "format":
      return <RibbonFormat />;
    case "tools":
      return <RibbonTools {...toolsProps} />;
    case "info":
      return <RibbonInfographic />;
    case "arrow":
      return <RibbonArrow />;
    case "table":
      return <RibbonTable />;
  }
}

export function Ribbon({
  active,
  onTabChange,
  fileProps,
  insertProps,
  viewProps,
  toolsProps,
}: RibbonProps) {
  const { t } = useTranslation();
  return (
    <div className="anchor-diagram-ribbon">
      <nav className="anchor-diagram-ribbon-tabs" aria-label={t("mode.diagram")}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={`anchor-diagram-ribbon-tab${active === tab.id ? " is-active" : ""}`}
            onClick={() => onTabChange(tab.id)}
            role="tab"
            aria-selected={active === tab.id}
          >
            {t(tab.labelKey)}
          </button>
        ))}
      </nav>
      <div className="anchor-diagram-ribbon-panel" role="tabpanel">
        {panelFor(active, fileProps, insertProps, viewProps, toolsProps)}
      </div>
    </div>
  );
}

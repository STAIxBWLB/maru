import type { CommsProvider } from "../../lib/comms";
import { useTranslation } from "../../lib/i18n";

export type CommsTab = "all" | CommsProvider | "settings";

interface CommsTabsProps {
  activeTab: CommsTab;
  onTabChange: (tab: CommsTab) => void;
  counts: Record<CommsProvider, number>;
}

const TABS: CommsTab[] = ["all", "gmail", "outlook", "telegram", "settings"];

export function CommsTabs({ activeTab, onTabChange, counts }: CommsTabsProps) {
  const { t } = useTranslation();
  return (
    <div className="comms-tabs" role="tablist" aria-label={t("comms.tabs.label")}>
      {TABS.map((tab) => {
        const count = tab === "all"
          ? counts.gmail + counts.outlook + counts.telegram
          : tab === "settings"
            ? null
            : counts[tab];
        return (
          <button
            key={tab}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            className={activeTab === tab ? "comms-tab active" : "comms-tab"}
            onClick={() => onTabChange(tab)}
          >
            <span>{t(`comms.tab.${tab}`)}</span>
            {count !== null ? <span className="count">{count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

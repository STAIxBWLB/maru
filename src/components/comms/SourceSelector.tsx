import { useTranslation } from "../../lib/i18n";
import { SOURCE_LABEL_KEY, type InboxSourceChannel } from "../../lib/inboxSources";

interface SourceSelectorProps {
  channels: InboxSourceChannel[];
  active: string | null;
  counts: Map<string, number>;
  total: number;
  onChange: (channel: string | null) => void;
}

export function SourceSelector({ channels, active, counts, total, onChange }: SourceSelectorProps) {
  const { t } = useTranslation();
  return (
    <div className="comms-source-selector inbox-filter-row" role="toolbar" aria-label={t("comms.tabs.label")}>
      <button
        type="button"
        className={active === null ? "inbox-filter-chip active" : "inbox-filter-chip"}
        onClick={() => onChange(null)}
      >
        {t("comms.source.all")} <span className="count">{total}</span>
      </button>
      {channels.map((channel) => (
        <button
          type="button"
          key={channel}
          className={active === channel ? "inbox-filter-chip active" : "inbox-filter-chip"}
          onClick={() => onChange(channel)}
        >
          {t(SOURCE_LABEL_KEY[channel])} <span className="count">{counts.get(channel) ?? 0}</span>
        </button>
      ))}
    </div>
  );
}

import { ArrowDownAZ, ClockArrowDown, ClockArrowUp } from "lucide-react";
import type { SortKey } from "../../lib/settings";

// `t` is a prop rather than useTranslation() because ScratchpadPane is rendered
// outside the locale provider in its tests and already threads `t` down.
type Translate = (key: string, vars?: Record<string, string | number>) => string;

interface SortModeToggleProps {
  value: SortKey;
  onChange: (key: SortKey) => void;
  t: Translate;
}

const OPTIONS: Array<{ key: SortKey; icon: typeof ArrowDownAZ; short: string; full: string }> = [
  { key: "name", icon: ArrowDownAZ, short: "files.sort.nameShort", full: "files.sort.name" },
  {
    key: "modifiedDesc",
    icon: ClockArrowDown,
    short: "files.sort.modifiedDescShort",
    full: "files.sort.modifiedDesc",
  },
  {
    key: "modifiedAsc",
    icon: ClockArrowUp,
    short: "files.sort.modifiedAscShort",
    full: "files.sort.modifiedAsc",
  },
];

/** Sort picker shared by the Documents and Scratchpad panes. A segmented
 *  toggle rather than a `<select>` so it never opens an OS popup menu that
 *  overflows a narrow pane. */
export function SortModeToggle({ value, onChange, t }: SortModeToggleProps) {
  return (
    <div className="sort-mode-toggle" role="group" aria-label={t("files.sort.label")}>
      {OPTIONS.map(({ key, icon: Icon, short, full }) => (
        <button
          key={key}
          type="button"
          className={value === key ? "active" : ""}
          onClick={() => onChange(key)}
          title={t(full)}
          aria-label={t(full)}
          aria-pressed={value === key}
        >
          <Icon size={13} />
          <span>{t(short)}</span>
        </button>
      ))}
    </div>
  );
}

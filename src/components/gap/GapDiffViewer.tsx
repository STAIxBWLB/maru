import { ChevronDown, ChevronRight } from "lucide-react";
import { useTranslation } from "../../lib/i18n";
import { buildGapDiffRows, gapHunkRangeLabel } from "../../lib/gapAnalysis";
import type { GapHunk, GapHunkType } from "../../lib/types";

interface GapDiffViewerProps {
  hunks: GapHunk[];
  /** Indexes (into `hunks`) of equal hunks currently expanded. */
  expandedEqual: ReadonlySet<number>;
  onToggleEqual: (index: number) => void;
}

function hunkTypeClass(hunkType: GapHunkType): string {
  return `gap-type-badge gap-type-${hunkType}`;
}

const ROW_KIND_CLASS = { " ": "ctx", "-": "del", "+": "add" } as const;

/** Two-column aligned diff: baseline (AI draft) on the left, promoted
 *  document on the right. Equal hunks render collapsed by default. */
export function GapDiffViewer({ hunks, expandedEqual, onToggleEqual }: GapDiffViewerProps) {
  const { t } = useTranslation();
  return (
    <div className="gap-diff-table" role="table" aria-label={t("gap.diff.label")}>
      <div className="gap-diff-row gap-diff-head" role="row">
        <span className="gap-diff-no" aria-hidden="true" />
        <span className="gap-diff-cell" role="columnheader">
          {t("gap.diff.baselineCol")}
        </span>
        <span className="gap-diff-no" aria-hidden="true" />
        <span className="gap-diff-cell" role="columnheader">
          {t("gap.diff.finalCol")}
        </span>
      </div>
      {hunks.map((hunk, index) => {
        if (hunk.op === "equal" && !expandedEqual.has(index)) {
          return (
            <button
              key={index}
              type="button"
              className="gap-diff-collapsed"
              onClick={() => onToggleEqual(index)}
              aria-expanded={false}
            >
              <ChevronRight size={13} />
              <span>{t("gap.diff.equalCollapsed", { count: hunk.lines.length })}</span>
            </button>
          );
        }
        const rows = buildGapDiffRows(hunk);
        return (
          <div key={index} className="gap-diff-hunk" data-hunk-op={hunk.op}>
            {hunk.op === "equal" ? (
              <button
                type="button"
                className="gap-diff-collapsed"
                onClick={() => onToggleEqual(index)}
                aria-expanded={true}
              >
                <ChevronDown size={13} />
                <span>{t("gap.diff.equalExpanded", { count: hunk.lines.length })}</span>
              </button>
            ) : (
              <div className="gap-diff-hunk-header">
                <code className="gap-diff-range">{gapHunkRangeLabel(hunk)}</code>
                <span className={hunkTypeClass(hunk.hunkType)}>
                  {t(`gap.type.${hunk.hunkType}`)}
                </span>
                {hunk.evidence.map((token) => (
                  <span key={token} className="gap-evidence-chip">
                    {token}
                  </span>
                ))}
              </div>
            )}
            {rows.map((row, rowIndex) => (
              <div
                key={rowIndex}
                className={`gap-diff-row kind-${ROW_KIND_CLASS[row.kind]}`}
                role="row"
              >                <span className="gap-diff-no">{row.oldLineNo ?? ""}</span>
                <span className="gap-diff-cell">{row.kind === "+" ? "" : row.text}</span>
                <span className="gap-diff-no">{row.newLineNo ?? ""}</span>
                <span className="gap-diff-cell">{row.kind === "-" ? "" : row.text}</span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

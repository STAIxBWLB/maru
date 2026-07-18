import { useTranslation } from "../../lib/i18n";
import type { InboxProcessedItemDetail } from "../../lib/types";
import { formatBytes } from "./processedFormat";

export type ProcessedDetailTab = "summary" | "route" | "manifest" | "extracted";

export function ProcessedDetailPanel({
  detail,
  tab,
  onTab,
  onRevealPath,
}: {
  detail: InboxProcessedItemDetail;
  tab: ProcessedDetailTab;
  onTab: (tab: ProcessedDetailTab) => void;
  onRevealPath: (path: string) => void;
}) {
  const { t } = useTranslation();
  const tabs = [
    { key: "summary" as const, label: t("inbox.processed.tab.summary"), value: detail.summaryText },
    { key: "route" as const, label: t("inbox.processed.tab.route"), value: detail.routeText },
    { key: "manifest" as const, label: t("inbox.processed.tab.manifest"), value: detail.manifestText },
    { key: "extracted" as const, label: t("inbox.processed.tab.extracted"), value: detail.extractedText },
  ];
  const active = tabs.find((item) => item.key === tab) ?? tabs[0];
  const artifactPath =
    tab === "summary"
      ? detail.item.summaryPath
      : tab === "route"
        ? detail.item.routePath
        : tab === "manifest"
          ? detail.item.manifestPath
          : detail.item.extractedPath;

  return (
    <aside className="processed-detail">
      <div className="processed-detail-header">
        <div>
          <strong>{detail.item.title || detail.item.id}</strong>
          <span>{detail.item.channel} · {detail.item.status}</span>
        </div>
        <button
          type="button"
          className="button button-ghost button-sm"
          onClick={() => onRevealPath(detail.item.itemDir)}
        >
          {t("inbox.menu.revealFinder")}
        </button>
      </div>
      <div className="processed-tabs" role="tablist">
        {tabs.map((item) => (
          <button
            type="button"
            key={item.key}
            className={tab === item.key ? "active" : ""}
            onClick={() => onTab(item.key)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="processed-artifact-path">
        <span>{artifactPath ?? t("inbox.processed.artifactMissing")}</span>
        {artifactPath ? (
          <button type="button" className="link-button" onClick={() => onRevealPath(artifactPath)}>
            {t("inbox.menu.revealFinder")}
          </button>
        ) : null}
      </div>
      <pre className="processed-artifact">
        {active.value ?? t("inbox.processed.artifactEmpty")}
        {tab === "extracted" && detail.extractedTruncated ? `\n\n${t("inbox.processed.truncated")}` : ""}
      </pre>
      {detail.rawFiles.length > 0 ? (
        <div className="processed-raw-files">
          <strong>{t("inbox.processed.rawFiles")}</strong>
          {detail.rawFiles.map((file) => (
            <button
              type="button"
              key={file.path}
              className="link-button"
              onClick={() => onRevealPath(file.path)}
            >
              {file.relPath} · {formatBytes(file.sizeBytes)}
            </button>
          ))}
        </div>
      ) : null}
    </aside>
  );
}

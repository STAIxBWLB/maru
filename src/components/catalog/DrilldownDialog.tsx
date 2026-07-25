// Catalog drilldown dialog (Phase 3 W4).
//
// Opens when a Catalog row is clicked. Shows frontmatter + manifest +
// README excerpt + related sibling paths, plus Reveal-in-Finder action.

import { useEffect, useState } from "react";
import type { CatalogDrilldownResponse, CatalogEntry } from "../../lib/catalog";
import { catalogDrilldown } from "../../lib/catalog";
import { useTranslation } from "../../lib/i18n";
import {
  DialogSurface,
  DialogSurfaceClose,
  DialogSurfaceTitle,
} from "../ui/DialogSurface";

interface DrilldownDialogProps {
  workspaceRoot: string;
  entry: CatalogEntry | null;
  onClose: () => void;
  onReveal?: (path: string) => void;
}

export function DrilldownDialog({
  workspaceRoot,
  entry,
  onClose,
  onReveal,
}: DrilldownDialogProps) {
  const { t } = useTranslation();
  const [data, setData] = useState<CatalogDrilldownResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastEntry, setLastEntry] = useState<CatalogEntry | null>(entry);

  useEffect(() => {
    if (!entry) return;
    let cancelled = false;
    setLastEntry(entry);
    setData(null);
    setLoading(true);
    setError(null);
    catalogDrilldown(workspaceRoot, entry.path)
      .then((resp) => {
        if (!cancelled) setData(resp);
      })
      .catch((e) => {
        if (!cancelled) setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceRoot, entry]);

  const activeEntry = entry ?? lastEntry;
  if (!activeEntry) return null;

  return (
    <DialogSurface
      open={entry !== null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
      className="catalog-drilldown"
      overlayClassName="catalog-drilldown-overlay"
    >
        <header className="catalog-drilldown__header">
          <div>
            <DialogSurfaceTitle as="h3">
              {activeEntry.title || activeEntry.path}
            </DialogSurfaceTitle>
            <div className="catalog-drilldown__path">{activeEntry.path}</div>
          </div>
          <div className="catalog-drilldown__actions">
            {onReveal ? (
              <button
                type="button"
                className="catalog-drilldown__action"
                onClick={() => onReveal(activeEntry.path)}
              >
                {t("catalog.drilldown.reveal")}
              </button>
            ) : null}
            <DialogSurfaceClose>
              <button
                type="button"
                className="catalog-drilldown__action"
                aria-label={t("catalog.drilldown.close")}
              >
                {t("catalog.drilldown.close")}
              </button>
            </DialogSurfaceClose>
          </div>
        </header>

        <div className="catalog-drilldown__body">
          {loading && <p className="catalog-drilldown__status">{t("catalog.drilldown.loading")}</p>}
          {error && (
            <p className="catalog-drilldown__error">
              {t("catalog.drilldown.error", { message: error })}
            </p>
          )}

          {data?.frontmatter_yaml ? (
            <section>
              <h4>{t("catalog.drilldown.frontmatter")}</h4>
              <pre className="catalog-drilldown__code">{data.frontmatter_yaml}</pre>
            </section>
          ) : null}

          {data?.manifest_yaml ? (
            <section>
              <h4>manifest.yaml</h4>
              <pre className="catalog-drilldown__code">{data.manifest_yaml}</pre>
            </section>
          ) : null}

          {data?.readme_excerpt ? (
            <section>
              <h4>{t("catalog.drilldown.readmeExcerpt")}</h4>
              <pre className="catalog-drilldown__code">{data.readme_excerpt}</pre>
            </section>
          ) : null}

          {data?.related_paths.length ? (
            <section>
              <h4>{t("catalog.drilldown.related", { count: data.related_paths.length })}</h4>
              <ul className="catalog-drilldown__related">
                {data.related_paths.slice(0, 50).map((p) => (
                  <li key={p}>{p}</li>
                ))}
                {data.related_paths.length > 50 ? (
                  <li className="catalog-drilldown__more">
                    {t("catalog.drilldown.relatedMore", {
                      count: data.related_paths.length - 50,
                    })}
                  </li>
                ) : null}
              </ul>
            </section>
          ) : null}

          {data &&
          !data.frontmatter_yaml &&
          !data.manifest_yaml &&
          !data.readme_excerpt &&
          !data.related_paths.length ? (
            <p className="catalog-drilldown__empty">{t("catalog.drilldown.empty")}</p>
          ) : null}
        </div>
    </DialogSurface>
  );
}

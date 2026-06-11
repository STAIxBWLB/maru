import { Loader2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { scanWorkSites } from "../../lib/anchorDir";
import { useTranslation } from "../../lib/i18n";
import {
  candidateToSite,
  normalizeSiteUrl,
  parseSiteCandidates,
  type SiteCandidate,
  type SiteEntry,
} from "../../lib/sites";
import { Button } from "../ui/Button";

const DEFAULT_SCAN_DIR = "~/workspace/work/sites";

interface CandidateRow {
  candidate: SiteCandidate;
  selected: boolean;
  label: string;
  url: string;
  alreadyAdded: boolean;
}

interface ImportSitesDialogProps {
  open: boolean;
  existingSites: SiteEntry[];
  nextOrder: number;
  onClose: () => void;
  onImport: (entries: SiteEntry[]) => void;
}

export function ImportSitesDialog({
  open,
  existingSites,
  nextOrder,
  onClose,
  onImport,
}: ImportSitesDialogProps) {
  const { t } = useTranslation();
  const [dir, setDir] = useState(DEFAULT_SCAN_DIR);
  const [scanning, setScanning] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [rows, setRows] = useState<CandidateRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const existingUrls = useMemo(() => {
    const urls = new Set<string>();
    for (const site of existingSites) {
      const normalized = normalizeSiteUrl(site.url);
      if (normalized) urls.add(normalized);
    }
    return urls;
  }, [existingSites]);

  useEffect(() => {
    if (!open) return;
    setRows([]);
    setScanned(false);
    setError(null);
  }, [open]);

  if (!open) return null;

  const scan = async () => {
    setScanning(true);
    setError(null);
    try {
      const candidates = parseSiteCandidates(await scanWorkSites(dir.trim()));
      setRows(
        candidates.map((candidate) => {
          const url = candidate.url ?? candidate.devUrl ?? "";
          const normalized = normalizeSiteUrl(url);
          const alreadyAdded = normalized !== null && existingUrls.has(normalized);
          return {
            candidate,
            selected: !alreadyAdded && normalized !== null,
            label: candidate.label,
            url,
            alreadyAdded,
          };
        }),
      );
      setScanned(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setScanning(false);
    }
  };

  const updateRow = (index: number, patch: Partial<CandidateRow>) => {
    setRows((current) =>
      current.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  };

  const selectedRows = rows.filter(
    (row) => row.selected && !row.alreadyAdded && normalizeSiteUrl(row.url) !== null,
  );

  const submit = () => {
    let order = nextOrder;
    const entries: SiteEntry[] = [];
    for (const row of selectedRows) {
      const entry = candidateToSite(row.candidate, { label: row.label, url: row.url }, order);
      if (entry) {
        entries.push(entry);
        order += 1;
      }
    }
    if (entries.length > 0) onImport(entries);
    onClose();
  };

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section className="sites-import-dialog task-new-dialog" role="dialog" aria-modal="true">
        <header>
          <div>
            <h2>{t("sites.import.title")}</h2>
            <p>{t("sites.import.description")}</p>
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            title={t("app.close")}
            aria-label={t("app.close")}
          >
            <X size={16} />
          </button>
        </header>
        {error ? <div className="inbox-error">{error}</div> : null}
        <div className="settings-form">
          <label className="field">
            <span>{t("sites.import.dir")}</span>
            <input value={dir} onChange={(event) => setDir(event.target.value)} />
          </label>
          <Button size="sm" disabled={scanning || !dir.trim()} onClick={() => void scan()}>
            {scanning ? (
              <>
                <Loader2 size={13} className="spin" /> {t("sites.import.scanning")}
              </>
            ) : (
              t("sites.import.scan")
            )}
          </Button>

          {scanned && rows.length === 0 ? (
            <div className="sites-empty-hint">{t("sites.import.noCandidates")}</div>
          ) : null}

          {rows.length > 0 ? (
            <div className="sites-import-candidates">
              {rows.map((row, index) => (
                <div
                  key={row.candidate.localPath}
                  className={
                    row.alreadyAdded
                      ? "sites-import-candidate already-added"
                      : "sites-import-candidate"
                  }
                >
                  <input
                    type="checkbox"
                    checked={row.selected && !row.alreadyAdded}
                    disabled={row.alreadyAdded}
                    onChange={(event) => updateRow(index, { selected: event.target.checked })}
                  />
                  <input
                    type="text"
                    value={row.label}
                    aria-label={t("sites.import.field.label")}
                    disabled={row.alreadyAdded}
                    onChange={(event) => updateRow(index, { label: event.target.value })}
                  />
                  <input
                    type="text"
                    value={row.url}
                    aria-label={t("sites.import.field.url")}
                    disabled={row.alreadyAdded}
                    placeholder="https://"
                    onChange={(event) => updateRow(index, { url: event.target.value })}
                  />
                  <span className="sites-import-candidate-meta">
                    {row.candidate.localPath}
                    {row.candidate.devUrl ? ` · dev: ${row.candidate.devUrl}` : ""}
                    {row.alreadyAdded ? ` · ${t("sites.import.alreadyAdded")}` : ""}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <footer>
          <Button size="sm" variant="ghost" onClick={onClose}>
            {t("dialog.cancel")}
          </Button>
          <Button
            size="sm"
            variant="primary"
            disabled={selectedRows.length === 0}
            onClick={submit}
          >
            {t("sites.import.addSelected", { count: String(selectedRows.length) })}
          </Button>
        </footer>
      </section>
    </div>
  );
}

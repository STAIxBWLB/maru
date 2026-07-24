import { AlertTriangle } from "lucide-react";
import { useState } from "react";
import type { LegacyLaunchdService } from "../../lib/api";
import { useTranslation } from "../../lib/i18n";

interface MigrationBannerProps {
  services: LegacyLaunchdService[];
  busy: boolean;
  onRefresh: () => void;
  onUnload: (plistPaths: string[]) => void;
}

export function MigrationBanner({ services, busy, onRefresh, onUnload }: MigrationBannerProps) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  if (services.length === 0) return null;
  return (
    <>
      <div className="migration-banner">
        <AlertTriangle size={16} />
        <div>
          <strong>{t("comms.migration.title")}</strong>
          <p>{t("comms.migration.description")}</p>
          <div className="migration-list">
            {services.map((service) => (
              <span key={service.plistPath}>
                {service.label}
                {service.loaded ? ` · ${t("comms.migration.loaded")}` : ""}
              </span>
            ))}
          </div>
        </div>
        <div className="migration-actions">
          <button type="button" className="secondary-button" disabled={busy} onClick={onRefresh}>
            {t("comms.migration.refresh")}
          </button>
          <button
            type="button"
            className="danger-button"
            disabled={busy}
            onClick={() => setConfirming(true)}
          >
            {t("comms.migration.unload")}
          </button>
        </div>
      </div>
      {confirming ? (
        <div
          className="comms-confirm-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) setConfirming(false);
          }}
        >
          <section
            className="comms-confirm-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="comms-migration-confirm-title"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !busy) setConfirming(false);
            }}
          >
            <AlertTriangle size={20} aria-hidden="true" />
            <div>
              <h2 id="comms-migration-confirm-title">
                {t("comms.migration.confirmTitle")}
              </h2>
              <p>{t("comms.migration.confirm")}</p>
            </div>
            <div className="comms-confirm-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                autoFocus
                onClick={() => setConfirming(false)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="danger-button"
                disabled={busy}
                onClick={() => {
                  onUnload(services.map((service) => service.plistPath));
                  setConfirming(false);
                }}
              >
                {t("comms.migration.unload")}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}

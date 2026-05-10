import { AlertTriangle } from "lucide-react";
import type { LegacyLaunchdService } from "../../lib/api";
import { useTranslation } from "../../lib/i18n";

interface MigrationBannerProps {
  services: LegacyLaunchdService[];
  busy: boolean;
  onRefresh: () => void;
  onUnload: (plistPath: string) => void;
}

export function MigrationBanner({ services, busy, onRefresh, onUnload }: MigrationBannerProps) {
  const { t } = useTranslation();
  if (services.length === 0) return null;
  return (
    <div className="migration-banner">
      <AlertTriangle size={16} />
      <div>
        <strong>{t("comms.migration.title")}</strong>
        <p>{t("comms.migration.description")}</p>
        <div className="migration-list">
          {services.map((service) => (
            <span key={service.plistPath}>
              {service.label}
              {service.loaded ? " · loaded" : ""}
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
          onClick={() => {
            for (const service of services) onUnload(service.plistPath);
          }}
        >
          {t("comms.migration.unload")}
        </button>
      </div>
    </div>
  );
}

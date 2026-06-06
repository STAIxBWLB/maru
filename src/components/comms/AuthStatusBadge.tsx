import { AlertCircle, CheckCircle2, HelpCircle } from "lucide-react";
import type { ProviderAuthStatus } from "../../lib/types";
import { useTranslation } from "../../lib/i18n";

interface AuthStatusBadgeProps {
  status: ProviderAuthStatus | null | undefined;
}

export function AuthStatusBadge({ status }: AuthStatusBadgeProps) {
  const { t } = useTranslation();
  const state = status?.state ?? "unknown";
  const label =
    state === "ok"
      ? t("comms.auth.status.authenticated")
      : state === "auth_required"
        ? t("comms.auth.status.expired")
        : state === "cli_missing" || state === "env_missing"
          ? t("comms.auth.status.unauthenticated")
          : t("comms.auth.status.unknown");
  const Icon = state === "ok" ? CheckCircle2 : state === "unknown" ? HelpCircle : AlertCircle;
  return (
    <span className={`auth-status-badge ${state}`}>
      <Icon size={13} />
      <span>{label}</span>
      {status?.account ? <span className="auth-status-account">{status.account}</span> : null}
    </span>
  );
}

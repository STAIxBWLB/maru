import { Eye, EyeOff, LogIn } from "lucide-react";
import { useState } from "react";
import type { ProviderAuthStatus, TelegramMonitorConfigView } from "../../lib/types";
import { useTranslation } from "../../lib/i18n";
import { AuthStatusBadge } from "./AuthStatusBadge";

interface TelegramAuthFieldsProps {
  config: TelegramMonitorConfigView;
  status?: ProviderAuthStatus | null;
  onChange: (config: TelegramMonitorConfigView) => void;
  onLogin?: () => void;
}

export function TelegramAuthFields({
  config,
  status,
  onChange,
  onLogin,
}: TelegramAuthFieldsProps) {
  const { t } = useTranslation();
  const [showApiHash, setShowApiHash] = useState(false);
  const [showBotToken, setShowBotToken] = useState(false);

  const updateTelegram = (patch: Partial<TelegramMonitorConfigView["telegram"]>) =>
    onChange({ ...config, telegram: { ...config.telegram, ...patch } });
  const updateNotification = (
    patch: Partial<TelegramMonitorConfigView["notification"]["telegram"]>,
  ) =>
    onChange({
      ...config,
      notification: {
        telegram: { ...config.notification.telegram, ...patch },
      },
    });

  return (
    <div className="telegram-auth-fields">
      <div className="settings-section-heading inline">
        <div>
          <strong>{t("comms.telegram.auth.title")}</strong>
        </div>
        <AuthStatusBadge status={status} />
        {onLogin ? (
          <button type="button" className="secondary-button" onClick={onLogin}>
            <LogIn size={14} />
            <span>{t("comms.telegram.login")}</span>
          </button>
        ) : null}
      </div>
      <div className="settings-grid two">
        <label className="field">
          <span>{t("comms.telegram.auth.apiId")}</span>
          <input
            value={config.telegram.apiId ?? ""}
            onChange={(event) => updateTelegram({ apiId: event.target.value || null })}
            spellCheck={false}
          />
        </label>
        <label className="field">
          <span>{t("comms.telegram.auth.phone")}</span>
          <input
            value={config.telegram.phone ?? ""}
            onChange={(event) => updateTelegram({ phone: event.target.value || null })}
            spellCheck={false}
          />
        </label>
        <label className="field secret-field">
          <span>{t("comms.telegram.auth.apiHash")}</span>
          <div className="secret-input-row">
            <input
              type={showApiHash ? "text" : "password"}
              value={config.telegram.apiHash ?? ""}
              onChange={(event) =>
                updateTelegram({
                  apiHash: event.target.value || null,
                  hasApiHash: Boolean(event.target.value),
                })
              }
              spellCheck={false}
            />
            <button
              type="button"
              className="icon-button"
              onClick={() => setShowApiHash((value) => !value)}
              aria-label={showApiHash ? t("comms.telegram.secret.hide") : t("comms.telegram.secret.show")}
              title={showApiHash ? t("comms.telegram.secret.hide") : t("comms.telegram.secret.show")}
            >
              {showApiHash ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </label>
        <label className="field secret-field">
          <span>{t("comms.telegram.auth.botToken")}</span>
          <div className="secret-input-row">
            <input
              type={showBotToken ? "text" : "password"}
              value={config.notification.telegram.botToken ?? ""}
              onChange={(event) =>
                updateNotification({
                  botToken: event.target.value || null,
                  hasBotToken: Boolean(event.target.value),
                })
              }
              spellCheck={false}
            />
            <button
              type="button"
              className="icon-button"
              onClick={() => setShowBotToken((value) => !value)}
              aria-label={showBotToken ? t("comms.telegram.secret.hide") : t("comms.telegram.secret.show")}
              title={showBotToken ? t("comms.telegram.secret.hide") : t("comms.telegram.secret.show")}
            >
              {showBotToken ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </label>
        <label className="field">
          <span>{t("comms.telegram.auth.notificationChatId")}</span>
          <input
            value={config.notification.telegram.chatId ?? ""}
            onChange={(event) => updateNotification({ chatId: event.target.value || null })}
            spellCheck={false}
          />
        </label>
      </div>
    </div>
  );
}

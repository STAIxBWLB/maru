// Maru Today — Prepare panel: auto-captured items. Filter chips are computed
// from the candidates actually present; high-confidence items render as rows
// with decision actions, medium/low behind a collapsed "제안" toggle.

import { format } from "date-fns";
import { Check, ChevronDown, ChevronUp, Clock, Info, Mail, Pencil, Settings, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { IconType } from "react-icons";
import { BsMicrosoft } from "react-icons/bs";
import { SiGmail, SiKakaotalk, SiTelegram } from "react-icons/si";
import { useTranslation } from "../../lib/i18n";
import { isInboxSourceChannel, SOURCE_LABEL_KEY } from "../../lib/inboxSources";
import type { CaptureCandidate, CaptureConfidence, TodayRoute } from "../../lib/today";
import { captureChannel } from "./todayPrepareUtils";
import type { TodayCaptures } from "./useTodayCaptures";

const PROVIDER_ICONS: Record<string, IconType> = {
  gws: SiGmail,
  gmail: SiGmail,
  // Simple Icons dropped Microsoft brands; Bootstrap's glyph stands in.
  mso: BsMicrosoft,
  outlook: BsMicrosoft,
  telegram: SiTelegram,
  kakao: SiKakaotalk,
};

const PRIORITY_DOT_COUNT: Record<CaptureConfidence, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const PRIORITY_LABEL_KEY: Record<CaptureConfidence, string> = {
  high: "today.capture.priority.high",
  medium: "today.capture.priority.medium",
  low: "today.capture.priority.low",
};

function CaptureBrandIcon({ channel }: { channel: string }) {
  const Brand = PROVIDER_ICONS[channel];
  if (Brand) return <Brand size={18} aria-hidden="true" />;
  return <Mail size={18} strokeWidth={1.9} aria-hidden="true" />;
}

function formatReceivedAt(receivedAt: string): string {
  const time = Date.parse(receivedAt);
  if (!Number.isFinite(time)) return "";
  return format(time, "M/d HH:mm");
}

interface TodayCaptureProps {
  captures: TodayCaptures;
  onNavigate: (route: TodayRoute) => void;
}

export function TodayCapture({ captures, onNavigate }: TodayCaptureProps) {
  const { t } = useTranslation();
  const { capture, suggestions, loading, session, decide } = captures;
  const [filter, setFilter] = useState<string | null>(null); // null = all
  const [showSuggestions, setShowSuggestions] = useState(false);

  const channels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const candidate of [...capture, ...suggestions]) {
      const channel = captureChannel(candidate);
      counts.set(channel, (counts.get(channel) ?? 0) + 1);
    }
    return [...counts.entries()];
  }, [capture, suggestions]);

  const matchesFilter = (candidate: CaptureCandidate) =>
    filter === null || captureChannel(candidate) === filter;
  const visibleCapture = capture.filter(matchesFilter);
  const visibleSuggestions = suggestions.filter(matchesFilter);
  const total = capture.length + suggestions.length;

  const channelLabel = (channel: string) =>
    isInboxSourceChannel(channel) ? t(SOURCE_LABEL_KEY[channel]) : channel;

  const renderRow = (candidate: CaptureCandidate) => {
    const entry = session.get(candidate.captureId);
    const added = entry?.decision === "addToToday";
    const deferred = entry?.decision === "defer";
    const decided = added || deferred;
    const meta = [candidate.summary, formatReceivedAt(candidate.receivedAt)]
      .filter(Boolean)
      .join(" · ");
    return (
      <li
        key={candidate.captureId}
        className={decided ? "today-capture-row today-capture-row-decided" : "today-capture-row"}
      >
        <span className="today-capture-icon">
          <CaptureBrandIcon channel={captureChannel(candidate)} />
        </span>
        <div className="today-capture-main">
          <p className="today-capture-title">{candidate.title}</p>
          {meta ? <p className="today-capture-meta">{meta}</p> : null}
          {added ? (
            <span className="today-capture-state">{t("today.capture.state.added")}</span>
          ) : null}
          {deferred ? (
            <span className="today-capture-state">{t("today.capture.state.deferred")}</span>
          ) : null}
        </div>
        <span
          className="today-priority"
          role="img"
          aria-label={t(PRIORITY_LABEL_KEY[candidate.confidence])}
        >
          <span className="today-priority-label">{t(PRIORITY_LABEL_KEY[candidate.confidence])}</span>
          {[0, 1, 2].map((dot) => (
            <span
              key={dot}
              className={
                dot < PRIORITY_DOT_COUNT[candidate.confidence]
                  ? "today-priority-dot today-priority-dot-on"
                  : "today-priority-dot"
              }
            />
          ))}
        </span>
        <div className="today-capture-actions">
          <button
            type="button"
            className="today-icon-button"
            aria-label={t("today.capture.action.add")}
            title={t("today.capture.action.add")}
            onClick={() => void decide(candidate, "addToToday")}
            disabled={decided}
          >
            <Check size={16} strokeWidth={1.9} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="today-icon-button"
            aria-label={t("today.capture.action.edit")}
            title={t("today.capture.editUnavailable")}
            disabled
          >
            <Pencil size={16} strokeWidth={1.9} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="today-icon-button"
            aria-label={t("today.capture.action.defer")}
            title={t("today.capture.action.defer")}
            onClick={() => void decide(candidate, "defer")}
            disabled={decided}
          >
            <Clock size={16} strokeWidth={1.9} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="today-icon-button"
            aria-label={t("today.capture.action.dismiss")}
            title={t("today.capture.action.dismiss")}
            onClick={() => void decide(candidate, "dismiss")}
          >
            <X size={16} strokeWidth={1.9} aria-hidden="true" />
          </button>
        </div>
      </li>
    );
  };

  return (
    <section className="today-panel today-panel-capture" data-today-section="braindump">
      <header className="today-panel-header">
        <h3 className="today-panel-title">{t("today.panel.capture.title")}</h3>
        <button
          type="button"
          className="today-panel-link today-panel-header-link"
          onClick={() => onNavigate("capture")}
        >
          {t("today.capture.viewAll", { count: total })}
        </button>
      </header>
      <p className="today-panel-hint">
        {t("today.capture.subtitle")}
        <Info size={12} strokeWidth={1.9} className="today-panel-info" aria-hidden="true" />
      </p>
      <div className="today-panel-body">
        {channels.length > 0 ? (
          <div className="today-capture-chips" role="group" aria-label={t("today.panel.capture.title")}>
            <button
              type="button"
              className={
                filter === null ? "today-chip today-chip-active" : "today-chip"
              }
              onClick={() => setFilter(null)}
            >
              {t("today.capture.filter.all")} {total}
            </button>
            {channels.map(([channel, count]) => (
              <button
                key={channel}
                type="button"
                className={
                  filter === channel ? "today-chip today-chip-active" : "today-chip"
                }
                onClick={() => setFilter(filter === channel ? null : channel)}
              >
                <CaptureBrandIcon channel={channel} />
                {channelLabel(channel)} {count}
              </button>
            ))}
          </div>
        ) : null}
        {loading ? <p className="today-panel-empty">{t("today.capture.loading")}</p> : null}
        {!loading && total === 0 ? (
          <p className="today-panel-empty">{t("today.capture.empty")}</p>
        ) : null}
        {visibleCapture.length > 0 ? (
          <ul className="today-capture-list">{visibleCapture.map(renderRow)}</ul>
        ) : null}
        {visibleSuggestions.length > 0 ? (
          <div className="today-capture-suggestions">
            <button
              type="button"
              className="today-panel-link"
              onClick={() => setShowSuggestions((prev) => !prev)}
              aria-expanded={showSuggestions}
            >
              {showSuggestions ? (
                <ChevronUp size={13} strokeWidth={1.9} aria-hidden="true" />
              ) : (
                <ChevronDown size={13} strokeWidth={1.9} aria-hidden="true" />
              )}
              {t("today.capture.suggestions", { count: visibleSuggestions.length })}
            </button>
            {showSuggestions ? (
              <ul className="today-capture-list">{visibleSuggestions.map(renderRow)}</ul>
            ) : null}
          </div>
        ) : null}
        <footer className="today-capture-footer">
          <span className="today-braindump-hint">{t("today.capture.footer")}</span>
          <button
            type="button"
            className="today-panel-link"
            disabled
            title={t("today.capture.settingsUnavailable")}
          >
            <Settings size={12} strokeWidth={1.9} aria-hidden="true" />
            {t("today.capture.settings")}
          </button>
        </footer>
      </div>
    </section>
  );
}

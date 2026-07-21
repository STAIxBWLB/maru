// Maru Today — shared stage scaffold: greeting header row + workflow
// stepper + scrollable content. Prepare/Execute/Review compose this so the
// header zone stays consistent across stages.

import { format } from "date-fns";
import { enUS } from "date-fns/locale/en-US";
import { ko } from "date-fns/locale/ko";
import { MoonStar, SkipForward, Sun, Sunrise } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "../../lib/i18n";
import { useToday } from "./todayContext";
import { TodayStepper, type TodayStep } from "./TodayStepper";

interface TodayStageScaffoldProps {
  steps: TodayStep[];
  activeStepId: string;
  onSelectStep: (id: string) => void;
  /** Render the quick-skip affordance (Prepare stage only). */
  onQuickSkip?: () => void;
  children: ReactNode;
}

export function TodayStageScaffold({
  steps,
  activeStepId,
  onSelectStep,
  onQuickSkip,
  children,
}: TodayStageScaffoldProps) {
  const { t, locale } = useTranslation();
  const { snapshot, settings } = useToday();

  const now = new Date();
  const hour = now.getHours();
  const greetingKey =
    hour < 12
      ? "today.header.greeting.morning"
      : hour < 18
        ? "today.header.greeting.afternoon"
        : "today.header.greeting.evening";
  const GreetingIcon = hour < 12 ? Sunrise : hour < 18 ? Sun : MoonStar;
  const dateLocale = locale === "ko" ? ko : enUS;
  const dateLabel =
    locale === "ko"
      ? format(now, "yyyy년 M월 d일 EEEE", { locale: dateLocale })
      : format(now, "EEEE, MMMM d, yyyy", { locale: dateLocale });
  const dayStart = snapshot?.dayStart ?? settings.dayStart;

  return (
    <div className="today-stage">
      <header className="today-stage-header">
        <div className="today-greeting-row">
          <p className="today-greeting">
            <GreetingIcon size={18} strokeWidth={1.9} aria-hidden="true" />
            <span>
              {t(greetingKey)} · {dateLabel} · {dayStart}
            </span>
          </p>
          {onQuickSkip ? (
            <button type="button" className="today-quick-skip" onClick={onQuickSkip}>
              {t("today.header.quickSkip")}
              <SkipForward size={14} strokeWidth={1.9} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <TodayStepper steps={steps} activeId={activeStepId} onSelect={onSelectStep} />
      </header>
      <div className="today-stage-content">{children}</div>
    </div>
  );
}

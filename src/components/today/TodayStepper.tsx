// Maru Today — accessible workflow stepper. Renders a clickable <ol> of
// numbered steps with connecting lines; the active step carries
// aria-current="step". Generic: stage screens pass their own steps.

import { useTranslation } from "../../lib/i18n";

export interface TodayStep {
  id: string;
  label: string;
}

interface TodayStepperProps {
  steps: TodayStep[];
  activeId: string;
  onSelect: (id: string) => void;
}

export function TodayStepper({ steps, activeId, onSelect }: TodayStepperProps) {
  const { t } = useTranslation();
  return (
    <ol className="today-stepper" aria-label={t("today.steps.label")}>
      {steps.map((step, index) => {
        const active = step.id === activeId;
        return (
          <li
            key={step.id}
            className={active ? "today-step active" : "today-step"}
            data-step-id={step.id}
          >
            <button
              type="button"
              className="today-step-button"
              aria-current={active ? "step" : undefined}
              onClick={() => onSelect(step.id)}
            >
              <span className="today-step-number" aria-hidden="true">
                {index + 1}
              </span>
              <span className="today-step-label">{step.label}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

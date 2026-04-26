import { useTranslation, type Locale } from "../lib/i18n";

const ORDER: Locale[] = ["ko", "en"];

export function LocaleToggle() {
  const { locale, setLocale, t } = useTranslation();
  return (
    <div className="locale-toggle" role="group" aria-label={t("app.locale.label")}>
      {ORDER.map((loc) => (
        <button
          key={loc}
          type="button"
          className={loc === locale ? "chip active" : "chip"}
          onClick={() => setLocale(loc)}
          aria-pressed={loc === locale}
        >
          {t(`app.locale.${loc}`)}
        </button>
      ))}
    </div>
  );
}

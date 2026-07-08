import { File, FileText, Folder, Star, X } from "lucide-react";
import type { FavoriteItem } from "../lib/settings";
import { useTranslation } from "../lib/i18n";

export interface FavoriteTarget {
  kind: FavoriteItem["kind"];
  relPath: string;
  label: string;
}

interface FavoritesSectionProps {
  favorites: FavoriteItem[];
  onOpen: (favorite: FavoriteItem) => void;
  onRemove: (favorite: FavoriteItem) => void;
  isMissing?: (favorite: FavoriteItem) => boolean;
}

export function FavoritesSection({
  favorites,
  onOpen,
  onRemove,
  isMissing,
}: FavoritesSectionProps) {
  const { t } = useTranslation();
  return (
    <section className="favorites-section" aria-label={t("favorites.title")}>
      <header className="favorites-section__header">
        <span>
          <Star size={13} />
          {t("favorites.title")}
        </span>
        <span>{favorites.length}</span>
      </header>
      {favorites.length === 0 ? (
        <div className="favorites-section__empty">{t("favorites.empty")}</div>
      ) : (
        <div className="favorites-section__list">
          {favorites.map((favorite) => {
            const missing = isMissing?.(favorite) ?? false;
            return (
              <div
                key={`${favorite.kind}:${favorite.relPath}`}
                className={missing ? "favorite-row missing" : "favorite-row"}
              >
                <button
                  type="button"
                  className="favorite-row__main"
                  onClick={() => onOpen(favorite)}
                  title={favorite.relPath}
                >
                  <FavoriteIcon favorite={favorite} />
                  <span>
                    <strong>{favorite.label}</strong>
                    <small>{missing ? t("favorites.missing") : favorite.relPath}</small>
                  </span>
                </button>
                <button
                  type="button"
                  className="favorite-row__remove"
                  onClick={() => onRemove(favorite)}
                  title={t("favorites.remove")}
                  aria-label={t("favorites.remove")}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function FavoriteIcon({ favorite }: { favorite: FavoriteItem }) {
  if (favorite.kind === "directory") return <Folder size={13} />;
  return /\.(md|mdx|markdown|html?)$/i.test(favorite.relPath)
    ? <FileText size={13} />
    : <File size={13} />;
}

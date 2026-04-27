import { ArrowUpRight, FileText, Link2, Users } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "../lib/i18n";
import {
  buildNeighborhood,
  type NeighborhoodTarget,
} from "../lib/neighborhood";
import type { DocumentPayload, VaultEntry } from "../lib/types";

interface NeighborhoodPaneProps {
  document: DocumentPayload;
  draftContent: string;
  entries: VaultEntry[];
  onSelectEntry: (entry: VaultEntry) => void;
  onMissingTarget?: (target: string) => void;
}

export function NeighborhoodPane({
  document,
  draftContent,
  entries,
  onSelectEntry,
  onMissingTarget,
}: NeighborhoodPaneProps) {
  const { t } = useTranslation();
  const data = useMemo(
    () => buildNeighborhood(document, draftContent, entries),
    [document, draftContent, entries],
  );

  const isEmpty =
    data.upward.length === 0 &&
    data.mentions.length === 0 &&
    data.peers.length === 0;

  if (isEmpty) return null;

  return (
    <section className="neighborhood">
      <header className="neighborhood-header">
        <h3>{t("neighborhood.title")}</h3>
      </header>

      {data.upward.length > 0 ? (
        <div className="neighborhood-section">
          <div className="neighborhood-label">
            <ArrowUpRight size={11} />
            <span>{t("neighborhood.upward")}</span>
          </div>
          {data.upward.map(({ field, targets }) => (
            <div key={field} className="neighborhood-field">
              <div className="neighborhood-field-name">{field}</div>
              <div className="neighborhood-field-targets">
                {targets.map((target) => (
                  <NeighborhoodLink
                    key={`${field}:${target.target}`}
                    item={target}
                    onSelectEntry={onSelectEntry}
                    onMissingTarget={onMissingTarget}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {data.mentions.length > 0 ? (
        <div className="neighborhood-section">
          <div className="neighborhood-label">
            <Link2 size={11} />
            <span>{t("neighborhood.mentions")}</span>
            <span className="neighborhood-count">{data.mentions.length}</span>
          </div>
          <div className="neighborhood-list">
            {data.mentions.map((item) => (
              <NeighborhoodLink
                key={`mention:${item.target}`}
                item={item}
                onSelectEntry={onSelectEntry}
                onMissingTarget={onMissingTarget}
              />
            ))}
          </div>
        </div>
      ) : null}

      {data.peers.length > 0 ? (
        <div className="neighborhood-section">
          <div className="neighborhood-label">
            <Users size={11} />
            <span>{t("neighborhood.peers")}</span>
            <span className="neighborhood-count">{data.peers.length}</span>
          </div>
          <div className="neighborhood-list">
            {data.peers.map((entry) => (
              <button
                key={entry.path}
                type="button"
                className="neighborhood-item"
                onClick={() => onSelectEntry(entry)}
                title={entry.relPath}
              >
                <FileText size={11} className="neighborhood-icon" />
                <span className="neighborhood-item-title">{entry.title}</span>
                <span className="neighborhood-item-path">{entry.relPath}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

interface LinkProps {
  item: NeighborhoodTarget;
  onSelectEntry: (entry: VaultEntry) => void;
  onMissingTarget?: (target: string) => void;
}

function NeighborhoodLink({ item, onSelectEntry, onMissingTarget }: LinkProps) {
  const resolved = item.entry !== null;
  return (
    <button
      type="button"
      className={resolved ? "neighborhood-item" : "neighborhood-item missing"}
      onClick={() => {
        if (item.entry) onSelectEntry(item.entry);
        else onMissingTarget?.(item.target);
      }}
      title={resolved ? item.relPath : item.target}
    >
      <FileText size={11} className="neighborhood-icon" />
      <span className="neighborhood-item-title">{item.title}</span>
      {resolved ? (
        <span className="neighborhood-item-path">{item.relPath}</span>
      ) : null}
    </button>
  );
}

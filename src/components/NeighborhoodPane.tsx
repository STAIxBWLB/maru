import { ArrowDownLeft, ArrowUpRight, Link2, Users, Waypoints } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "../lib/i18n";
import {
  buildBacklinks,
  buildNeighborhood,
  type NeighborhoodTarget,
} from "../lib/neighborhood";
import { buildEntryIndex } from "../lib/wikilinkSuggestions";
import type { DocumentPayload, VaultEntry } from "../lib/types";

interface NeighborhoodPaneProps {
  document: DocumentPayload;
  draftContent: string;
  entries: VaultEntry[];
  onSelectEntry: (entry: VaultEntry) => void;
  onMissingTarget?: (target: string) => void;
  /** Opens graph mode focused on this note (maru-vault-graph-spec §2.3). */
  onOpenGraph?: (focusNodeId?: string) => void;
}

export function NeighborhoodPane({
  document,
  draftContent,
  entries,
  onSelectEntry,
  onMissingTarget,
  onOpenGraph,
}: NeighborhoodPaneProps) {
  const { t } = useTranslation();
  // Index is stable across draftContent typing — only rebuilds when the
  // workspace scan changes. Avoids the per-keystroke O(n) walk over entries.
  const entryIndex = useMemo(() => buildEntryIndex(entries), [entries]);
  const data = useMemo(
    () => buildNeighborhood(document, draftContent, entries, entryIndex),
    [document, draftContent, entries, entryIndex],
  );
  // Backlinks depend only on other notes' links + this doc's path (not on
  // draftContent), so they recompute on document switch, not per keystroke.
  const backlinks = useMemo(
    () => buildBacklinks(document, entries, entryIndex),
    [document, entries, entryIndex],
  );

  const isEmpty =
    data.upward.length === 0 &&
    data.mentions.length === 0 &&
    backlinks.length === 0 &&
    data.peers.length === 0;

  if (isEmpty) return null;

  return (
    <section className="neighborhood">
      <header className="neighborhood-header">
        <h3>{t("neighborhood.title")}</h3>
        {onOpenGraph ? (
          <button
            type="button"
            className="neighborhood-graph-button"
            onClick={() => {
              const filename = document.relPath.split("/").pop() ?? document.relPath;
              const stem = filename.replace(/\.(md|mdx|markdown)$/i, "").toLowerCase();
              onOpenGraph(stem);
            }}
            title={t("neighborhood.openGraph")}
          >
            <Waypoints size={12} />
            <span>{t("neighborhood.openGraph")}</span>
          </button>
        ) : null}
      </header>

      {data.upward.length > 0 ? (
        <div className="neighborhood-section">
          <div className="neighborhood-label" title={t("neighborhood.upward")}>
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
          <div className="neighborhood-label" title={t("neighborhood.mentions")}>
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

      {backlinks.length > 0 ? (
        <div className="neighborhood-section">
          <div className="neighborhood-label" title={t("neighborhood.backlinks")}>
            <ArrowDownLeft size={11} />
            <span>{t("neighborhood.backlinks")}</span>
            <span className="neighborhood-count">{backlinks.length}</span>
          </div>
          <div className="neighborhood-list">
            {backlinks.map((entry) => (
              <EntryLink
                key={`backlink:${entry.path}`}
                entry={entry}
                onSelectEntry={onSelectEntry}
              />
            ))}
          </div>
        </div>
      ) : null}

      {data.peers.length > 0 ? (
        <div className="neighborhood-section">
          <div className="neighborhood-label" title={t("neighborhood.peers")}>
            <Users size={11} />
            <span>{t("neighborhood.peers")}</span>
            <span className="neighborhood-count">{data.peers.length}</span>
          </div>
          <div className="neighborhood-list">
            {data.peers.map((entry) => (
              <EntryLink
                key={entry.path}
                entry={entry}
                onSelectEntry={onSelectEntry}
              />
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

interface EntryLinkProps {
  entry: VaultEntry;
  onSelectEntry: (entry: VaultEntry) => void;
}

/** A resolved vault note rendered as a single-line wiki link. */
function EntryLink({ entry, onSelectEntry }: EntryLinkProps) {
  return (
    <button
      type="button"
      className="neighborhood-item"
      onClick={() => onSelectEntry(entry)}
      title={entry.relPath}
    >
      <span className="neighborhood-item-title">{entry.title}</span>
    </button>
  );
}

interface LinkProps {
  item: NeighborhoodTarget;
  onSelectEntry: (entry: VaultEntry) => void;
  onMissingTarget?: (target: string) => void;
}

/** A wikilink target — navigates when resolved, else offers to create it. */
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
      <span className="neighborhood-item-title">{item.title}</span>
    </button>
  );
}

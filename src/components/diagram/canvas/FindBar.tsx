import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import {
  defaultCoalescer,
  setSelection,
  setViewport,
  withSnapshot,
} from "../../../lib/diagram/actions";
import {
  findInDoc,
  replaceAllInDoc,
  type FindMatch,
} from "../../../lib/diagram/findReplace";
import { useDiagram, useDiagramStore } from "../DiagramStoreContext";
import { useTranslation } from "../../../lib/i18n";

export interface FindBarProps {
  open: boolean;
  onClose: () => void;
}

export function FindBar({ open, onClose }: FindBarProps) {
  const { t } = useTranslation();
  const store = useDiagramStore();
  const doc = useDiagram((s) => s.doc);
  const viewport = useDiagram((s) => s.ephemeral.viewport);
  const [query, setQuery] = useState("");
  const [replace, setReplace] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const queryRef = useRef<HTMLInputElement | null>(null);

  const matches = useMemo<FindMatch[]>(() => findInDoc(doc, query, { includeMemo: true }), [doc, query]);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => queryRef.current?.focus());
      setActiveIdx(0);
    }
  }, [open]);

  useEffect(() => {
    setActiveIdx((idx) => (matches.length === 0 ? 0 : Math.min(idx, matches.length - 1)));
  }, [matches.length]);

  function jumpTo(match: FindMatch | undefined) {
    if (!match) return;
    if (match.kind === "node") {
      const node = store.getState().doc.nodes.find((n) => n.id === match.id);
      if (!node) return;
      store.setState(setSelection([node.id]));
      // Center viewport on the node.
      const svg = document.querySelector<SVGSVGElement>(".anchor-diagram-canvas");
      const rect = svg?.getBoundingClientRect();
      const w = rect?.width ?? 800;
      const h = rect?.height ?? 600;
      const px = w / 2 - (node.x + node.w / 2) * viewport.zoom;
      const py = h / 2 - (node.y + node.h / 2) * viewport.zoom;
      store.setState(setViewport({ zoom: viewport.zoom, px, py }));
    } else {
      store.setState(setSelection([], [match.id]));
    }
  }

  function step(delta: number) {
    if (matches.length === 0) return;
    const next = (activeIdx + delta + matches.length) % matches.length;
    setActiveIdx(next);
    jumpTo(matches[next]);
  }

  function onQueryKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      step(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  }

  function handleReplaceAll() {
    if (!query) return;
    store.setState(
      withSnapshot(replaceAllInDoc(query, replace, { caseSensitive: false }), defaultCoalescer()),
    );
  }

  if (!open) return null;

  const total = matches.length;
  const current = total === 0 ? 0 : activeIdx + 1;

  return (
    <div
      className="anchor-diagram-find-bar"
      role="search"
      aria-label={t("diagram.findBar.placeholder")}
      data-export-ignore
    >
      <input
        ref={queryRef}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onQueryKey}
        placeholder={t("diagram.findBar.placeholder")}
        aria-label={t("diagram.findBar.placeholder")}
      />
      <span className="anchor-diagram-find-count">
        {total === 0 ? t("diagram.findBar.none") : t("diagram.findBar.count", { current: String(current), total: String(total) })}
      </span>
      <button
        type="button"
        onClick={() => step(-1)}
        disabled={total === 0}
        title={t("diagram.findBar.prev")}
        aria-label={t("diagram.findBar.prev")}
      >
        <ChevronUp size={14} />
      </button>
      <button
        type="button"
        onClick={() => step(1)}
        disabled={total === 0}
        title={t("diagram.findBar.next")}
        aria-label={t("diagram.findBar.next")}
      >
        <ChevronDown size={14} />
      </button>
      <input
        type="text"
        value={replace}
        onChange={(e) => setReplace(e.target.value)}
        placeholder={t("diagram.findBar.replacePlaceholder")}
        aria-label={t("diagram.findBar.replacePlaceholder")}
      />
      <button type="button" onClick={handleReplaceAll} disabled={!query}>
        {t("diagram.findBar.replaceAll")}
      </button>
      <button
        type="button"
        className="anchor-diagram-find-close"
        onClick={onClose}
        title={t("diagram.findBar.close")}
        aria-label={t("diagram.findBar.close")}
      >
        <X size={14} />
      </button>
    </div>
  );
}

// Maru Today — tracks which workflow section is active so the stepper can
// follow the visible/focused panel. Sections are DOM elements carrying
// `data-today-section="<stepId>"` anywhere under `rootRef` (document when
// omitted). IntersectionObserver drives scroll-based activation; `focusin`
// keeps keyboard users in sync. `select()` activates a step and scrolls its
// first section into view.

import { useCallback, useEffect, useRef, useState } from "react";

const SECTION_ATTR = "data-today-section";

export interface UseActiveSectionResult {
  activeId: string;
  /** Activate a step and scroll its section into view. */
  select: (id: string) => void;
}

export function useActiveSection(
  stepIds: string[],
  rootRef?: React.RefObject<HTMLElement | null>,
): UseActiveSectionResult {
  const [activeId, setActiveId] = useState<string>(stepIds[0] ?? "");
  // Guard against feedback loops: while a programmatic scroll settles, the
  // observer must not override the step the user just picked.
  const pinnedRef = useRef<{ id: string; until: number } | null>(null);
  const stepKey = stepIds.join("\n");

  const findSections = useCallback((): HTMLElement[] => {
    const root = rootRef?.current ?? document;
    return Array.from(root.querySelectorAll<HTMLElement>(`[${SECTION_ATTR}]`));
  }, [rootRef]);

  const select = useCallback(
    (id: string) => {
      pinnedRef.current = { id, until: Date.now() + 600 };
      setActiveId(id);
      const target = findSections().find((el) => el.dataset.todaySection === id);
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    [findSections],
  );

  useEffect(() => {
    setActiveId((current) => (stepIds.includes(current) ? current : (stepIds[0] ?? "")));

    const activate = (id: string | undefined) => {
      if (!id) return;
      const pinned = pinnedRef.current;
      if (pinned && Date.now() < pinned.until && pinned.id !== id) return;
      pinnedRef.current = null;
      setActiveId((current) => (current === id ? current : id));
    };

    const sections = findSections();

    let observer: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== "undefined") {
      observer = new IntersectionObserver(
        (entries) => {
          // Pick the most-visible intersecting section.
          let best: IntersectionObserverEntry | null = null;
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            if (!best || entry.intersectionRatio > best.intersectionRatio) best = entry;
          }
          if (best) {
            activate((best.target as HTMLElement).dataset.todaySection);
          }
        },
        { threshold: [0.25, 0.5, 0.75] },
      );
      for (const el of sections) observer.observe(el);
    }

    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const section = target.closest<HTMLElement>(`[${SECTION_ATTR}]`);
      if (section) activate(section.dataset.todaySection);
    };
    document.addEventListener("focusin", onFocusIn);

    return () => {
      observer?.disconnect();
      document.removeEventListener("focusin", onFocusIn);
    };
    // stepKey re-runs the effect when the step id set changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepKey, findSections]);

  return { activeId, select };
}

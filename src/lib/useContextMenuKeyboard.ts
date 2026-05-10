import { useCallback, useEffect, type KeyboardEvent, type RefObject } from "react";

const ITEM_SELECTOR = '[role="menuitem"]:not([disabled])';

export function useContextMenuKeyboard(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  onClose: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const root = ref.current;
    if (!root) return;
    const first = root.querySelector<HTMLElement>(ITEM_SELECTOR);
    first?.focus();
  }, [open, ref]);

  return useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const root = event.currentTarget;
      const items = Array.from(
        root.querySelectorAll<HTMLElement>(ITEM_SELECTOR),
      );
      if (items.length === 0) {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
        return;
      }
      const idx = items.indexOf(document.activeElement as HTMLElement);
      switch (event.key) {
        case "ArrowDown": {
          event.preventDefault();
          const next = idx < 0 ? 0 : (idx + 1) % items.length;
          items[next]?.focus();
          break;
        }
        case "ArrowUp": {
          event.preventDefault();
          const next = idx <= 0 ? items.length - 1 : idx - 1;
          items[next]?.focus();
          break;
        }
        case "Home":
          event.preventDefault();
          items[0]?.focus();
          break;
        case "End":
          event.preventDefault();
          items[items.length - 1]?.focus();
          break;
        case "Escape":
          event.preventDefault();
          onClose();
          break;
      }
    },
    [onClose],
  );
}

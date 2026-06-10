export type TerminalShortcutAction =
  | "paste"
  | "copy"
  | "selectAll"
  | "find"
  | "clear"
  | "closeTab"
  | "newTab"
  | "split"
  | "tab1"
  | "tab2"
  | "tab3"
  | "tab4"
  | "tab5"
  | "tab6"
  | "tab7"
  | "tab8"
  | "tab9";

export type TerminalShortcutMap = Record<TerminalShortcutAction, string | null>;

export const TERMINAL_SHORTCUT_ACTIONS: TerminalShortcutAction[] = [
  "paste",
  "copy",
  "selectAll",
  "find",
  "clear",
  "closeTab",
  "newTab",
  "split",
  "tab1",
  "tab2",
  "tab3",
  "tab4",
  "tab5",
  "tab6",
  "tab7",
  "tab8",
  "tab9",
];

export const DEFAULT_TERMINAL_SHORTCUTS: TerminalShortcutMap = {
  paste: "mod+v",
  copy: "mod+c",
  selectAll: "mod+a",
  find: "mod+f",
  clear: "mod+k",
  closeTab: "mod+w",
  newTab: "mod+t",
  split: "mod+d",
  tab1: "mod+1",
  tab2: "mod+2",
  tab3: "mod+3",
  tab4: "mod+4",
  tab5: "mod+5",
  tab6: "mod+6",
  tab7: "mod+7",
  tab8: "mod+8",
  tab9: "mod+9",
};

export type TerminalShortcutEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"
>;

const VALID_MODIFIERS = new Set(["mod", "shift", "alt"]);
const VALID_NAMED_KEYS = new Set([
  "space",
  "enter",
  "escape",
  "tab",
  "backspace",
  "delete",
  "arrowup",
  "arrowdown",
  "arrowleft",
  "arrowright",
  ",",
  ".",
  "/",
  ";",
  "'",
  "[",
  "]",
  "\\",
  "`",
  "-",
  "=",
]);

function normalizeKeyToken(token: string): string | null {
  const key = token.trim().toLowerCase();
  if (!key || /\s/u.test(key)) return null;
  if (/^[a-z0-9]$/u.test(key)) return key;
  if (/^f(?:[1-9]|1[0-2])$/u.test(key)) return key;
  return VALID_NAMED_KEYS.has(key) ? key : null;
}

export function normalizeTerminalShortcut(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const raw = value.trim().toLowerCase();
  if (!raw || /\s/u.test(raw)) return undefined;
  const parts = raw.split("+").filter(Boolean);
  const keyPart = parts.at(-1);
  if (!keyPart) return undefined;
  const key = normalizeKeyToken(keyPart);
  if (!key) return undefined;
  const modifiers = parts.slice(0, -1);
  if (!modifiers.includes("mod")) return undefined;
  if (new Set(modifiers).size !== modifiers.length) return undefined;
  if (modifiers.some((part) => !VALID_MODIFIERS.has(part))) return undefined;
  return [...modifiers.sort(shortcutModifierSort), key].join("+");
}

export function normalizeTerminalShortcuts(value: unknown): TerminalShortcutMap {
  const source = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const normalized = {} as TerminalShortcutMap;
  for (const action of TERMINAL_SHORTCUT_ACTIONS) {
    const shortcut = normalizeTerminalShortcut(source[action]);
    normalized[action] = shortcut === undefined ? DEFAULT_TERMINAL_SHORTCUTS[action] : shortcut;
  }
  return normalized;
}

export function terminalShortcutActionForEvent(
  event: TerminalShortcutEvent,
  shortcuts: TerminalShortcutMap,
  isMac: boolean,
): TerminalShortcutAction | null {
  const chord = terminalShortcutFromEvent(event, isMac);
  if (!chord) return null;
  for (const action of TERMINAL_SHORTCUT_ACTIONS) {
    if (shortcuts[action] === chord) return action;
  }
  return null;
}

function terminalShortcutFromEvent(
  event: TerminalShortcutEvent,
  isMac: boolean,
): string | null {
  const usesMod = isMac ? event.metaKey : event.ctrlKey;
  if (!usesMod) return null;
  const key = normalizeEventKey(event);
  if (!key) return null;
  const modifiers = ["mod"];
  if (event.shiftKey) modifiers.push("shift");
  if (event.altKey) modifiers.push("alt");
  return [...modifiers.sort(shortcutModifierSort), key].join("+");
}

function normalizeEventKey(event: TerminalShortcutEvent): string | null {
  const key = event.key === " " ? "space" : event.key.toLowerCase();
  if (/^[a-z0-9]$/u.test(key)) return key;
  if (key.startsWith("arrow")) return key;
  if (key === "esc") return "escape";
  return normalizeKeyToken(key);
}

function shortcutModifierSort(a: string, b: string): number {
  const order = { mod: 0, shift: 1, alt: 2 } as Record<string, number>;
  return (order[a] ?? 99) - (order[b] ?? 99);
}

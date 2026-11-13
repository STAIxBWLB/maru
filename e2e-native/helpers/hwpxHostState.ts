/** Return application failures as data, not WebDriver's reserved value.error.
 * Self-contained because WebdriverIO serializes this function into the webview. */
export function readHwpxHostState(): string {
  const root = document;
  return JSON.stringify({
    saveEnabled: root.querySelector<HTMLButtonElement>('[data-testid="hwpx-save"]')?.disabled === false,
    status: root.querySelector('[data-testid="hwpx-status"]')?.textContent ?? "",
    error: root.querySelector('[data-testid="hwpx-error"]')?.textContent ?? "",
    conflict: Boolean(root.querySelector('[data-testid="hwpx-conflict"]')),
    discard: Boolean(root.querySelector('[data-testid="hwpx-discard-dialog"]')),
    paragraphs: Array.from(root.querySelectorAll('.hwped-side [role="listbox"] [role="option"]'))
      .map((node) => node.textContent ?? ""),
  });
}

export interface HwpxHostState {
  saveEnabled: boolean;
  status: string;
  error: string;
  conflict: boolean;
  discard: boolean;
  paragraphs: string[];
}

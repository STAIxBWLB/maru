import { siteViewOpenExternal } from "./siteView";

/** Click delegation for sanitized preview surfaces (HWPX, Markdown). An anchor
 *  inside a preview must never navigate the app webview: http(s) links go to
 *  the system browser through the validated external-open path, and every
 *  other scheme is swallowed. */
export function interceptPreviewLinkClick(event: {
  target: EventTarget | null;
  preventDefault(): void;
}): void {
  if (!(event.target instanceof Element)) return;
  const anchor = event.target.closest("a[href]");
  if (!anchor) return;
  event.preventDefault();
  const href = anchor.getAttribute("href") ?? "";
  if (/^https?:\/\//i.test(href)) {
    void siteViewOpenExternal(href).catch((err: unknown) => {
      console.info("[maru] preview link open failed:", err);
    });
  }
}

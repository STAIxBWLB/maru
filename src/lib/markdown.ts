import DOMPurify from "dompurify";
import { Marked } from "marked";

const marked = new Marked({
  gfm: true,
  breaks: false,
  // Render Obsidian-style [[wikilinks]] inline before marked sees them.
});

const renderer = {
  // Link rendering: open external links in new tab; mark wikilink-rewritten
  // anchors with class "wikilink" (we transform [[…]] before marked runs).
  link({
    href,
    title,
    text,
  }: {
    href: string;
    title?: string | null;
    text: string;
  }): string {
    const isWiki = href?.startsWith("anchor:wikilink:");
    if (isWiki) {
      const target = decodeURIComponent(href.slice("anchor:wikilink:".length));
      return `<a class="wikilink" href="#" data-wikilink="${escapeAttr(target)}">${text}</a>`;
    }
    const titleAttr = title ? ` title="${escapeAttr(title)}"` : "";
    const isExternal = /^(https?:|mailto:)/i.test(href || "");
    const targetAttr = isExternal ? ` target="_blank" rel="noreferrer noopener"` : "";
    return `<a href="${escapeAttr(href)}"${titleAttr}${targetAttr}>${text}</a>`;
  },
};

marked.use({ renderer });

function escapeAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

const FRONTMATTER_RE = /^---\n[\s\S]*?\n---\n?/;
const WIKILINK_RE = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;

/** Strip frontmatter, rewrite wikilinks to anchor links, render with marked,
 *  sanitize with DOMPurify. Failures fall back to escaped plain text so a
 *  parse panic in one document never freezes the whole editor pane. */
export function renderMarkdown(markdown: string): string {
  try {
    const body = markdown.replace(FRONTMATTER_RE, "");
    const wikiRewritten = body.replace(WIKILINK_RE, (_, target, label) => {
      const text = (label ?? target).trim();
      return `[${text}](anchor:wikilink:${encodeURIComponent(target.trim())})`;
    });
    const html = marked.parse(wikiRewritten, { async: false }) as string;
    return DOMPurify.sanitize(html, {
      ADD_ATTR: ["target", "data-wikilink"],
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("[markdown] render failed, falling back to plain text", err);
    const plain = markdown
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
    return `<pre style="white-space:pre-wrap;font-family:inherit">${plain}</pre>`;
  }
}

export interface OutlineHeading {
  level: number;
  text: string;
  line: number;
}

/** Extract h1/h2/h3 from raw markdown for outline panel navigation. */
export function extractOutline(markdown: string): OutlineHeading[] {
  const body = markdown.replace(FRONTMATTER_RE, "");
  const offset = markdown.length - body.length;
  const headings: OutlineHeading[] = [];
  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (match) {
      // Only include headings outside frontmatter
      const charIdx = lines.slice(0, i).join("\n").length + (i > 0 ? 1 : 0);
      if (charIdx >= offset) {
        headings.push({ level: match[1].length, text: match[2], line: i });
      }
    }
  }
  return headings;
}

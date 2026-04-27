/** Strip YAML frontmatter from markdown, returning [frontmatter, body]. */
export function splitFrontmatter(content: string): [string, string] {
  if (!content.startsWith("---")) return ["", content];
  const end = content.indexOf("\n---", 3);
  if (end === -1) return ["", content];
  let to = end + 4;
  if (content[to] === "\n") to++;
  return [content.slice(0, to), content.slice(to)];
}

/** Extract all outgoing wikilink targets from content. Finds [[target]] and
 *  [[target|display]] patterns, returning just the target part. Returns a
 *  sorted, deduplicated array. */
export function extractOutgoingLinks(content: string): string[] {
  const links: string[] = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    const inner = match[1];
    const pipeIdx = inner.indexOf("|");
    const target = pipeIdx !== -1 ? inner.slice(0, pipeIdx) : inner;
    const trimmed = target.trim();
    if (trimmed) links.push(trimmed);
  }
  return [...new Set(links)].sort();
}

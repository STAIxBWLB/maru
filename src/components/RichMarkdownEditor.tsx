import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { BlockNoteSchema, defaultStyleSpecs } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import { createReactStyleSpec, useCreateBlockNote } from "@blocknote/react";
import { useEffect, useRef } from "react";
import type { GaejosikLintIssue } from "../lib/studio";
import { splitFrontmatter } from "../lib/wikilinks";

interface RichMarkdownEditorProps {
  value: string;
  onChange: (content: string) => void;
  readOnly?: boolean;
  lintIssues?: GaejosikLintIssue[];
}

const gaejosikLintStyle = createReactStyleSpec(
  {
    type: "gaejosikLint",
    propSchema: "string",
  },
  {
    render: ({ value, contentRef }) => (
      <span ref={contentRef} className="rich-editor-lint-mark" data-rule={value} />
    ),
  },
);

const richEditorSchema = BlockNoteSchema.create({
  styleSpecs: {
    ...defaultStyleSpecs,
    gaejosikLint: gaejosikLintStyle,
  },
});

function mergeFrontmatter(frontmatter: string, body: string): string {
  return `${frontmatter}${body}`;
}

export function RichMarkdownEditor({
  value,
  onChange,
  readOnly = false,
  lintIssues = [],
}: RichMarkdownEditorProps) {
  const editor = useCreateBlockNote({ schema: richEditorSchema });
  const latestValueRef = useRef(value);
  const lastEmittedValueRef = useRef<string | null>(null);
  const suppressChangeRef = useRef(false);

  useEffect(() => {
    latestValueRef.current = value;
  }, [value]);

  useEffect(() => {
    if (value === lastEmittedValueRef.current) return;
    let cancelled = false;

    async function loadMarkdown() {
      const [, body] = splitFrontmatter(value);
      suppressChangeRef.current = true;
      try {
        const blocks = await editor.tryParseMarkdownToBlocks(body);
        if (cancelled) return;
        editor.replaceBlocks(editor.document, applyLintMarks(blocks, lintIssues));
      } catch (err) {
        // Keep the source tab authoritative if BlockNote cannot parse a body.
        // eslint-disable-next-line no-console
        console.error("[BlockNote] markdown import failed", err);
      } finally {
        if (!cancelled) suppressChangeRef.current = false;
      }
    }

    void loadMarkdown();

    return () => {
      cancelled = true;
    };
  }, [editor, lintIssues, value]);

  async function handleChange() {
    if (readOnly) return;
    if (suppressChangeRef.current) return;
    try {
      const [frontmatter] = splitFrontmatter(latestValueRef.current);
      const body = await editor.blocksToMarkdownLossy(editor.document);
      const next = mergeFrontmatter(frontmatter, body);
      lastEmittedValueRef.current = next;
      onChange(next);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[BlockNote] markdown export failed", err);
    }
  }

  return (
    <div className="rich-editor-surface">
      <BlockNoteView editor={editor} editable={!readOnly} onChange={() => void handleChange()} />
    </div>
  );
}

function applyLintMarks(blocks: any[], issues: GaejosikLintIssue[]): any[] {
  if (issues.length === 0) return blocks;
  const pending = issues.map((issue) => ({ ...issue, used: false }));
  return blocks.map((block) => markBlock(block, pending));
}

function markBlock(block: any, pending: Array<GaejosikLintIssue & { used: boolean }>): any {
  return {
    ...block,
    content: markContent(block.content, pending),
    children: Array.isArray(block.children)
      ? block.children.map((child: any) => markBlock(child, pending))
      : block.children,
  };
}

function markContent(content: any, pending: Array<GaejosikLintIssue & { used: boolean }>): any {
  if (!Array.isArray(content)) return content;
  return content.flatMap((item) => markInlineContent(item, pending));
}

function markInlineContent(
  item: any,
  pending: Array<GaejosikLintIssue & { used: boolean }>,
): any[] {
  if (typeof item === "string") {
    return markTextSegments(item, {}, pending);
  }
  if (!item || item.type !== "text") {
    if (item?.type === "link" && Array.isArray(item.content)) {
      return [{ ...item, content: markContent(item.content, pending) }];
    }
    return [item];
  }
  return markTextSegments(item.text ?? "", item.styles ?? {}, pending);
}

function markTextSegments(
  text: string,
  styles: Record<string, unknown>,
  pending: Array<GaejosikLintIssue & { used: boolean }>,
): any[] {
  let segments: any[] = [{ type: "text", text, styles }];
  for (const issue of pending) {
    if (issue.used || !issue.text) continue;
    let applied = false;
    segments = segments.flatMap((segment) => {
      if (applied || segment.type !== "text" || segment.styles?.gaejosikLint) return [segment];
      const index = segment.text.lastIndexOf(issue.text);
      if (index < 0) return [segment];
      applied = true;
      issue.used = true;
      const before = segment.text.slice(0, index);
      const marked = segment.text.slice(index, index + issue.text.length);
      const after = segment.text.slice(index + issue.text.length);
      return [
        before ? { ...segment, text: before } : null,
        {
          ...segment,
          text: marked,
          styles: { ...segment.styles, gaejosikLint: issue.rule },
        },
        after ? { ...segment, text: after } : null,
      ].filter(Boolean);
    });
  }
  return segments;
}

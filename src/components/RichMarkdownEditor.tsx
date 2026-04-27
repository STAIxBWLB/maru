import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote } from "@blocknote/react";
import { useEffect, useRef } from "react";
import { splitFrontmatter } from "../lib/wikilinks";

interface RichMarkdownEditorProps {
  value: string;
  onChange: (content: string) => void;
}

function mergeFrontmatter(frontmatter: string, body: string): string {
  return `${frontmatter}${body}`;
}

export function RichMarkdownEditor({ value, onChange }: RichMarkdownEditorProps) {
  const editor = useCreateBlockNote();
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
        editor.replaceBlocks(editor.document, blocks);
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
  }, [editor, value]);

  async function handleChange() {
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
      <BlockNoteView editor={editor} onChange={() => void handleChange()} />
    </div>
  );
}

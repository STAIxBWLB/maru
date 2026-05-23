import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { BlockNoteSchema, defaultStyleSpecs } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import { createReactStyleSpec, useCreateBlockNote } from "@blocknote/react";
import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
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
  const lastImportedValueRef = useRef<string | null>(null);
  const lastEmittedValueRef = useRef<string | null>(null);
  const suppressChangeRef = useRef(false);
  const lintIssuesRef = useRef(lintIssues);
  const lintSignature = useMemo(
    () => lintIssues.map((issue) => `${issue.id}:${issue.line}:${issue.column}`).join("|"),
    [lintIssues],
  );

  useEffect(() => {
    latestValueRef.current = value;
  }, [value]);

  useEffect(() => {
    lintIssuesRef.current = lintIssues;
  }, [lintIssues]);

  useEffect(() => {
    if (value === lastImportedValueRef.current) return;
    if (value === lastEmittedValueRef.current) {
      lastImportedValueRef.current = value;
      return;
    }
    let cancelled = false;

    async function loadMarkdown() {
      const [, body] = splitFrontmatter(value);
      suppressChangeRef.current = true;
      try {
        const blocks = await editor.tryParseMarkdownToBlocks(body);
        if (cancelled) return;
        editor.replaceBlocks(editor.document, blocks);
        lastImportedValueRef.current = value;
        applyRichLintMarks(editor, lintIssuesRef.current, suppressChangeRef);
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

  useEffect(() => {
    applyRichLintMarks(editor, lintIssuesRef.current, suppressChangeRef);
  }, [editor, lintSignature]);

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

function applyRichLintMarks(
  editor: any,
  issues: GaejosikLintIssue[],
  suppressChangeRef: MutableRefObject<boolean>,
) {
  const markType = editor.pmSchema?.marks?.gaejosikLint;
  const state = editor.prosemirrorState;
  const view = editor.prosemirrorView;
  if (!markType || !state || !view) return;

  const pending = issues.map((issue) => ({ ...issue, used: false }));
  let tr = state.tr.removeMark(0, state.doc.content.size, markType);

  state.doc.descendants((node: any, pos: number) => {
    if (!node.isText || !node.text) return true;
    for (const issue of pending) {
      if (issue.used || !issue.text) continue;
      const range = findIssueRangeInTextNode(node.text, issue);
      if (!range) continue;
      issue.used = true;
      tr = tr.addMark(
        pos + range.from,
        pos + range.to,
        markType.create({ stringValue: issue.rule }),
      );
      break;
    }
    return true;
  });

  if (!tr.docChanged) return;
  suppressChangeRef.current = true;
  try {
    view.dispatch(tr);
  } finally {
    suppressChangeRef.current = false;
  }
}

function findIssueRangeInTextNode(
  text: string,
  issue: GaejosikLintIssue,
): { from: number; to: number } | null {
  const columnStart = Math.max(0, issue.column - 1);
  const columnEnd = Math.max(columnStart, issue.endColumn - 1);
  if (columnEnd <= text.length && text.slice(columnStart, columnEnd) === issue.text) {
    return { from: columnStart, to: columnEnd };
  }

  const coreEnd = trimLintTrailingPunctuation(text);
  const core = text.slice(0, coreEnd);
  if (core.endsWith(issue.text)) {
    return { from: coreEnd - issue.text.length, to: coreEnd };
  }

  return null;
}

function trimLintTrailingPunctuation(text: string): number {
  let end = text.length;
  while (end > 0) {
    const ch = text[end - 1];
    if (!/[\s.!?。！？)"'\]\}]/.test(ch)) break;
    end -= 1;
  }
  return end;
}

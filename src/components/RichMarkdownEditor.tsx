import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import { BlockNoteSchema, defaultStyleSpecs } from "@blocknote/core";
import { BlockNoteView } from "@blocknote/mantine";
import { createReactStyleSpec, useCreateBlockNote } from "@blocknote/react";
import { useEffect, useMemo, useRef, type MutableRefObject } from "react";
import {
  mapSpansToPmTextNodes,
  type KgCharSpan,
  type KgPmTextNode,
} from "../lib/kgRefs";
import type { GaejosikLintIssue } from "../lib/studio";
import { splitFrontmatter } from "../lib/wikilinks";

interface RichMarkdownEditorProps {
  value: string;
  onChange: (content: string) => void;
  readOnly?: boolean;
  lintIssues?: GaejosikLintIssue[];
  /** KG reference spans (raw source char offsets) to highlight in the rich
   *  surface; mapped onto BlockNote text by search, like the preview. */
  kgSpans?: KgCharSpan[] | null;
  /** Click on a highlighted KG reference → focus the node in the graph. */
  onKgRefNodeClick?: (nodePath: string) => void;
}

const gaejosikLintStyle = createReactStyleSpec(
  {
    type: "gaejosikLint",
    propSchema: "string",
  },
  {
    render: ({
      value,
      contentRef,
    }: {
      value: string;
      contentRef: (el: HTMLElement | null) => void;
    }) => (
      <span ref={contentRef} className="rich-editor-lint-mark" data-rule={value} />
    ),
  },
);

const kgRefStyle = createReactStyleSpec(
  {
    type: "kgRef",
    propSchema: "string",
  },
  {
    render: ({
      value,
      contentRef,
    }: {
      value: string;
      contentRef: (el: HTMLElement | null) => void;
    }) => <span ref={contentRef} className="kg-ref-mark" data-kg-node={value} />,
  },
);

const richEditorSchema = BlockNoteSchema.create({
  styleSpecs: {
    ...defaultStyleSpecs,
    gaejosikLint: gaejosikLintStyle,
    kgRef: kgRefStyle,
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
  kgSpans = null,
  onKgRefNodeClick,
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
  const kgSpansRef = useRef(kgSpans);
  const kgSignature = useMemo(
    () => (kgSpans ?? []).map((span) => `${span.start}:${span.end}:${span.nodePath}`).join("|"),
    [kgSpans],
  );

  useEffect(() => {
    latestValueRef.current = value;
  }, [value]);

  useEffect(() => {
    lintIssuesRef.current = lintIssues;
  }, [lintIssues]);

  useEffect(() => {
    kgSpansRef.current = kgSpans;
  }, [kgSpans]);

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
        applyRichKgRefMarks(editor, kgSpansRef.current, latestValueRef.current, suppressChangeRef);
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

  useEffect(() => {
    applyRichKgRefMarks(editor, kgSpansRef.current, latestValueRef.current, suppressChangeRef);
  }, [editor, kgSignature]);

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

  function handleSurfaceClick(event: React.MouseEvent<HTMLDivElement>) {
    if (!onKgRefNodeClick) return;
    const mark = (event.target as HTMLElement).closest("[data-kg-node]");
    const nodePath = mark?.getAttribute("data-kg-node");
    if (!nodePath) return;
    event.preventDefault();
    onKgRefNodeClick(nodePath);
  }

  return (
    <div className="rich-editor-surface" onClick={handleSurfaceClick}>
      <BlockNoteView editor={editor} editable={!readOnly} onChange={() => void handleChange()} />
    </div>
  );
}

/**
 * Clear and re-apply KG reference marks. Source char offsets do not survive
 * the rich editor (frontmatter is stripped, wikilinks render differently),
 * so spans are re-located by searching the document text with a moving
 * cursor — the same approach the preview highlight uses.
 */
function applyRichKgRefMarks(
  editor: any,
  spans: KgCharSpan[] | null,
  sourceContent: string,
  suppressChangeRef: MutableRefObject<boolean>,
) {
  const markType = editor.pmSchema?.marks?.kgRef;
  const state = editor.prosemirrorState;
  const view = editor.prosemirrorView;
  if (!markType || !state || !view) return;

  const textBlocks: KgPmTextNode[][] = [];
  state.doc.descendants((node: any, pos: number) => {
    if (!node.isTextblock) return true;
    const inline: KgPmTextNode[] = [];
    node.forEach((child: any, offset: number) => {
      if (child.isText && child.text) {
        inline.push({ pos: pos + 1 + offset, text: child.text });
      }
    });
    textBlocks.push(inline);
    return false;
  });
  const ranges = mapSpansToPmTextNodes(textBlocks, spans ?? [], (span) =>
    sourceContent.slice(span.start, span.end),
  );

  let tr = state.tr.removeMark(0, state.doc.content.size, markType);
  for (const range of ranges) {
    tr = tr.addMark(range.from, range.to, markType.create({ stringValue: range.nodePath }));
  }

  if (!tr.docChanged) return;
  suppressChangeRef.current = true;
  try {
    view.dispatch(tr);
  } finally {
    suppressChangeRef.current = false;
  }
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

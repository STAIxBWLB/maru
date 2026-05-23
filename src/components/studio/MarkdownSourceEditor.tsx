import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  type DecorationSet,
} from "@codemirror/view";
import { useEffect, useMemo, useRef } from "react";
import type { GaejosikLintIssue } from "../../lib/studio";

interface MarkdownSourceEditorProps {
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  lintIssues?: GaejosikLintIssue[];
}

export function MarkdownSourceEditor({
  value,
  onChange,
  readOnly = false,
  lintIssues = [],
}: MarkdownSourceEditorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const latestValueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  const lintSignature = useMemo(
    () => lintIssues.map((issue) => `${issue.id}:${issue.line}:${issue.column}`).join("|"),
    [lintIssues],
  );

  useEffect(() => {
    latestValueRef.current = value;
  }, [value]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: latestValueRef.current,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          markdown(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorState.readOnly.of(readOnly),
          EditorView.editable.of(!readOnly),
          EditorView.lineWrapping,
          EditorView.decorations.compute([], (state) => buildLintDecorations(state, lintIssues)),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const next = update.state.doc.toString();
            latestValueRef.current = next;
            onChangeRef.current(next);
          }),
        ],
      }),
    });
    viewRef.current = view;

    return () => {
      view.destroy();
      if (viewRef.current === view) viewRef.current = null;
    };
  }, [lintIssues, lintSignature, readOnly]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (value === current) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  return <div ref={hostRef} className="studio-codemirror-editor" />;
}

function buildLintDecorations(state: EditorState, issues: GaejosikLintIssue[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  for (const issue of issues) {
    if (issue.line < 1 || issue.line > state.doc.lines) continue;
    const line = state.doc.line(issue.line);
    const from = Math.min(line.to, line.from + Math.max(0, issue.column - 1));
    const to = Math.min(line.to, line.from + Math.max(issue.column, issue.endColumn - 1));
    if (to <= from) continue;
    builder.add(
      from,
      to,
      Decoration.mark({
        class: "cm-gaejosik-violation",
        attributes: {
          title: `${issue.message} ${issue.suggestion}`,
          "data-rule": issue.rule,
        },
      }),
    );
  }
  return builder.finish();
}

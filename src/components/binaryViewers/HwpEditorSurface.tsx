import { useMemo, useRef } from "react";
import { HwpEditor } from "@hwp-editor/react";
import "@hwp-editor/react/style.css";
import type { DocumentHandle, HwpEngine } from "@hwp-editor/core";
import { useTranslation } from "../../lib/i18n";
import { createHwpedEngine } from "../../lib/hwped";

export interface HwpEditorSurfaceProps {
  file: DocumentHandle;
  workspacePath: string;
  locked: boolean;
  onReady: (document: DocumentHandle) => void;
  onChange: (document: DocumentHandle) => void;
  onDirtyChange: (dirty: boolean) => void;
  onActivityChange: (busy: boolean) => void;
  onError: (error: unknown) => void;
}

/** All handles, including the initial capture, cross the engine as bytes. */
export function HwpEditorSurface(props: HwpEditorSurfaceProps) {
  const { locale, t } = useTranslation();
  const translate = useRef(t);
  translate.current = t;
  const latest = useRef(props);
  latest.current = props;
  const engine = useMemo<HwpEngine>(() => {
    const base = createHwpedEngine({ workspaceRoot: props.workspacePath, pathOf: () => undefined });
    let active = 0;
    const track = async <T,>(operation: () => Promise<T>): Promise<T> => {
      if (latest.current.locked) throw new Error(translate.current("binaryViewer.hwpEditorBusy"));
      active += 1;
      latest.current.onActivityChange(true);
      try { return await operation(); }
      finally {
        active -= 1;
        latest.current.onActivityChange(active > 0);
      }
    };
    return {
      ...base,
      read: (document) => track(() => base.read(document)),
      render: (document, options) => track(() => base.render(document, options)),
      edit: (document, ops, options) => track(() => base.edit(document, ops, options)),
      validate: (document) => track(() => base.validate(document)),
      // A composed document has a different origin and no supported save
      // destination in this host. Refuse before the engine creates one.
      compose: async () => { throw new Error(translate.current("binaryViewer.hwpEditorComposeUnsupported")); },
      ...(base.create ? { create: async () => { throw new Error(translate.current("binaryViewer.hwpEditorComposeUnsupported")); } } : {}),
      ...(base.template ? { template: async () => { throw new Error(translate.current("binaryViewer.hwpEditorComposeUnsupported")); } } : {}),
      ...(base.fill ? { fill: (document, values) => track(() => base.fill!(document, values)) } : {}),
    };
  }, [props.workspacePath]);

  return (
    <fieldset disabled={props.locked} className="hwp-editor-surface-lock" style={{ border: 0, padding: 0, margin: 0, minWidth: 0, minHeight: 0, display: "flex", flex: 1 }}>
      <div inert={props.locked} style={{ minWidth: 0, minHeight: 0, display: "flex", flex: 1 }}>
        <HwpEditor engine={engine} file={props.file} locale={locale} readOnly={props.locked}
          onReady={props.onReady} onChange={props.onChange} onDirtyChange={props.onDirtyChange} onError={props.onError} />
      </div>
    </fieldset>
  );
}

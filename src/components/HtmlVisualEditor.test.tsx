// @vitest-environment jsdom

import { act, createRef, type ReactNode, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleContext, t as translate, type Locale } from "../lib/i18n";
import { HTML_VISUAL_MAX_BYTES, digestSource } from "../lib/htmlDocument";
import {
  HtmlPreviewFrame,
  HtmlVisualEditor,
  type HtmlEditorFlushHandle,
  type HtmlVisualEditorProps,
} from "./HtmlVisualEditor";

vi.mock("../lib/api", () => ({
  prepareHtmlEditorAssets: vi.fn(),
}));

import { prepareHtmlEditorAssets, type PrepareHtmlEditorAssetsResult } from "../lib/api";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom notes:
// - jsdom does NOT parse iframe `srcdoc`: the iframe's contentDocument stays an
//   empty about:blank document. That is fine here because serialization reads
//   the live body (which we mutate directly) and the byte-identity path never
//   touches the body at all.
// - jsdom documents have no execCommand/queryCommandSupported, so tests stub
//   them on the iframe document before dispatching the `load` event that
//   triggers the component's onLoad feature detection.
// - React attaches `onLoad` directly to the iframe element, so dispatching a
//   `load` event on it synchronously runs the component's load handler.

const FULL_DOC =
  "<!DOCTYPE html>\n" +
  '<html lang="en">\n' +
  "<head>\n" +
  "<title>Doc</title>\n" +
  "<style>body { color: red; }</style>\n" +
  "</head>\n" +
  '<body class="x">\n' +
  "<p>Hello</p>\n" +
  "</body>\n" +
  "</html>\n";

const EDITED_DOC = FULL_DOC.replace("\n<p>Hello</p>\n", "<p>edited</p>");

const RISKY_DOC = "<p>hi</p><script>alert(1)</script>";
const RISKY_DOC_2 = "<p>other</p><script>alert(2)</script>";
const MALFORMED_DOC = "<html><head><title>t</title></head></html>";

const roots: Root[] = [];

function localeValue(locale: Locale) {
  return {
    locale,
    setLocale: () => {},
    t: (key: string, vars?: Record<string, string | number>) => translate(locale, key, vars),
  };
}

function wrap(node: ReactNode) {
  return <LocaleContext.Provider value={localeValue("en")}>{node}</LocaleContext.Provider>;
}

interface RenderedEditor {
  container: HTMLElement;
  root: Root;
  ref: RefObject<HtmlEditorFlushHandle | null>;
  props: HtmlVisualEditorProps;
}

async function renderEditor(
  overrides: Partial<HtmlVisualEditorProps> = {},
): Promise<RenderedEditor> {
  const props: HtmlVisualEditorProps = {
    value: "<p>Hello</p>",
    onChange: vi.fn(),
    vaultPath: "/vault",
    documentPath: "doc.html",
    onRiskAck: vi.fn(),
    onRequestSourceMode: vi.fn(),
    ...overrides,
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const ref = createRef<HtmlEditorFlushHandle>();
  await act(async () => {
    root.render(wrap(<HtmlVisualEditor ref={ref} {...props} />));
  });
  // Flush the prepareHtmlEditorAssets promise chain (assets -> runtime doc).
  await act(async () => {
    await Promise.resolve();
  });
  return { container, root, ref, props };
}

async function rerenderEditor(
  rendered: RenderedEditor,
  overrides: Partial<HtmlVisualEditorProps>,
): Promise<void> {
  rendered.props = { ...rendered.props, ...overrides };
  await act(async () => {
    rendered.root.render(wrap(<HtmlVisualEditor ref={rendered.ref} {...rendered.props} />));
  });
  await act(async () => {
    await Promise.resolve();
  });
}

function getIframe(container: HTMLElement): HTMLIFrameElement {
  const iframe = container.querySelector<HTMLIFrameElement>(
    '[data-testid="html-editor-frame"]',
  );
  if (!iframe) throw new Error("html-editor-frame iframe not found");
  return iframe;
}

async function dispatchLoad(iframe: HTMLIFrameElement): Promise<void> {
  await act(async () => {
    iframe.dispatchEvent(new Event("load"));
  });
}

type EditableDocument = Document & {
  execCommand: (commandId: string, showUI?: boolean, value?: string) => boolean;
  queryCommandSupported: (commandId: string) => boolean;
};

/** Stub the editing APIs jsdom lacks BEFORE dispatching `load`, so the
 *  component's feature detection marks every command as supported. */
function stubEditingApis(doc: Document): EditableDocument {
  const editable = doc as EditableDocument;
  editable.execCommand = vi.fn().mockReturnValue(true);
  editable.queryCommandSupported = () => true;
  return editable;
}

function toolbarButton(container: HTMLElement, labelKey: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    `button[aria-label="${translate("en", labelKey)}"]`,
  );
  if (!button) throw new Error(`toolbar button not found: ${labelKey}`);
  return button;
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent === text,
  );
  if (!button) throw new Error(`button not found: ${text}`);
  return button;
}

beforeEach(() => {
  vi.mocked(prepareHtmlEditorAssets).mockResolvedValue({ documentDirectory: "" });
});

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => {
      root.unmount();
    });
  }
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("HtmlVisualEditor loading and fallback states", () => {
  it("shows the loading state while assets are being prepared", async () => {
    vi.mocked(prepareHtmlEditorAssets).mockReturnValue(
      new Promise<PrepareHtmlEditorAssetsResult>(() => {}),
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        wrap(
          <HtmlVisualEditor
            value="<p>Hello</p>"
            onChange={() => {}}
            vaultPath="/vault"
            documentPath="doc.html"
            onRiskAck={() => {}}
            onRequestSourceMode={() => {}}
          />,
        ),
      );
    });
    expect(container.querySelector('[data-testid="html-editor-loading"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="html-visual-editor"]')).toBeNull();
  });

  it("renders the malformed state for html/head without a body and escalates via Open in Source", async () => {
    const onRequestSourceMode = vi.fn();
    const { container } = await renderEditor({
      value: MALFORMED_DOC,
      onRequestSourceMode,
    });
    const state = container.querySelector('[data-testid="html-editor-malformed"]');
    expect(state).not.toBeNull();
    expect(container.querySelector('[data-testid="html-editor-frame"]')).toBeNull();
    await act(async () => {
      buttonByText(container, translate("en", "editor.html.openInSource")).click();
    });
    expect(onRequestSourceMode).toHaveBeenCalledTimes(1);
  });

  it("renders the over-limit state when the document exceeds HTML_VISUAL_MAX_BYTES", async () => {
    const onRequestSourceMode = vi.fn();
    const { container } = await renderEditor({
      value: "x".repeat(HTML_VISUAL_MAX_BYTES + 1),
      onRequestSourceMode,
    });
    expect(container.querySelector('[data-testid="html-editor-over-limit"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="html-editor-frame"]')).toBeNull();
    await act(async () => {
      buttonByText(container, translate("en", "editor.html.openInSource")).click();
    });
    expect(onRequestSourceMode).toHaveBeenCalledTimes(1);
  });

  it("shows the empty banner and still renders the editor frame for an empty document", async () => {
    const { container } = await renderEditor({ value: "" });
    expect(container.querySelector('[data-testid="html-editor-empty"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="html-editor-frame"]')).not.toBeNull();
  });

  it("warns about blocked remote assets", async () => {
    const { container } = await renderEditor({
      value: '<img src="https://evil.example/x.png"><p>hi</p>',
    });
    const warning = container.querySelector('[data-testid="html-editor-asset-warning"]');
    expect(warning).not.toBeNull();
    expect(warning?.textContent).toContain(
      translate("en", "editor.html.state.assetWarning", { count: 1 }),
    );
  });
});

describe("HtmlVisualEditor serialization", () => {
  it("flushNow returns the original value byte-identical when nothing was edited", async () => {
    const onChange = vi.fn();
    const { container, ref } = await renderEditor({ value: FULL_DOC, onChange });
    await dispatchLoad(getIframe(container));
    let returned: string | null | undefined;
    await act(async () => {
      returned = ref.current?.flushNow();
    });
    expect(returned).toBe(FULL_DOC);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(FULL_DOC);
  });

  it("flushNow emits the edited body with the original head/shell preserved", async () => {
    const onChange = vi.fn();
    const { container, ref } = await renderEditor({ value: FULL_DOC, onChange });
    const iframe = getIframe(container);
    await dispatchLoad(iframe);
    const doc = iframe.contentDocument;
    if (!doc?.body) throw new Error("iframe body unavailable");
    doc.body.innerHTML = "<p>edited</p>";
    await act(async () => {
      doc.body?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    let returned: string | null | undefined;
    await act(async () => {
      returned = ref.current?.flushNow();
    });
    expect(returned).toBe(EDITED_DOC);
    expect(onChange).toHaveBeenLastCalledWith(EDITED_DOC);
    // The full-document envelope keeps the doctype, head and body attributes.
    expect(returned).toContain("<!DOCTYPE html>");
    expect(returned).toContain("<style>body { color: red; }</style>");
    expect(returned).toContain('<body class="x">');
  });
});

describe("HtmlVisualEditor toolbar", () => {
  it("disables toolbar buttons when the iframe document does not support edit commands", async () => {
    const { container } = await renderEditor({ value: FULL_DOC });
    // jsdom documents lack queryCommandSupported, so detection marks every
    // command unsupported on load.
    await dispatchLoad(getIframe(container));
    expect(toolbarButton(container, "editor.html.toolbar.bold").disabled).toBe(true);
    expect(toolbarButton(container, "editor.html.toolbar.undo").disabled).toBe(true);
  });

  it("routes toolbar clicks through execCommand once commands are supported", async () => {
    const { container } = await renderEditor({ value: FULL_DOC });
    const iframe = getIframe(container);
    const doc = iframe.contentDocument;
    if (!doc) throw new Error("iframe document unavailable");
    const editable = stubEditingApis(doc);
    await dispatchLoad(iframe);
    expect(editable.queryCommandSupported("bold")).toBe(true);
    const bold = toolbarButton(container, "editor.html.toolbar.bold");
    expect(bold.disabled).toBe(false);
    await act(async () => {
      bold.click();
    });
    expect(editable.execCommand).toHaveBeenCalledWith("bold", false, undefined);
  });

  it("disables the toolbar and the editing surface when readOnly", async () => {
    const { container } = await renderEditor({
      value: FULL_DOC,
      readOnly: true,
      readOnlyReason: "Approval locked",
    });
    const iframe = getIframe(container);
    const doc = iframe.contentDocument;
    if (!doc) throw new Error("iframe document unavailable");
    stubEditingApis(doc);
    await dispatchLoad(iframe);
    expect(doc.body?.contentEditable).toBe("false");
    expect(toolbarButton(container, "editor.html.toolbar.bold").disabled).toBe(true);
    expect(toolbarButton(container, "editor.html.toolbar.undo").disabled).toBe(true);
    expect(container.textContent).toContain("Approval locked");
  });
});

describe("HtmlVisualEditor risk acknowledgement", () => {
  it("shows the risk overlay for script markup, acks with the source digest, and re-asks on external edits", async () => {
    const onRiskAck = vi.fn();
    const rendered = await renderEditor({ value: RISKY_DOC, onRiskAck });
    const { container } = rendered;
    await dispatchLoad(getIframe(container));
    expect(container.querySelector('[data-testid="html-editor-risk"]')).not.toBeNull();

    await act(async () => {
      buttonByText(container, translate("en", "editor.html.risk.confirm")).click();
    });
    expect(onRiskAck).toHaveBeenCalledTimes(1);
    const digest = onRiskAck.mock.calls[0][0] as string;
    expect(typeof digest).toBe("string");
    expect(digest).toBe(digestSource(RISKY_DOC));

    // Session ack hides the overlay on the next render with the same value.
    await rerenderEditor(rendered, {});
    expect(container.querySelector('[data-testid="html-editor-risk"]')).toBeNull();

    // A different value (external edit) resets the session ack and re-asks.
    await rerenderEditor(rendered, { value: RISKY_DOC_2 });
    expect(container.querySelector('[data-testid="html-editor-risk"]')).not.toBeNull();
  });

  it("cancel on the risk overlay requests source mode", async () => {
    const onRequestSourceMode = vi.fn();
    const { container } = await renderEditor({
      value: RISKY_DOC,
      onRequestSourceMode,
    });
    expect(container.querySelector('[data-testid="html-editor-risk"]')).not.toBeNull();
    await act(async () => {
      buttonByText(container, translate("en", "editor.html.risk.cancel")).click();
    });
    expect(onRequestSourceMode).toHaveBeenCalledTimes(1);
  });

  it("skips the overlay when riskAckDigest already matches the loaded value", async () => {
    const { container } = await renderEditor({
      value: RISKY_DOC,
      riskAckDigest: digestSource(RISKY_DOC),
    });
    expect(container.querySelector('[data-testid="html-editor-risk"]')).toBeNull();
  });
});

describe("HtmlPreviewFrame", () => {
  async function renderPreview(value: string): Promise<HTMLElement> {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        wrap(
          <HtmlPreviewFrame
            value={value}
            vaultPath="/vault"
            documentPath="doc.html"
            title="Preview"
          />,
        ),
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    return container;
  }

  it("shows the loading state while assets are not ready", async () => {
    vi.mocked(prepareHtmlEditorAssets).mockReturnValue(
      new Promise<PrepareHtmlEditorAssetsResult>(() => {}),
    );
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        wrap(
          <HtmlPreviewFrame
            value="<p>hi</p>"
            vaultPath="/vault"
            documentPath="doc.html"
            title="Preview"
          />,
        ),
      );
    });
    expect(container.querySelector('[data-testid="html-preview-loading"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="html-preview-frame"]')).toBeNull();
  });

  it("renders a srcdoc with scripts stripped and the runtime CSP meta injected", async () => {
    const container = await renderPreview("<p>safe</p><script>alert(1)</script>");
    const iframe = container.querySelector<HTMLIFrameElement>(
      '[data-testid="html-preview-frame"]',
    );
    expect(iframe).not.toBeNull();
    const srcdoc = iframe?.getAttribute("srcdoc") ?? "";
    expect(srcdoc).not.toContain("<script");
    expect(srcdoc).toContain("data-maru-runtime");
    expect(srcdoc).toContain("Content-Security-Policy");
    expect(srcdoc).toContain("<p>safe</p>");
  });
});

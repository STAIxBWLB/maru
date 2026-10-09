// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocaleContext, t as translate } from "../lib/i18n";
import "../lib/i18n/testing";
import { IpcError } from "../lib/ipcError";
import { unmountReactRoot } from "../lib/testing/unmountReactRoot";
import type { DocumentDeleteItem, DocumentDeletePlan } from "../lib/types";

const api = vi.hoisted(() => ({
  documentDeletePlan: vi.fn(),
  trashDocument: vi.fn(),
}));
vi.mock("../lib/api", () => api);

import { DocumentDeleteDialog, type DocumentDeleteRequest } from "./DocumentDeleteDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const REQUEST: DocumentDeleteRequest = { workspacePath: "/work", documentPath: "/work/notes/report.md" };

function item(relPath: string, kind: DocumentDeleteItem["kind"], evidence: string): DocumentDeleteItem {
  return { relPath, kind, sizeBytes: 1024, isDir: false, evidence };
}

function plan(fingerprint = "fp-1"): DocumentDeletePlan {
  return {
    source: item("notes/report.md", "source", "selected document"),
    derived: [
      item("notes/report.exports/manifest.yaml", "exportManifest", "manifest.yaml source"),
      item(".maru/versions/report-1.md", "version", "version_of"),
    ],
    metadata: [],
    kept: [item("notes/report.exports/handmade.txt", "exportUnlisted", "not listed in manifest.yaml")],
    fingerprint,
  };
}

interface Harness {
  container: HTMLDivElement;
  root: Root;
  onClose: ReturnType<typeof vi.fn>;
  onDeleted: ReturnType<typeof vi.fn>;
}

async function render(): Promise<Harness> {
  const onClose = vi.fn();
  const onDeleted = vi.fn();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <LocaleContext.Provider
        value={{ locale: "en", setLocale: () => {}, t: (key, vars) => translate("en", key, vars) }}
      >
        <DocumentDeleteDialog request={REQUEST} onClose={onClose} onDeleted={onDeleted} />
      </LocaleContext.Provider>,
    );
  });
  return { container, root, onClose, onDeleted };
}

const switches = () => [...document.body.querySelectorAll<HTMLInputElement>('[role="switch"]')];
const checkboxes = () => [
  ...document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]:not([role="switch"])'),
];
const text = () => document.body.textContent ?? "";
const button = (label: RegExp) =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => label.test(b.textContent ?? ""))!;

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}

describe("DocumentDeleteDialog", () => {
  let harness: Harness | null = null;

  beforeEach(() => {
    document.body.innerHTML = "";
    api.documentDeletePlan.mockReset().mockResolvedValue(plan());
    api.trashDocument.mockReset();
  });

  afterEach(async () => {
    if (harness) {
      await unmountReactRoot(harness.root);
      harness.container.remove();
      harness = null;
    }
  });

  it("lists only the source with both toggles off and disables an empty group", async () => {
    harness = await render();
    expect(api.documentDeletePlan).toHaveBeenCalledWith("/work", "/work/notes/report.md");
    expect(text()).toContain("notes/report.md");
    expect(text()).toContain("Also delete derived files (2)");
    expect(text()).not.toContain("manifest.yaml source");
    const [derived, metadata] = switches();
    expect(derived!.checked).toBe(false);
    expect(metadata!.disabled).toBe(true);
    expect(text()).toContain("None found.");
    expect(text()).toContain("handmade.txt");
    expect(button(/^Delete 1 file\(s\)$/)).toBeTruthy();
  });

  it("applies only the checked items of an enabled group", async () => {
    api.trashDocument.mockResolvedValue({
      sourceRelPath: "notes/report.md",
      items: [
        { relPath: "notes/report.md", kind: "source", status: "trashed", error: null },
        { relPath: ".maru/versions/report-1.md", kind: "version", status: "trashed", error: null },
      ],
    });
    harness = await render();
    await click(switches()[0]!);
    expect(text()).toContain("manifest.yaml source");
    const boxes = checkboxes();
    expect(boxes.map((box) => box.checked)).toEqual([true, true, true]);
    expect(boxes[0]!.disabled).toBe(true);
    await click(boxes[1]!);
    expect(text()).toContain("Delete 2 file(s) (2.0 KB)");
    await click(button(/^Delete 2 file\(s\)$/));
    expect(api.trashDocument).toHaveBeenCalledWith(
      "/work",
      "/work/notes/report.md",
      "fp-1",
      [".maru/versions/report-1.md"],
    );
    expect(harness.onDeleted).toHaveBeenCalledTimes(1);
    expect(harness.onClose).toHaveBeenCalledTimes(1);
  });

  it("re-plans on a stale plan, keeps unchecked items and deletes nothing", async () => {
    api.trashDocument.mockRejectedValue(
      new IpcError({ code: "document_delete_stale", message: "files changed" }),
    );
    harness = await render();
    api.documentDeletePlan.mockResolvedValue(plan("fp-2"));
    await click(switches()[0]!);
    await click(checkboxes()[1]!);
    await click(button(/^Delete 2 file\(s\)$/));
    expect(checkboxes().map((box) => box.checked)).toEqual([true, false, true]);
    expect(api.documentDeletePlan).toHaveBeenCalledTimes(2);
    expect(text()).toContain("Files changed since this list was made");
    expect(harness.onDeleted).not.toHaveBeenCalled();
    expect(harness.onClose).not.toHaveBeenCalled();
  });

  it("keeps the dialog open with per-item failures", async () => {
    api.trashDocument.mockResolvedValue({
      sourceRelPath: "notes/report.md",
      items: [
        { relPath: "notes/report.md", kind: "source", status: "trashed", error: null },
        { relPath: ".maru/versions/report-1.md", kind: "version", status: "failed", error: "busy" },
      ],
    });
    harness = await render();
    await click(switches()[0]!);
    await click(button(/^Delete 3 file\(s\)$/));
    expect(harness.onDeleted).toHaveBeenCalledTimes(1);
    expect(harness.onClose).not.toHaveBeenCalled();
    expect(text()).toContain("Items not moved to the Trash");
    expect(text()).toContain("Failed - busy");
  });

  it("shows a refused plan without a way to confirm", async () => {
    api.documentDeletePlan.mockRejectedValue(
      new IpcError({ code: "document_delete_refused", message: "managed vault" }),
    );
    harness = await render();
    expect(text()).toContain("document_delete_refused: managed vault");
    expect(button(/^Delete/)!.disabled).toBe(true);
  });
});

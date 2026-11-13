// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, surface } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  surface: {
    engine: null as null | {
      edit: (
        document: { name: string; data: Uint8Array },
        ops: unknown[],
      ) => Promise<{ name: string; data: Uint8Array }>;
    },
    file: null as null | { name: string; data: Uint8Array },
  },
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

vi.mock("@hwp-editor/react", () => ({
  HwpEditor: (props: {
    engine: typeof surface.engine;
    file: { name: string; data: Uint8Array };
  }) => {
    surface.engine = props.engine;
    surface.file = props.file;
    return <div data-testid="editor" />;
  },
}));

import { HwpEditorSurface } from "./HwpEditorSurface";
import { LocaleContext } from "../../lib/i18n";
import type { WorkspaceFileEntry } from "../../lib/types";

const entry: WorkspaceFileEntry = {
  path: "/workspace/report.hwpx",
  relPath: "report.hwpx",
  name: "report.hwpx",
  extension: "hwpx",
  fileKind: "hwpx",
  sizeBytes: 10,
  updatedAt: null,
  gitTracked: false,
  binary: true,
};

const ops = [{ kind: "replace" as const, find: "가", replace: "나" }];

function editRefs(): Array<Record<string, unknown>> {
  return invokeMock.mock.calls
    .filter(([command]) => command === "hwped_edit")
    .map(([, args]) => (args as { document: Record<string, unknown> }).document);
}

describe("HwpEditorSurface engine", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    surface.engine = null;
    surface.file = null;
    invokeMock.mockReset();
    invokeMock.mockImplementation((command: string) => {
      if (command === "hwped_capabilities") {
        return Promise.resolve({ version: "1.6.2", editable: true, formats: [], editOps: "v1" });
      }
      if (command === "hwped_edit") {
        // What src-tauri/src/hwped.rs answers: the same name and the edited
        // bytes, with nothing pointing back at the file on disk.
        return Promise.resolve({ name: "report.hwpx", dataBase64: "CQk=" });
      }
      throw new Error(`unexpected command ${command}`);
    });
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  it("crosses the handle it opened by path and each edited handle by its bytes", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <LocaleContext.Provider
          value={{ locale: "ko", setLocale: () => {}, t: (key: string) => key }}
        >
          <HwpEditorSurface entry={entry} workspacePath="/workspace" />
        </LocaleContext.Provider>,
      );
    });
    const engine = surface.engine;
    const file = surface.file;
    if (engine === null || file === null) throw new Error("the surface never mounted the editor");

    // The handle the reader opened holds no bytes of its own, so a rule that
    // looked at `data` would send an empty document; it answers by identity.
    const edited = await engine.edit(file, ops);
    expect(editRefs()[0]).toEqual({ name: "report.hwpx", path: "report.hwpx" });

    // Apply again with what the engine returned: the same name, the edited
    // bytes, and a different object. Sent back as a path, the host would read
    // the original file and the first edit would be thrown away.
    await engine.edit(edited, ops);
    expect(editRefs()[1]).toEqual({ name: "report.hwpx", dataBase64: "CQk=" });
  });
});

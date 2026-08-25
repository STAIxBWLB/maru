import type { OutlinePaneState } from "./outlinePaneStore";

/** The Outline component receives only the actions it can invoke. Additional
 * pane commands are added by their owning migration task, never as a broad
 * shell capability object. */
export interface OutlinePaneCommands {
  jumpToLine(line: number): Promise<void>;
}

export interface CreateOutlinePaneCommandsOptions {
  getState: () => OutlinePaneState;
  jumpToLine: (line: number, documentPath: string | null) => void | Promise<void>;
}

export function createOutlinePaneCommands(
  options: CreateOutlinePaneCommandsOptions,
): OutlinePaneCommands {
  return {
    async jumpToLine(line: number): Promise<void> {
      // Read inside the method so a stable port cannot retain a stale active
      // document when the user changes tabs before activating a heading.
      const slice = options.getState().document;
      const documentPath = "document" in slice
        ? slice.document?.path ?? null
        : (slice as unknown as { path?: string }).path ?? null;
      await options.jumpToLine(line, documentPath);
    },
  };
}

/** Reserved for the later Editor migration. Keeping the named export here
 * fixes the dedicated adapter seam before consumers arrive. */
export interface EditorPaneCommands {}

export function createEditorPaneCommands(): EditorPaneCommands {
  return {};
}

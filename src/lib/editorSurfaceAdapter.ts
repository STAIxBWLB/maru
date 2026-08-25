import type { OutlinePaneState } from "./outlinePaneStore";
import type { FileQueueItem, FileQueueSourceInfo } from "./types";

/** The Outline component receives only the actions it can invoke. Additional
 * pane commands are added by their owning migration task, never as a broad
 * shell capability object. */
export interface OutlinePaneCommands {
  jumpToLine(line: number): Promise<void>;
  queueExternalFiles(paths: string[]): Promise<void>;
  queueFileSources(sources: FileQueueSourceInfo[], targetDir: string): Promise<void>;
  updateFileQueueItem(
    id: string,
    patch: Partial<Pick<FileQueueItem, "targetDir" | "operation">>,
  ): Promise<void>;
  applyFileQueue(): Promise<unknown>;
}

export interface CreateOutlinePaneCommandsOptions {
  getState: () => OutlinePaneState;
  jumpToLine: (line: number, documentPath: string | null) => void | Promise<void>;
  queueExternalFiles?: (paths: string[]) => void | Promise<void>;
  queueFileSources?: (sources: FileQueueSourceInfo[], targetDir: string) => void | Promise<void>;
  updateFileQueueItem?: (
    id: string,
    patch: Partial<Pick<FileQueueItem, "targetDir" | "operation">>,
  ) => void | Promise<void>;
  applyFileQueue?: () => unknown | Promise<unknown>;
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
    async queueExternalFiles(paths: string[]): Promise<void> {
      void options.getState();
      await options.queueExternalFiles?.(paths);
    },
    async queueFileSources(sources: FileQueueSourceInfo[], targetDir: string): Promise<void> {
      void options.getState();
      await options.queueFileSources?.(sources, targetDir);
    },
    async updateFileQueueItem(
      id: string,
      patch: Partial<Pick<FileQueueItem, "targetDir" | "operation">>,
    ): Promise<void> {
      void options.getState();
      await options.updateFileQueueItem?.(id, patch);
    },
    async applyFileQueue(): Promise<unknown> {
      void options.getState();
      return await options.applyFileQueue?.();
    },
  };
}

/** Reserved for the later Editor migration. Keeping the named export here
 * fixes the dedicated adapter seam before consumers arrive. */
export interface EditorPaneCommands {}

export function createEditorPaneCommands(): EditorPaneCommands {
  return {};
}

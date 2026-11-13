// hwp-editor engine bridge: the published @hwp-editor/core Tauri factory over
// maru's hwped_* Rust commands (src-tauri/src/hwped.rs). The wire types live
// in that package now; nothing here mirrors them. See docs/hwp-editor.md.

import { invoke } from "@tauri-apps/api/core";
import {
  createTauriEngine,
  type DocumentHandle,
  type HwpEngine,
} from "@hwp-editor/core";

export interface HwpedEngineOptions {
  /** Maru's active workspace root; Rust resolves relative document paths
   *  against it on every call. */
  workspaceRoot: string;
  /**
   * Workspace-relative path for a document that already lives on disk. Rust
   * reads it directly when this answers, and receives base64 bytes when it
   * returns undefined, so a surface that only has bytes still works.
   */
  pathOf?: (document: DocumentHandle) => string | undefined;
}

/**
 * One engine per surface. `createTauriEngine` holds no state of its own, but
 * the caller owns the instance so a re-render does not rebuild it.
 *
 * The engine asks `hwped_capabilities` before an edit and sends the
 * `edit-ops-v1` JSON array when the host advertises `editOps: "v1"`, which
 * maru does; the `opsArgv` fallback for older hosts lives inside the package.
 */
export function createHwpedEngine(options: HwpedEngineOptions): HwpEngine {
  return createTauriEngine(invoke, {
    workspaceRoot: options.workspaceRoot,
    ...(options.pathOf === undefined ? {} : { pathOf: options.pathOf }),
  });
}

/**
 * Repository scan (issue #553, E5 T3): ask the native plugin to propose a
 * `floorplan/architecture@1` map for a folder inside the open workspace, then
 * turn the proposal into an unsaved document through the existing Floorplan
 * codec. The scan writes nothing; the user saves the document like any other.
 */
import { parseFloorplanSpec } from "./floorplanCodec";
import { projectSemanticDocument } from "./semantic";
import type { DiagramDoc } from "./types";
import type { ValidationDiagnostic } from "./validation";

export interface RepoScanStats {
  inventory: "gitIndex" | "filesystem";
  files: number;
  sourceFiles: number;
  fileImports: number;
  skippedLarge: number;
  nodes: number;
  edges: number;
}

export interface RepoScanReport {
  document: Record<string, unknown>;
  /** The scanned folder, relative to the workspace root ("" for the root). */
  relativePath: string;
  stats: RepoScanStats;
}

export type RepoScanProposal =
  | { ok: true; doc: DiagramDoc; report: RepoScanReport; diagnostics: ValidationDiagnostic[] }
  | { ok: false; report: RepoScanReport; diagnostics: ValidationDiagnostic[] };

export function repoScanAvailable(): boolean {
  return typeof window !== "undefined" && Boolean(window.__TAURI_INTERNALS__);
}

function isReport(value: unknown): value is RepoScanReport {
  if (typeof value !== "object" || value === null) return false;
  const report = value as Partial<RepoScanReport>;
  return typeof report.document === "object" && report.document !== null
    && typeof report.relativePath === "string"
    && typeof report.stats === "object" && report.stats !== null;
}

/** Scan `path` (absolute, or relative to `workspace`) inside `workspace`. */
export async function scanRepository(workspace: string, path: string): Promise<RepoScanReport> {
  if (!repoScanAvailable()) throw new Error("Repository scans require the desktop app; open this workspace in Maru.");
  const { invoke } = await import("@tauri-apps/api/core");
  const report = await invoke<unknown>("plugin:maru-diagram|scan_repository", { workspace, path });
  if (!isReport(report)) throw new Error("The repository scan returned an unrecognized response; update Maru and scan again.");
  return report;
}

/**
 * Turn a scan report into an unsaved document. The proposal goes through the
 * same parse and content checks as an imported Floorplan file, so a map the
 * editor would refuse is never opened.
 */
export function proposalFromReport(report: RepoScanReport, capturedAt = Date.now()): RepoScanProposal {
  const outcome = parseFloorplanSpec(JSON.stringify(report.document), {
    provenance: { origin: "generated", sourcePath: report.relativePath || ".", capturedAt },
  });
  if (!outcome.ok) return { ok: false, report, diagnostics: outcome.diagnostics };
  const projected = projectSemanticDocument(outcome.dataset);
  return {
    ok: true,
    doc: projected.doc,
    report,
    diagnostics: [...outcome.diagnostics, ...projected.diagnostics],
  };
}

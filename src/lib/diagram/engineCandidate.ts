import { verifyEngineArtifactReport } from "./engineArtifact";
import type { EngineRenderContext, EngineRenderedCandidate, EngineRenderOptions } from "./engine";

interface RenderAndStoreEnvelope {
  report: unknown;
  storeWarning?: unknown;
}

export type EngineRenderInvoke = (command: string, args: Record<string, unknown>) => Promise<unknown>;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function nativeInvoke(): Promise<EngineRenderInvoke> {
  const { invoke } = await import("@tauri-apps/api/core");
  return (command, args) => invoke(command, args);
}

/** Render a source spec natively and ask the host to retain it when context is present. */
export async function renderEngineCandidate(
  workspace: string,
  diagramType: string,
  candidateJson: string,
  context?: EngineRenderContext,
  options: EngineRenderOptions = {},
  invokeHost?: EngineRenderInvoke,
): Promise<EngineRenderedCandidate> {
  if (!workspace.trim()) throw new Error("Engine artifact rendering requires an open workspace; open one and retry.");
  if (!candidateJson.trim()) throw new Error("The semantic source spec is missing; select a valid dataset and retry.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidateJson) as unknown;
  } catch {
    throw new Error("The semantic source spec is not valid JSON; repair the dataset and retry.");
  }
  if (!record(parsed) || parsed.diagram_type !== diagramType) {
    throw new Error("The semantic source type does not match the selected dataset; refresh the dataset and retry.");
  }
  if (context && context.diagramType !== diagramType) {
    throw new Error("The render-store context type does not match the semantic source; refresh the dataset and retry.");
  }
  const format = options.format ?? "svg";
  const theme = options.theme ?? "light";
  const pixelRatio = options.pixelRatio ?? 1;
  if (format !== "svg" && format !== "png") throw new Error("Engine render format must be SVG or PNG.");
  if (theme !== "light" && theme !== "dark") throw new Error("Engine render theme must be light or dark.");
  if (!Number.isInteger(pixelRatio) || pixelRatio < 1 || pixelRatio > 4 || format === "svg" && pixelRatio !== 1) {
    throw new Error("SVG requires pixelRatio 1 and PNG requires an integer pixelRatio from 1 to 4.");
  }

  const invoke = invokeHost ?? await nativeInvoke();
  const raw = await invoke("plugin:maru-diagram|render_and_store", {
    workspace,
    input: JSON.stringify({
      specJson: candidateJson,
      theme,
      format,
      pixelRatio,
      ...(format === "svg" ? { textMode: "outlines" } : {}),
    }),
    ...(context ? { context } : {}),
  });
  if (!record(raw) || !("report" in raw)
      || raw.storeWarning !== undefined && raw.storeWarning !== null && typeof raw.storeWarning !== "string") {
    throw new Error("The native engine returned an incompatible render-and-store result; update Maru and retry.");
  }
  const envelope = raw as unknown as RenderAndStoreEnvelope;
  const verified = await verifyEngineArtifactReport({
    specJson: candidateJson,
    theme,
    format,
    pixelRatio,
    purpose: "export",
  }, envelope.report);
  if (!verified.ok || !verified.bytes) {
    const first = verified.diagnostics[0];
    throw new Error(first
      ? `${first.message} ${first.fix} (engine diagnostic ${first.code} at ${first.path}).`
      : `The engine refused ${format.toUpperCase()} rendering without an actionable diagnostic; repair the source and retry.`);
  }
  return {
    ...verified,
    ...(typeof envelope.storeWarning === "string" && envelope.storeWarning.length > 0
      ? { storeWarning: envelope.storeWarning }
      : {}),
  };
}

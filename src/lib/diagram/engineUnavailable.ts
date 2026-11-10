/** Failure to load a product diagram-engine runtime or its WASM assets. */
export class EngineUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "EngineUnavailableError";
  }
}

/** Only loader failures wrapped by the product engine count as unavailable. */
export function isEngineUnavailable(error: unknown): error is EngineUnavailableError {
  return error instanceof EngineUnavailableError;
}

export function productEngineLoadError(kind: "validation" | "geometry", cause: unknown): EngineUnavailableError {
  const feature = kind === "validation" ? "validation" : "geometry";
  return new EngineUnavailableError(
    `The diagram ${feature} engine is unavailable. Reload Maru; if the problem continues, update or reinstall the app and retry.`,
    cause,
  );
}

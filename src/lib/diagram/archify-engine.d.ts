declare module "*sidecars/archify/renderers/shared/generated-validators.mjs" {
  interface SchemaValidator {
    (data: unknown): boolean;
    errors: { instancePath: string; message?: string }[] | null;
  }
  export const architecture: SchemaValidator;
  export const workflow: SchemaValidator;
  export const sequence: SchemaValidator;
  export const dataflow: SchemaValidator;
  export const lifecycle: SchemaValidator;
}
declare module "*sidecars/archify/renderers/shared/portable-path.mjs" {
  export function validatePortablePath(value: string, options: { profile: "output" }): unknown;
}

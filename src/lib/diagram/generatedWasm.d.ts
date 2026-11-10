/** Build-time fallback until the ignored wasm-bindgen declarations are generated. */
declare module "*maru_diagram_engine.js" {
  export default function initialize(options?: { module_or_path: string | URL | Uint8Array }): Promise<unknown>;
  export function validate_diagram_json(input: string): string;
  export function layout_json(input: string): string;
  export function measure_text_json(text: string, weight: number, size: number): string;
  export function render_artifact(input: string): string;
}

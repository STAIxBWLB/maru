// Frontend files that use the isolated E0/E3 geometry and artifact surfaces.
// Keep this explicit list shared by CI cost selection and the E0 build selector.
import { ENGINE_E3_ARTIFACT_PATHS } from "./ci-policy.mjs";
export { ENGINE_E3_ARTIFACT_PATHS };

const E0_BASE_PATH = /^(src-tauri\/crates\/|src-tauri\/src\/diagram_engine_e0\.rs|src\/lib\/nativeE2eBridge\.ts|rust-toolchain\.toml|scripts\/(?:check-diagram-engine|diagram-engine-e[023]|diagram-engine-payload)|src\/lib\/diagram\/engine(?:Geometry[^/]*|SvgForTest)?\.ts|e2e\/engine-e0|e2e-native\/specs\/diagram-engine-e0|\.github\/workflows\/ci\.yml)/;

export function isE0SelectedPath(name) {
  return typeof name === "string"
    && (ENGINE_E3_ARTIFACT_PATHS.includes(name) || E0_BASE_PATH.test(name));
}

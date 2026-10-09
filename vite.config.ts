import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Keep the pinned source bytes intact. The portable-path module has one
// Node-only UTF-8 byte count; both browser consumers use this scoped adapter.
function archifyPortablePathBrowserAdapter(): Plugin {
  const portablePath = fileURLToPath(new URL(
    "./sidecars/archify/renderers/shared/portable-path.mjs", import.meta.url,
  )).replaceAll("\\", "/");
  const byteLengthCall = "Buffer.byteLength(segment, 'utf8')";
  return {
    name: "maru-archify-portable-path-browser",
    enforce: "pre",
    transform(code, id) {
      if (id.split("?")[0].replaceAll("\\", "/") !== portablePath) return null;
      const parts = code.split(byteLengthCall);
      if (parts.length !== 2 || /\bBuffer\b/.test(parts.join(""))) {
        this.error("Pinned Archify portable-path Buffer usage changed; review the browser adapter.");
      }
      return { code: parts.join("new TextEncoder().encode(segment).byteLength"), map: null };
    },
  };
}

export default defineConfig({
  plugins: [archifyPortablePathBrowserAdapter(), react()],
  clearScreen: false,
  server: {
    port: 5307,
    strictPort: true,
    host: "127.0.0.1",
    // Cargo locks executing build scripts on Windows. Watching those generated
    // binaries raises EBUSY and terminates Vite during native dev or E2E.
    watch: {
      ignored: ["**/src-tauri/target/**", "**/.context/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
});

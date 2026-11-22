import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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

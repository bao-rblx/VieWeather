import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  server: {
    watch: {
      // The editor/agent writes files atomically via temporary directories;
      // watching those makes chokidar throw EBUSY and kills the dev server.
      ignored: ["**/.*.tmpdir/**", "**/.*.tmp", "**/node_modules/**"],
    },
    proxy: {
      "/api": "http://127.0.0.1:8010",
      "/docs": "http://127.0.0.1:8010",
      "/openapi.json": "http://127.0.0.1:8010",
    },
  },
  build: {
    rollupOptions: { output: { manualChunks: { maplibre: ["maplibre-gl"] } } },
  },
});
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Prebuilt bundle served by `ripple explore` from dist/explorer.
// Dev: `npx vite --config vite.explorer.config.ts` proxies /api to a
// running explorer server.
export default defineConfig({
  root: "explorer",
  plugins: [react()],
  build: {
    outDir: "../dist/explorer",
    emptyOutDir: true,
  },
  server: {
    proxy: { "/api": "http://127.0.0.1:4173" },
  },
});

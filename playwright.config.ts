import { defineConfig } from "@playwright/test";

const PORT = 43173;
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: BASE_URL,
    viewport: { width: 1440, height: 900 },
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 900 } } },
    { name: "laptop", use: { viewport: { width: 1280, height: 800 } } },
  ],
  webServer: {
    command:
      "npx vite build --config vite.explorer.config.ts && npx tsx scripts/e2e-server.ts",
    url: `${BASE_URL}/api/analysis`,
    timeout: 180_000,
    reuseExistingServer: false,
    env: { RIPPLE_E2E_PORT: String(PORT) },
  },
});

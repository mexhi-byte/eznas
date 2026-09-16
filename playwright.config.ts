import { defineConfig } from "@playwright/test";

/**
 * One browser, the built console, and the mock NAS.
 *
 * Both servers are started here so `npm run e2e` is the whole command. The
 * data directory is wiped first, because the smoke test begins where a new
 * install begins: no account signed in, no server configured, the setup
 * wizard waiting.
 */
const CONSOLE = 18322;
const MOCK = 18443;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${CONSOLE}`,
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: `MOCK_PORT=${MOCK} node --experimental-strip-types mock/truenas-mock.ts`,
      url: `http://127.0.0.1:${MOCK}/`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command:
        `rm -rf .e2e-data && DATA_DIR=.e2e-data PORT=${CONSOLE} UI_USERNAME=admin UI_PASSWORD=e2e-password-1 ` +
        `SESSION_SECRET=e2e-secret-e2e-secret-e2e-secret node dist/server/index.js`,
      url: `http://127.0.0.1:${CONSOLE}/api/session`,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});

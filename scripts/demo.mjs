#!/usr/bin/env node
// Run the console against the mock NAS, already connected, for a demo.
//
//   npm run demo          → http://127.0.0.1:8080, sign in as demo / demo-demo-demo
//
// The connection is adopted from the environment on first start, so the
// wizard is skipped and Home has numbers on it straight away. Data goes to a
// throwaway directory; nothing here is real.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MOCK = process.env.MOCK_PORT ?? "18443";
const PORT = process.env.PORT ?? "8080";
const data = mkdtempSync(join(tmpdir(), "eznas-demo-"));

const mock = spawn("node", ["--experimental-strip-types", "mock/truenas-mock.ts"], {
  stdio: "inherit",
  env: { ...process.env, MOCK_PORT: MOCK },
});
const console_ = spawn("node", ["dist/server/index.js"], {
  stdio: "inherit",
  env: {
    ...process.env,
    PORT,
    DATA_DIR: data,
    UI_USERNAME: "demo",
    UI_PASSWORD: "demo-demo-demo",
    SESSION_SECRET: "demo-secret-demo-secret-demo-secret",
    TRUENAS_URL: `ws://127.0.0.1:${MOCK}/api/current`,
    TRUENAS_API_KEY: "1-mock",
    TRUENAS_NAME: "demo-nas",
    RELEASE_CHANNEL: "demo",
  },
});
const stop = () => {
  mock.kill();
  console_.kill();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
console.log(`\n  EzNAS demo → http://127.0.0.1:${PORT}   sign in: demo / demo-demo-demo\n`);
